import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { planCustomerLeadOnlyTurn, runCustomerLeadOnlyIntake, sealCustomerLeadOnlyIntake, type CustomerLeadOnlyTurnInput } from "../src/lib/customerLeadOnlyCore.js";
import { alarmLeadOnlyIntake, leadOnlyAlarmTag } from "../src/lib/leadOnlyHandover.js";
import { leadOnlyModeNotifications, leadOnlyNotificationsSince } from "./helpers/leadOnlyQuiet.js";
import { loadCustomerAgentFeaturePolicy } from "../src/lib/customerAgentFeaturePolicy.js";
import { loadBotCapabilities } from "../src/messengers/botCapabilities.js";
import { LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — ПРАВКИ ПО РЕВЬЮ 13.11.2026 (решения ядра и задание заявки на настоящей базе).
 * Каждый тест здесь падает на коде до правки: номер находки ревью — в имени теста.
 * С вечера 13.11 (решение владельца): до номера — ни одного уведомления; проверка — лента уведомлений пуста.
 */
const runId = Date.now().toString(36);
const config = { ...LEAD_ONLY_DEFAULTS, enabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" };
const conversations: string[] = [], clients: string[] = [], agents: string[] = [];
let settingsBefore: { botLeadOnlyMode: boolean; botCanSendLinks: boolean; botCanSendPhotos: boolean } | null = null;
let ownerId: string, propertyId: string;
const waPeer = () => `99293${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

function input(over: Partial<CustomerLeadOnlyTurnInput>): CustomerLeadOnlyTurnInput {
  return { config, channel: "INSTAGRAM", peer: `review-${runId}-${randomUUID()}`, conversationId: randomUUID(), eventKey: "a".repeat(64),
    language: "ru", inputText: "", focusPropertyId: null, focusFromThisMessage: false, turns: [], sentTexts: [], jobTopic: false, ...over };
}
async function conversation(channel: "INSTAGRAM" | "WHATSAPP", subscriberId: string, clientId?: string) {
  const row = await prisma.botConversation.create({ data: { channel, subscriberId, messages: [], ...(clientId ? { clientId } : {}) } });
  conversations.push(row.id); return row.id;
}
async function client(assignedAgentId: string | null = ownerId) {
  const row = await prisma.client.create({ data: { fullName: `Клиент ревью ${runId}`, phone: `+99291${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    source: "INSTAGRAM", ...(assignedAgentId ? { assignedAgentId } : {}) } });
  clients.push(row.id); return row.id;
}

