import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { planCustomerLeadOnlyTurn, runCustomerLeadOnlyIntake, sealCustomerLeadOnlyIntake, type CustomerLeadOnlyTurnInput } from "../src/lib/customerLeadOnlyCore.js";
import { leadOnlyHandoverTag, leadOnlyHumanNotifiedRecently, notifyLeadOnlyHandover } from "../src/lib/leadOnlyHandover.js";
import { loadCustomerAgentFeaturePolicy } from "../src/lib/customerAgentFeaturePolicy.js";
import { loadBotCapabilities } from "../src/messengers/botCapabilities.js";
import { LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — ПРАВКИ ПО РЕВЬЮ 13.11.2026 (решения ядра и задание заявки на настоящей базе).
 * Каждый тест здесь падает на коде до правки: номер находки ревью — в имени теста.
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
  await prisma.notification.deleteMany({ where: { OR: conversations.map(id => ({ tag: { startsWith: leadOnlyHandoverTag(id) } })) } });
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

  it("№6: карточка есть, номера в этом ходе нет — без «номер получил»; человек зовётся", async () => {
    const id = await conversation("INSTAGRAM", `review-card-${runId}`, await client());
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Хотим посмотреть, куда ехать?" }));
    expect(plan?.text).not.toMatch(/номер получил/i);
    expect(plan?.intake).not.toBeNull();
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

describe("задание заявки: человек узнаёт всегда", () => {
  it("№3: Instagram без номера, горячие слова — уведомление человеку и ответ без «позвонит» после всех просьб", async () => {
    const id = await conversation("INSTAGRAM", `review-hot-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Хотим посмотреть, куда ехать?", focusPropertyId: propertyId,
      sentTexts: ["Понял вас. Оставьте, пожалуйста, номер телефона, агент перезвонит.", "Если удобно, напишите номер, и агент позвонит сам."] }));
    expect(plan?.text).toContain("ответит вам здесь");
    expect(plan?.intake).not.toBeNull();
    expect(await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).toEqual({ status: "notified" });
    await new Promise(resolve => setTimeout(resolve, 300)); // запись в ленту идёт в отрыве
    // Агент объекта получил запись в ленте с переходом в переписку.
    const note = await prisma.notification.findFirst({ where: { tag: { startsWith: `${leadOnlyHandoverTag(id)}:` }, agentId: ownerId } });
    expect(note?.url).toBe(`/messages?open=${id}`);
  });

  it("№13d: повтор «адрес?» в том же диалоге не будит людей снова", async () => {
    const id = await conversation("INSTAGRAM", `review-dedupe-${runId}`);
    const first = await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "hot", summary: "тест" });
    expect(first.status).toBe("notified");
    await new Promise(resolve => setTimeout(resolve, 300)); // запись в ленту идёт в отрыве
    expect(await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "hot", summary: "тест" })).toEqual({ status: "deduped" });
  });

  it("№3: карточка без агента — зовутся руководители, у карточки с агентом ставится метка «просит агента»", async () => {
    const withAgent = await client();
    const id = await conversation("INSTAGRAM", `review-attn-${runId}`, withAgent);
    expect(await notifyLeadOnlyHandover({ conversationId: id, propertyId: null, reason: "hot", summary: "тест" }))
      .toMatchObject({ status: "notified", to: "assigned" });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: withAgent } })).agentAttentionRequestedAt).not.toBeNull();
    const orphan = await conversation("INSTAGRAM", `review-orphan-${runId}`, await client(null));
    expect(await notifyLeadOnlyHandover({ conversationId: orphan, propertyId: null, reason: "escalate", summary: "тест" }))
      .toMatchObject({ status: "notified", to: "supervisors" });
  });

  it("№7: приём отказал (аренда) — не тихий пропуск, а человек", async () => {
    const id = await conversation("INSTAGRAM", `review-declined-${runId}`);
    const intake = sealCustomerLeadOnlyIntake({ eventKey: "b".repeat(64), conversationId: id, scenario: "buyer", propertyId: null },
      { phone: "+992918223399", whatsappPhone: null, clientText: "Сдаёте квартиру в аренду? 918 22 33 99", promised: "call", lead: true });
    expect(await runCustomerLeadOnlyIntake(intake, { force: true })).toMatchObject({ status: "skipped", reason: "declined" });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await prisma.notification.count({ where: { tag: { startsWith: `${leadOnlyHandoverTag(id)}:` } } })).toBeGreaterThan(0);
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

// ── Второе ревью 13.11.2026: каждый тест падает на коде до правки (номер находки — в имени) ──
describe("второе ревью: кого и когда зовёт дверь передачи", () => {
  const notes = (id: string) => prisma.notification.findMany({ where: { tag: { startsWith: `${leadOnlyHandoverTag(id)}:` } },
    select: { agentId: true, title: true, body: true, url: true, tag: true } });

  it("№4: заметка о вопросе к сотруднику не глушит горячие слова; тот же горячий повод — один раз", async () => {
    const id = await conversation("INSTAGRAM", `review2-hot-${runId}`);
    expect((await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "escalate", summary: "вопрос по документам" })).status).toBe("notified");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "hot", summary: "хотим посмотреть завтра" })).status).toBe("notified");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "hot", summary: "хотим посмотреть завтра" })).toEqual({ status: "deduped" });
    // Третье ревью 13.11, №5: окно горячих слов — на разговор, а не на текст; другие горячие слова в те же 15 минут не будят снова.
    expect(await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "hot", summary: "куда ехать прямо сейчас?" })).toEqual({ status: "deduped" });
  });

  it("№5: агент карточки уволен — зовётся агент объекта, а не пустота", async () => {
    const fired = (await prisma.agent.create({ data: { fullName: `Уволенный ${runId}`, phone: `+992905${String(Date.now()).slice(-6)}`, role: "AGENT",
      passwordHash: "x", isActive: false } })).id;
    agents.push(fired);
    const id = await conversation("INSTAGRAM", `review2-fired-${runId}`, await client(fired));
    expect(await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "hot", summary: "хотим посмотреть" }))
      .toMatchObject({ status: "notified", to: "property" });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await notes(id)).map(n => n.agentId)).toEqual([ownerId]);
  });

  it("владение: у клиента свой агент — ему карточка, хозяину объекта короткая заметка без контактов клиента", async () => {
    const own = (await prisma.agent.create({ data: { fullName: `Свой агент ${runId}`, phone: `+992904${String(Date.now()).slice(-6)}`, role: "AGENT",
      passwordHash: "x" } })).id;
    agents.push(own);
    const clientId = await client(own);
    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const id = await conversation("INSTAGRAM", `review2-owner-${runId}`, clientId);
    expect(await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "property", summary: "интересует объект" }))
      .toMatchObject({ status: "notified", to: "assigned" });
    await new Promise(resolve => setTimeout(resolve, 300));
    const all = await notes(id);
    expect(all.find(n => n.agentId === own)?.url).toBe(`/clients/${card.shortId}`);
    const owner = all.find(n => n.agentId === ownerId);
    expect(owner?.title).toMatch(/Клиент интересуется вашим объектом №\d+/);
    expect(owner?.body).toContain(`Свой агент ${runId}`);
    expect(`${owner?.title} ${owner?.body} ${owner?.url}`).not.toContain(card.fullName);
    expect(`${owner?.title} ${owner?.body}`).not.toContain(card.phone.slice(-7));
  });

  it("№9: тот же номер, что уже в карточке, не будит людей мимо окна; новый номер — один раз на номер", async () => {
    const clientId = await client();
    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const id = await conversation("INSTAGRAM", `review2-samephone-${runId}`, clientId);
    const run = (phone: string, key: string) => runCustomerLeadOnlyIntake(sealCustomerLeadOnlyIntake({ eventKey: key.repeat(64), conversationId: id,
      scenario: "escalate", propertyId: null }, { phone, whatsappPhone: null, clientText: `звоните на ${phone}`, promised: "call", lead: false }), { force: true });
    await run(card.phone, "1"); await new Promise(resolve => setTimeout(resolve, 300));
    await run(card.phone, "2"); await new Promise(resolve => setTimeout(resolve, 300));
    expect((await notes(id)).filter(n => n.tag?.includes(":new_phone")).length).toBe(0);
    expect((await notes(id)).filter(n => n.tag?.endsWith(":escalate")).length).toBe(1);
    await run("+992900112233", "3"); await new Promise(resolve => setTimeout(resolve, 300));
    await run("+992900112233", "4"); await new Promise(resolve => setTimeout(resolve, 300));
    expect((await notes(id)).filter(n => n.tag?.includes(":new_phone")).length).toBe(1);
  });

  it("№2: объект без номера — агент объекта узнаёт сразу (задание заводится и зовёт его)", async () => {
    const id = await conversation("INSTAGRAM", `review2-prop-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Салом", focusPropertyId: propertyId, focusFromThisMessage: true }));
    expect(plan?.text).toMatch(/№\d+/);
    expect(plan?.text).toContain("Оставьте, пожалуйста, номер");
    expect(plan?.intake).not.toBeNull();
    expect(plan?.remember).toMatchObject({ scenario: "property", propertyId });
    expect(await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).toEqual({ status: "notified" });
    await new Promise(resolve => setTimeout(resolve, 300));
    const owner = (await notes(id)).find(n => n.agentId === ownerId);
    expect(owner?.url).toBe(`/messages?open=${id}`);
    expect(owner?.tag).toContain(":property");
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

// ── Третье ревью 13.11.2026: каждый тест проверен внесённой поломкой (номер находки — в имени) ──
describe("третье ревью: ядро и дверь передачи", () => {
  const notes = (id: string) => prisma.notification.findMany({ where: { tag: { startsWith: `${leadOnlyHandoverTag(id)}:` } },
    select: { agentId: true, title: true, tag: true } });
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

  it("№4: клиент с карточкой «не звоните сейчас, позвоните завтра» — не отказ: агенту время звонка в карточку", async () => {
    const clientId = await client();
    const id = await conversation("INSTAGRAM", `review3-callback-${runId}`, clientId);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Не звоните сейчас, позвоните завтра" }));
    expect(plan?.scenario).toBe("callback");
    expect(plan?.text).toContain("в удобное вам время");
    expect(plan?.text).not.toContain("без проблем");
    expect(await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).toEqual({ status: "notified" });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await notes(id)).find(n => n.agentId === ownerId)?.tag).toContain(":callback_time");
    expect(await prisma.interaction.findFirst({ where: { clientId, notes: { contains: "позвоните завтра" } } })).not.toBeNull();
  });

  it("№5: четыре горячих сообщения подряд — одно срочное уведомление на разговор", async () => {
    const id = await conversation("INSTAGRAM", `review3-hot-${runId}`);
    const statuses: string[] = [];
    for (const summary of ["какой адрес? хотим приехать", "куда ехать?", "хотим посмотреть сегодня", "можно приехать сейчас?"]) {
      statuses.push((await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "hot", summary })).status);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(statuses).toEqual(["notified", "deduped", "deduped", "deduped"]);
    expect((await notes(id)).filter(n => n.tag?.includes(":hot")).length).toBe(1);
  });

  it("№6: «позван ли человек» — по точным меткам; в метке нового номера нет подбираемого отпечатка", async () => {
    const id = await conversation("INSTAGRAM", `review3-notified-${runId}`), other = await conversation("INSTAGRAM", `review3-quiet-${runId}`);
    expect(await leadOnlyHumanNotifiedRecently(id)).toBe(false);
    await notifyLeadOnlyHandover({ conversationId: id, propertyId, reason: "property", summary: "интересует объект" });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await leadOnlyHumanNotifiedRecently(id)).toBe(true);
    expect(await leadOnlyHumanNotifiedRecently(other)).toBe(false);
    const cardId = await conversation("INSTAGRAM", `review3-newphone-${runId}`, await client());
    await notifyLeadOnlyHandover({ conversationId: cardId, propertyId: null, reason: "new_phone", key: "900112233", summary: "новый номер" });
    await new Promise(resolve => setTimeout(resolve, 300));
    const tag = (await notes(cardId)).find(n => n.tag?.includes(":new_phone"))?.tag ?? "";
    expect(tag).toMatch(/:new_phone:[0-9a-f]{16}$/);
    expect(tag).not.toContain(createHash("sha256").update("900112233").digest("hex").slice(0, 12));
  });
});
