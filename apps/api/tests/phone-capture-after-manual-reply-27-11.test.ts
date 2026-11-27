import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runPhoneLeadWatchdogTick, sweepCardConversationPhones } from "../src/lib/phoneLeadWatchdog.js";
import { captureExplicitClientPhone } from "../src/lib/clientPhoneCapture.js";
import { bareOwnPhoneFact } from "../src/lib/clientPhoneFacts.js";
import { unansweredClientTurn } from "../src/lib/unansweredChatTurn.js";
import { extractVolunteeredPhone } from "../src/lib/shared/phoneText.js";

/**
 * КТО ОСТАВИЛ НОМЕР — ТОТ В CRM, ЧТО БЫ НИ ДЕЛАЛ БОТ (27.11.2026).
 *
 * Владелец: «иногда отвечаем клиентам вручную, и номер, который написал клиент, не попадает в CRM,
 * или клиент теряется». 26.11 с 16:30 до 19:33 по Душанбе ядро бота держало ходы (HELD), сотрудники
 * отвечали руками, и около пятнадцати переписок WhatsApp остались без карточки: номер там — сам
 * отправитель, словами его никто не писал, и сторож «номер есть — карточки нет» их не видел.
 *
 * Проверяем класс целиком, а не один путь: ручной ответ, пауза бота, удержанный ход ядра, уже
 * заведённая карточка, известный номер, номер сотрудника и агентства, повтор тика.
 * Модель не зовётся нигде: приём сторожа тихий (silent).
 */


const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const conversationIds: string[] = [];
const clientIds: string[] = [];
const agentIds: string[] = [];
const tails: string[] = [];
let savedHours: { workHoursStart: string; workHoursEnd: string } | null = null;

/** Девять цифр мобильного номера, свои на каждый вызов (номер в CRM уникален глобально). */
function digits9(): string {
  const d = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  tails.push(d);
  return d;
}
const spaced = (d: string) => `+992 ${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

type Msg = Record<string, unknown>;
async function seed(input: { channel?: "INSTAGRAM" | "WHATSAPP"; subscriberId?: string; messages: Msg[];
  clientId?: string; paused?: boolean; spam?: boolean }): Promise<string> {
  const conv = await prisma.botConversation.create({
    data: {
      channel: input.channel ?? "INSTAGRAM",
      subscriberId: input.subscriberId ?? `cap-${runId}-${Math.random().toString(36).slice(2, 8)}`,
      name: null,
      messages: input.messages as never,
      leadDraft: { stage: "chatting" } as never,
      lastMessageAt: new Date(),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.paused ? { pausedUntil: new Date(Date.now() + 6 * 3600_000), botPausedAt: new Date(Date.now() - 3600_000) } : {}),
      ...(input.spam ? { spamFlaggedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  conversationIds.push(conv.id);
  return conv.id;
}

async function cardOf(conversationId: string) {
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId },
    select: { clientId: true, client: { select: { id: true, phone: true, whatsappPhone: true, kind: true, extraPhones: true, assignedAgentId: true } } } });
  if (row?.clientId) clientIds.push(row.clientId);
  return row;
}

async function clientsWithTail(d: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "Client"
    WHERE right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ${d}`;
  return Number(rows[0]?.n ?? 0);
}

async function existingCard(d: string): Promise<string> {
  const card = await prisma.client.create({ data: { fullName: `Карточка ${runId}`, phone: `+992${d}`, source: "INSTAGRAM",
    kind: "BUYER", acceptedAt: new Date(Date.now() - 5 * 3600_000), assignedAt: new Date(Date.now() - 5 * 3600_000) } as never,
    select: { id: true } });
  clientIds.push(card.id);
  return card.id;
}