beforeAll(async () => {
  settingsBefore = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botLeadOnlyMode: true, botCanSendLinks: true, botCanSendPhotos: true } });
  ownerId = (await prisma.agent.create({ data: { fullName: `Агент ревью ${runId}`, phone: `+992906${String(Date.now()).slice(-6)}`, role: "AGENT", passwordHash: "x" } })).id;
  agents.push(ownerId);
  propertyId = (await prisma.property.create({ data: { title: `Объект ревью ${runId}`, type: "APARTMENT", status: "AVAILABLE", publishedOnSite: true,
    price: 400000, currency: "TJS", rooms: 2, areaSqm: 55, condition: "GOOD", assignedAgentId: ownerId } })).id;
});
beforeEach(async () => { await drainBackgroundTasks(3000); });
afterAll(async () => {
  await drainBackgroundTasks(3000);
  const linked = await prisma.botConversation.findMany({ where: { id: { in: conversations } }, select: { clientId: true } });
  clients.push(...linked.flatMap(row => (row.clientId ? [row.clientId] : [])));
  await prisma.notification.deleteMany({ where: { OR: [...conversations.map(id => ({ tag: { startsWith: leadOnlyAlarmTag(id) } })), { agentId: { in: agents } }] } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversations } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
});

describe("ядро: решения хода", () => {
  it("№1: просьбы номера считаются по отправленному — после двух просьб номер офиса", async () => {
    const sentTexts = ["Понял вас. Оставьте, пожалуйста, номер телефона, агент перезвонит.", "Понял вас. Если удобно, напишите номер, и агент позвонит сам."];
    const plan = await planCustomerLeadOnlyTurn(input({ inputText: "Ищу квартиру", sentTexts }));
    expect(plan?.text).toContain("777 070 100");
  });

  it("№2: объект, оставшийся в фокусе, не отвечает на «где офис?» и «спасибо»", async () => {
    for (const inputText of ["Где ваш офис?", "Спасибо"]) {
      expect(await planCustomerLeadOnlyTurn(input({ inputText, focusPropertyId: propertyId, focusFromThisMessage: false }))).toBeNull();
    }
    const fresh = await planCustomerLeadOnlyTurn(input({ inputText: "Салом", focusPropertyId: propertyId, focusFromThisMessage: true }));
    expect(fresh?.scenario).toBe("property");
  });

  it("№4: вакансия никогда не становится заявкой покупателя, даже если модель «передала сотруднику»", async () => {
    expect(await planCustomerLeadOnlyTurn(input({ inputText: "Хочу работать у вас агентом", forced: "escalate" }))).toBeNull();
    expect(await planCustomerLeadOnlyTurn(input({ inputText: "Хотим посмотреть", jobTopic: true, forced: "escalate" }))).toBeNull();
  });

  it("№5: «другой город» — без обещания звонка, честная фраза приёма", async () => {
    const plan = await planCustomerLeadOnlyTurn(input({ channel: "WHATSAPP", peer: waPeer(), inputText: "Хочу купить квартиру в Худжанде" }));
    expect(plan?.text).toMatch(/Душанбе/);
    expect(plan?.text).not.toMatch(/позвонит/);
  });

  it("№6: карточка есть, номера в этом ходе нет — без «номер получил»; срочного пуша от режима нет (обычное уведомление о сообщении)", async () => {
    const clientId = await client();
    const id = await conversation("INSTAGRAM", `review-card-${runId}`, clientId);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Хотим посмотреть, куда ехать?" }));
    expect(plan?.text).not.toMatch(/номер получил/i);
    expect(plan?.intake).toBeNull();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).agentAttentionRequestedAt).toBeNull();
  });

  it("№13a: WhatsApp с карточкой «нет, звоните на 900…» — номер принят и уходит агенту", async () => {
    const peer = waPeer();
    const id = await conversation("WHATSAPP", peer, await client());
    const plan = await planCustomerLeadOnlyTurn(input({ channel: "WHATSAPP", peer, conversationId: id, inputText: "Нет, звоните на 900 12 34 56",
      turns: [{ role: "assistant", text: "Агент позвонит вам на этот номер, удобно?" }] }));
    expect(plan?.text).toContain("номер получил");
    expect(plan?.intake).not.toBeNull();
  });

  it("№8: в задании нет номера и слов клиента открытым текстом", async () => {
    const plan = await planCustomerLeadOnlyTurn(input({ inputText: "Хочу продать дом, мой номер 918 22 33 44" }));
    const raw = JSON.stringify(plan?.intake);
    expect(plan?.intake).not.toBeNull();
    expect(raw).not.toMatch(/918223344|918 22 33 44|продать|дом/);
    expect(Object.keys(plan!.intake!).sort()).toEqual(["conversationId", "eventKey", "propertyId", "scenario", "sealed", "version"]);
  });
});