beforeAll(async () => {
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true } });
  savedHours = { workHoursStart: s.workHoursStart, workHoursEnd: s.workHoursEnd };
  // Заявка вне рабочего окна уходит в утреннюю волну без назначения — фиксируем окно, чтобы дверь назначения звалась всегда.
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "23:59", chatUnansweredCardEnabled: true } });
  const agent = await prisma.agent.create({ data: { fullName: `Агент приёма ${runId}`, phone: `+99293${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    role: "AGENT", passwordHash: "x" }, select: { id: true } });
  agentIds.push(agent.id);
});


afterAll(async () => {
  if (savedHours) await prisma.settings.update({ where: { id: "singleton" }, data: { ...savedHours, chatUnansweredCardEnabled: true } });
  const linked = await prisma.botConversation.findMany({ where: { id: { in: conversationIds } }, select: { clientId: true } });
  const byTail = tails.length ? await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Client"
    WHERE right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ANY(${tails})` : [];
  const ids = [...new Set([...clientIds, ...linked.map((c) => c.clientId), ...byTail.map((c) => c.id)].filter((x): x is string => !!x))];
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.client.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.interaction.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Номер в переписке без хода бота", () => {
  it("сотрудник ответил руками, клиент прислал «+992 900 12 34 56» — карточка с номером, заявка, дверь назначения", async () => {
    const d = digits9();
    const id = await seed({ paused: true, messages: [
      { role: "user", content: "Салом, хона мехоҳам дар Сино", at: ago(120) },
      { role: "assistant", content: "Ассалом, чанд ҳуҷра лозим?", by: { kind: "agent", agentId: "x", agentName: "Агент" }, at: ago(118) },
      { role: "user", content: spaced(d), at: ago(100) },
    ] });

    await runPhoneLeadWatchdogTick();

    const card = await cardOf(id);
    expect(card?.client?.phone.replace(/\D/g, "").slice(-9)).toBe(d);
    // Рабочее окно зафиксировано, активный агент есть: дверь назначения (assignAgentForLead) отработала — агент стоит.
    expect(card?.client?.assignedAgentId).toBeTruthy();
  });

  it("бот на паузе, номер дефисами без кода страны — карточка", async () => {
    const d = digits9();
    const id = await seed({ paused: true, messages: [
      { role: "user", content: "Квартира нужна, 2 комнаты", at: ago(60) },
      { role: "user", content: `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5, 7)}-${d.slice(7)}`, at: ago(55) },
    ] });

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(id))?.client?.phone.replace(/\D/g, "").slice(-9)).toBe(d);
  });

  it("ядро удержало ходы WhatsApp, сотрудник отвечал руками, номер не писали словами — карточка по номеру отправителя", async () => {
    const d = digits9();
    const id = await seed({ channel: "WHATSAPP", subscriberId: `992${d}`, messages: [
      { role: "user", content: "Мехоҳам хонаамро фурӯшам", heldRouting: true, mid: `m1-${runId}`, at: ago(180) },
      { role: "assistant", content: "Хонаатон дар кадом ҷой?", by: { kind: "agent", agentId: "x", agentName: "Агент" }, at: ago(175) },
      { role: "user", content: "Кӯчаи Ленинград, хонаи нав, ошёнаи 3", heldRouting: true, mid: `m2-${runId}`, at: ago(170) },
    ] });

    await runPhoneLeadWatchdogTick();

    const card = await cardOf(id);
    expect(card?.clientId).toBeTruthy();
    expect(card?.client?.phone.replace(/\D/g, "").slice(-9)).toBe(d);
    // Рабочее окно зафиксировано, активный агент есть: дверь назначения (assignAgentForLead) отработала — агент стоит.
    expect(card?.client?.assignedAgentId).toBeTruthy();
  });

  it("номер уже у другой карточки — переписка привязывается к ней, второй карточки нет", async () => {
    const d = digits9();
    const existing = await existingCard(d);
    const id = await seed({ messages: [{ role: "user", content: `Звоните ${spaced(d)}`, at: ago(30) }] });

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(id))?.clientId).toBe(existing);
    expect(await clientsWithTail(d)).toBe(1);
  });

  it("номер сотрудника и номер агентства клиентом не становятся", async () => {
    const staff = digits9();
    const agent = await prisma.agent.create({ data: { fullName: `Сотрудник ${runId}`, phone: `+992${staff}`, role: "AGENT", passwordHash: "x" }, select: { id: true } });
    agentIds.push(agent.id);
    const staffConv = await seed({ messages: [{ role: "user", content: `Номер ${spaced(staff)}`, at: ago(30) }] });
    const agencyConv = await seed({ messages: [{ role: "user", content: "Я звонил на +992 44 650 14 14, никто не ответил", at: ago(30) }] });

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(staffConv))?.clientId).toBeNull();
    expect(await clientsWithTail(staff)).toBe(0);
    expect((await cardOf(agencyConv))?.clientId).toBeNull();
  });

  it("эхо сотрудника из телефона компании (реплика user с автором) — не номер клиента", async () => {
    const d = digits9();
    const id = await seed({ messages: [
      { role: "user", content: "Здравствуйте, сколько стоит?", at: ago(40) },
      { role: "user", content: `Позвоните нашему агенту ${spaced(d)}`, by: { kind: "manual" }, at: ago(35) },
    ] });

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(id))?.clientId).toBeNull();
    expect(await clientsWithTail(d)).toBe(0);
  });

  it("повторный тик (и повторная доставка) не заводит вторую карточку", async () => {
    const d = digits9();
    const id = await seed({ channel: "WHATSAPP", subscriberId: `992${d}`, messages: [
      { role: "user", content: "Хочу купить квартиру в Шохмансуре, сколько стоит?", heldRouting: true, at: ago(90) },
    ] });

    await runPhoneLeadWatchdogTick();
    const first = (await cardOf(id))?.clientId;
    await runPhoneLeadWatchdogTick();

    expect(first).toBeTruthy();
    expect((await cardOf(id))?.clientId).toBe(first);
    expect(await clientsWithTail(d)).toBe(1);
  });
});