describe("до номера — ни одного уведомления; сбой заявки с номером — тревога", () => {
  it("Instagram без номера, горячие слова после двух просьб — номер офиса, без «передаю»/«ответит здесь», ни задания, ни уведомлений", async () => {
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review-hot-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Хотим посмотреть, куда ехать?", focusPropertyId: propertyId,
      sentTexts: ["Понял вас. Оставьте, пожалуйста, номер телефона, агент перезвонит.", "Если удобно, напишите номер, и агент позвонит сам."] }));
    expect(plan?.scenario).toBe("hot");
    expect(plan?.text).toContain("777 070 100");
    expect(plan?.text).not.toMatch(/передаю|ответит вам здесь|в курсе/iu);
    expect(plan?.intake).toBeNull();
    expect(await leadOnlyNotificationsSince(id, since, [ownerId])).toBe(0);
  });

  it("горячие слова без номера — сразу просьба номера (первый ход), ни задания, ни уведомлений", async () => {
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review-hot-first-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Хотим посмотреть", focusPropertyId: propertyId, focusFromThisMessage: true }));
    expect(plan?.text).toMatch(/^Хорошо, покажем объект №\d+\. Оставьте, пожалуйста, номер телефона, агент перезвонит\.$/u);
    expect(plan?.intake).toBeNull();
    expect(plan?.remember).toMatchObject({ scenario: "hot", propertyId });
    expect(await leadOnlyNotificationsSince(id, since, [ownerId])).toBe(0);
  });

  it("WhatsApp: горячие слова — заявка сразу (номер отправителя), ответ «передаю агенту»", async () => {
    const peer = waPeer(), id = await conversation("WHATSAPP", peer);
    const plan = await planCustomerLeadOnlyTurn(input({ channel: "WHATSAPP", peer, conversationId: id, inputText: "Хотим посмотреть, куда ехать?",
      focusPropertyId: propertyId, focusFromThisMessage: true }));
    expect(plan?.scenario).toBe("hot");
    expect(plan?.text).toMatch(/передаю агенту/iu);
    expect(plan?.intake).toMatchObject({ scenario: "hot", propertyId });
  });

  it("тревога о сбое заявки: агенту объекта; без объекта и хозяина — руководителям", async () => {
    const id = await conversation("INSTAGRAM", `review-alarm-${runId}`);
    expect(await alarmLeadOnlyIntake({ conversationId: id, propertyId, reason: "intake_failed" })).toMatchObject({ status: "notified", to: "property" });
    const orphan = await conversation("INSTAGRAM", `review-orphan-${runId}`);
    expect(await alarmLeadOnlyIntake({ conversationId: orphan, propertyId: null, reason: "no_agent" })).toMatchObject({ status: "notified", to: "supervisors" });
    const own = await leadOnlyModeNotifications(id);
    expect(own.map(n => n.agentId)).toEqual([ownerId]);
    expect(own[0]?.url).toBe(`/messages?open=${id}`);
  });

  it("№7: приём отказал (аренда) — не тихий пропуск, а тревога", async () => {
    const id = await conversation("INSTAGRAM", `review-declined-${runId}`);
    const intake = sealCustomerLeadOnlyIntake({ eventKey: "b".repeat(64), conversationId: id, scenario: "buyer", propertyId: null },
      { phone: "+992918223399", whatsappPhone: null, clientText: "Сдаёте квартиру в аренду? 918 22 33 99", promised: "call", lead: true });
    expect(await runCustomerLeadOnlyIntake(intake, { force: true })).toMatchObject({ status: "skipped", reason: "declined" });
    expect((await leadOnlyModeNotifications(id)).length).toBeGreaterThan(0);
  });

  it("задание без номера (поставлено прежней версией) — пропуск без уведомлений", async () => {
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review-oldjob-${runId}`);
    const intake = sealCustomerLeadOnlyIntake({ eventKey: "c".repeat(64), conversationId: id, scenario: "property", propertyId },
      { phone: null, whatsappPhone: null, clientText: "интересует", promised: "chat", lead: false });
    expect(await runCustomerLeadOnlyIntake(intake, { force: true })).toEqual({ status: "skipped", reason: "no_phone" });
    expect(await leadOnlyNotificationsSince(id, since, [ownerId])).toBe(0);
  });
});

describe("№11: режим только для WhatsApp, Instagram и Facebook", () => {
  it("сайт сохраняет ссылки и фото, Instagram — нет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: true, botCanSendLinks: true, botCanSendPhotos: true } });
    expect(await loadCustomerAgentFeaturePolicy("WEBSITE")).toMatchObject({ leadOnly: false, links: true, photos: true });
    expect(await loadCustomerAgentFeaturePolicy("INSTAGRAM")).toMatchObject({ leadOnly: true, links: false, photos: false });
    expect(await loadBotCapabilities("WEBSITE")).toMatchObject({ leadOnly: false, links: true });
    expect(await loadBotCapabilities("WHATSAPP")).toMatchObject({ leadOnly: true, links: false });
  });
});

// ── Второе и третье ревью 13.11.2026, переписаны под решение владельца (вечер 13.11): до номера никого не зовём ──
describe("клиент без номера и клиент с карточкой: режим не шлёт уведомлений", () => {
  const cardNotes = (clientId: string) => prisma.interaction.findMany({ where: { clientId, type: "SYSTEM" }, select: { notes: true } });

  it("№2: объект без номера — фраза об объекте и просьба номера; ни задания, ни уведомления хозяину объекта", async () => {
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review2-prop-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Салом", focusPropertyId: propertyId, focusFromThisMessage: true }));
    expect(plan?.text).toMatch(/№\d+/);
    expect(plan?.text).toContain("Оставьте, пожалуйста, номер");
    expect(plan?.intake).toBeNull();
    expect(plan?.remember).toMatchObject({ scenario: "property", propertyId });
    expect(await leadOnlyNotificationsSince(id, since, [ownerId])).toBe(0);
  });

  it("№5 третьего ревью: четыре горячих сообщения подряд без номера — ни одного уведомления", async () => {
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review3-hot-${runId}`);
    const sent: string[] = [];
    for (const inputText of ["какой адрес? хотим приехать", "куда ехать?", "хотим посмотреть сегодня", "можно приехать сейчас?"]) {
      const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText, focusPropertyId: propertyId, sentTexts: [...sent] }));
      expect(plan?.intake ?? null).toBeNull();
      if (plan) sent.push(plan.text);
    }
    expect(new Set(sent).size).toBe(sent.length);
    expect(await leadOnlyNotificationsSince(id, since, [ownerId])).toBe(0);
  });

  it("владение: у клиента свой агент, разговор об объекте другого — хозяину объекта ни заметки, ни пуша", async () => {
    const own = (await prisma.agent.create({ data: { fullName: `Свой агент ${runId}`, phone: `+992904${String(Date.now()).slice(-6)}`, role: "AGENT",
      passwordHash: "x" } })).id;
    agents.push(own);
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review2-owner-${runId}`, await client(own));
    for (const inputText of ["Интересует эта квартира", "Хотим посмотреть"]) {
      const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText, focusPropertyId: propertyId, focusFromThisMessage: true }));
      expect(plan?.intake ?? null).toBeNull();
    }
    expect(await leadOnlyNotificationsSince(id, since, [ownerId, own])).toBe(0);
  });

  it("№9: тот же номер, что уже в карточке, — ничего; новый номер — пометка в карточке, без пуша", async () => {
    const clientId = await client();
    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review2-samephone-${runId}`, clientId);
    const run = (phone: string, key: string) => runCustomerLeadOnlyIntake(sealCustomerLeadOnlyIntake({ eventKey: key.repeat(64), conversationId: id,
      scenario: "escalate", propertyId: null }, { phone, whatsappPhone: null, clientText: `звоните на ${phone}`, promised: "call", lead: false }), { force: true });
    expect(await run(card.phone, "1")).toEqual({ status: "skipped", reason: "card_exists" });
    expect((await cardNotes(clientId)).length).toBe(0);
    expect(await run("+992900112233", "3")).toEqual({ status: "noted" });
    expect((await cardNotes(clientId)).some(n => n.notes?.includes("Клиент просит звонить на +992900112233"))).toBe(true);
    expect(await leadOnlyNotificationsSince(id, since, [ownerId])).toBe(0);
  });

  it("№1: номер одним сообщением после просьбы — сценарий и объект из памяти просьбы, а не «вопрос к агенту»", async () => {
    const id = await conversation("INSTAGRAM", `review2-pending-${runId}`);
    await prisma.botConversation.update({ where: { id }, data: { leadOnlyPending: { version: 1, scenario: "property", propertyId,
      askedAt: new Date().toISOString() } } });
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "918 77 66 41",
      sentTexts: ["Это объект №1, цена 400 000 сомони. Оставьте, пожалуйста, номер телефона, агент перезвонит."] }));
    expect(plan?.scenario).toBe("property");
    expect(plan?.intake).toMatchObject({ scenario: "property", propertyId });
  });
});