describe("WhatsApp: что карточку НЕ заводит", () => {
  it("бот ответил сам, только «спасибо», вакансия, свежая реплика, спам-пометка", async () => {
    const answered = digits9(), thanks = digits9(), job = digits9(), fresh = digits9(), spam = digits9();
    const ids = [
      await seed({ channel: "WHATSAPP", subscriberId: `992${answered}`, messages: [
        { role: "user", content: "Хона мехоҳам", at: ago(90) }, { role: "assistant", content: "Чанд ҳуҷра?", by: { kind: "bot" }, at: ago(89) }] }),
      // У остальных сбой доказан (реплика записана мимо бота) — и всё равно не заявка.
      await seed({ channel: "WHATSAPP", subscriberId: `992${thanks}`, messages: [{ role: "user", content: "Рахмат", heldRouting: true, at: ago(90) }] }),
      await seed({ channel: "WHATSAPP", subscriberId: `992${job}`, messages: [{ role: "user", content: "Ассалом, кор лозим, ваканси доред?", heldRouting: true, at: ago(90) }] }),
      await seed({ channel: "WHATSAPP", subscriberId: `992${fresh}`, messages: [{ role: "user", content: "Хона мехоҳам дар Сино", heldRouting: true, at: ago(5) }] }),
      await seed({ channel: "WHATSAPP", subscriberId: `992${spam}`, spam: true, messages: [{ role: "user", content: "Хона мехоҳам дар Сино", heldRouting: true, at: ago(90) }] }),
    ];

    await runPhoneLeadWatchdogTick();

    for (const id of ids) expect((await cardOf(id))?.clientId).toBeNull();
  });

  it("рубильник выключен — по несостоявшемуся ходу WhatsApp карточки нет", async () => {
    const d = digits9();
    await prisma.settings.update({ where: { id: "singleton" }, data: { chatUnansweredCardEnabled: false } });
    try {
      const id = await seed({ channel: "WHATSAPP", subscriberId: `992${d}`, messages: [{ role: "user", content: "Хонаамро фурӯхтан мехоҳам", heldRouting: true, at: ago(90) }] });
      await runPhoneLeadWatchdogTick();
      expect((await cardOf(id))?.clientId).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { chatUnansweredCardEnabled: true } });
    }
  });
});