describe("третье ревью: ядро и память просьбы", () => {
  const pendingOf = (id: string) => prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { leadOnlyPending: true } }).then(r => r.leadOnlyPending);
  const remembered = (id: string) => prisma.botConversation.update({ where: { id }, data: { leadOnlyPending: { version: 1, scenario: "property", propertyId,
    askedAt: new Date().toISOString() } } });
  const asked = ["Это объект №1, цена 400 000 сомони. Оставьте, пожалуйста, номер телефона, агент перезвонит."];
  it("№1: память о посте не перебивает «хочу продать свою квартиру, 93…» этого сообщения", async () => {
    const id = await conversation("INSTAGRAM", `review3-sell-${runId}`);
    await remembered(id);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Хочу продать свою квартиру, 918 77 66 42", sentTexts: asked }));
    expect(plan?.scenario).toBe("seller");
    expect(plan?.intake).toMatchObject({ scenario: "seller", propertyId: null });
  });

  it("№2: у диалога с карточкой память не читается; смена темы стирает или заменяет память", async () => {
    const linkedId = await conversation("INSTAGRAM", `review3-linked-${runId}`, await client());
    await remembered(linkedId);
    const linkedPlan = await planCustomerLeadOnlyTurn(input({ conversationId: linkedId, inputText: "918 77 66 43", sentTexts: asked }));
    expect(linkedPlan?.intake?.propertyId ?? null).toBeNull();
    const igId = await conversation("INSTAGRAM", `review3-topic-${runId}`);
    await remembered(igId);
    const igPlan = await planCustomerLeadOnlyTurn(input({ conversationId: igId, inputText: "Хочу продать свою квартиру", sentTexts: asked }));
    expect(igPlan?.remember).toMatchObject({ scenario: "seller", propertyId: null });
    const waPeerId = waPeer(), waId = await conversation("WHATSAPP", waPeerId);
    await remembered(waId);
    const waPlan = await planCustomerLeadOnlyTurn(input({ conversationId: waId, channel: "WHATSAPP", peer: waPeerId, inputText: "Хочу продать свою квартиру" }));
    expect(waPlan?.remember).toBeNull();
    expect(waPlan?.forget).toBe(true);
  });

  it("№2: заявка оформлена — память просьбы стёрта", async () => {
    const id = await conversation("INSTAGRAM", `review3-accepted-${runId}`);
    await remembered(id);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "918 77 66 44", sentTexts: asked }));
    expect(plan?.intake).toMatchObject({ scenario: "property", propertyId });
    expect((await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).status).toBe("accepted");
    expect(await pendingOf(id)).toBeNull();
  });

  it("№4: клиент с карточкой «не звоните сейчас, позвоните завтра» — не отказ: время звонка пометкой в карточке, без пуша", async () => {
    const clientId = await client();
    const id = await conversation("INSTAGRAM", `review3-callback-${runId}`, clientId);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Не звоните сейчас, позвоните завтра" }));
    expect(plan?.scenario).toBe("callback");
    expect(plan?.text).toContain("в удобное вам время");
    expect(plan?.text).not.toContain("без проблем");
    const since = new Date();
    expect(await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).toEqual({ status: "noted" });
    expect(await prisma.interaction.findFirst({ where: { clientId, notes: { contains: "позвоните завтра" } } })).not.toBeNull();
    // Пометка в карточке, без отдельного пуша режима: агенту и так приходит обычное уведомление о сообщении.
    expect(await leadOnlyNotificationsSince(id, since, [ownerId])).toBe(0);
  });

});