describe("Карточка уже есть: номер из переписки дописывается", () => {
  it("номер одним сообщением — в запасные номера, один раз; «номер мужа» — нет", async () => {
    const own = digits9(), other = digits9();
    const cardId = await existingCard(digits9());
    const id = await seed({ clientId: cardId, messages: [] });

    expect(await captureExplicitClientPhone({ kind: "CONVERSATION", id, clientId: cardId, at: new Date(), text: spaced(own) })).toBe(true);
    expect(await captureExplicitClientPhone({ kind: "CONVERSATION", id, clientId: cardId, at: new Date(), text: spaced(own) })).toBe(false);
    expect(await captureExplicitClientPhone({ kind: "CONVERSATION", id, clientId: cardId, at: new Date(), text: `номер мужа ${spaced(other)}` })).toBe(false);

    const card = await prisma.client.findUnique({ where: { id: cardId }, select: { extraPhones: true } });
    expect(card?.extraPhones.filter((p) => p.replace(/\D/g, "").endsWith(own))).toHaveLength(1);
    expect(card?.extraPhones.some((p) => p.replace(/\D/g, "").endsWith(other))).toBe(false);
  });

  it("сторож дописывает номер, пришедший мимо хода (сотрудник отвечал руками), и повтор ничего не меняет", async () => {
    const own = digits9();
    const cardId = await existingCard(digits9());
    await seed({ clientId: cardId, paused: true, messages: [
      { role: "assistant", content: "Какой номер для связи?", by: { kind: "agent", agentId: "x", agentName: "Агент" }, at: ago(20) },
      { role: "user", content: `${own} вотсап`, at: ago(15) },
    ] });

    expect(await sweepCardConversationPhones()).toBeGreaterThanOrEqual(1);
    const after = await prisma.client.findUnique({ where: { id: cardId }, select: { extraPhones: true } });
    expect(after?.extraPhones.some((p) => p.replace(/\D/g, "").endsWith(own))).toBe(true);
    await sweepCardConversationPhones();
    const again = await prisma.client.findUnique({ where: { id: cardId }, select: { extraPhones: true } });
    expect(again?.extraPhones).toEqual(after?.extraPhones);
  });
});

describe("Разбор без базы", () => {
  it("таджикские и русские записи номера читаются", () => {
    for (const text of ["+992 900 12 34 56", "900 12 34 56", "900-12-34-56", "+992900123456", "992 900 123 456", "Рақамам 900123456"]) {
      expect(extractVolunteeredPhone(text)?.replace(/\D/g, "").slice(-9), text).toBe("900123456");
    }
  });

  it("«просто номер» — только номер и слова-связки", () => {
    expect(bareOwnPhoneFact("+992 900 12 34 56")?.phone).toBe("+992900123456");
    expect(bareOwnPhoneFact("900123456 вотсап")?.phone).toBe("+992900123456");
    expect(bareOwnPhoneFact("Позвоните собственнику 900123456")).toBeNull();
    expect(bareOwnPhoneFact("Цена 1 100 000")).toBeNull();
    expect(bareOwnPhoneFact("900123456 или 900123457")).toBeNull();
  });

  it("несостоявшийся ход: ждём 20 минут, сотрудник ответил — отмечено", () => {
    const now = new Date();
    const turn = unansweredClientTurn([
      { role: "user", content: "Мехоҳам хонаамро фурӯшам", at: ago(30) },
      { role: "assistant", content: "Дар кадом ҷой?", by: { kind: "manual" }, at: ago(29) },
    ], null, now);
    expect(turn?.staffReplied).toBe(true);
    expect(unansweredClientTurn([{ role: "user", content: "Мехоҳам хонаамро фурӯшам", at: ago(10) }], null, now)).toBeNull();
    expect(unansweredClientTurn([{ role: "user", content: "Салом", at: ago(60) }], null, now)).toBeNull();
  });
});
