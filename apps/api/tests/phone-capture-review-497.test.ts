import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findPhonesWithoutLead, runPhoneLeadWatchdogTick, sweepCardConversationPhones, turnFailureProven } from "../src/lib/phoneLeadWatchdog.js";
import { captureClientPhoneWithRetry, captureExplicitClientPhone, type ClientPhoneCaptureOutcome } from "../src/lib/clientPhoneCapture.js";
import { bareOwnPhoneFact } from "../src/lib/clientPhoneFacts.js";
import { substantiveClientText, unansweredClientTurn } from "../src/lib/unansweredChatTurn.js";

/**
 * ПРАВКИ ПО НЕЗАВИСИМОМУ РЕВЬЮ #497 (27.11.2026). Карточка по несостоявшемуся ходу WhatsApp — только при ДОКАЗАННОМ сбое,
 * намеренное молчание бота сбоем не считается; свой предел тика; добор без этой ветки; карточка сотруднику, который вёл
 * переписку; «просто номер» не после вопроса о чужом номере; номера агентства и сотрудников — никогда; проход по карточкам
 * с отметкой; повтор записи номера при параллельной правке карточки. Каждый пункт — отдельный тест.
 */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const conversationIds: string[] = [];
const clientIds: string[] = [];
const agentIds: string[] = [];
const tails: string[] = [];
let saved: { workHoursStart: string; workHoursEnd: string; botLeadOnlyMode: boolean; botUseWhatsappNumber: boolean } | null = null;

function digits9(): string {
  const d = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  tails.push(d);
  return d;
}
const spaced = (d: string) => `+992 ${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
type Msg = Record<string, unknown>;

async function waChat(messages: Msg[], extra: Record<string, unknown> = {}): Promise<{ id: string; d: string }> {
  const d = digits9();
  const conv = await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: `992${d}`, messages: messages as never,
    leadDraft: { stage: "chatting" } as never, lastMessageAt: new Date(), ...extra }, select: { id: true } });
  conversationIds.push(conv.id);
  return { id: conv.id, d };
}
async function cardOf(id: string) {
  const row = await prisma.botConversation.findUnique({ where: { id }, select: { clientId: true, client: { select: { assignedAgentId: true } } } });
  if (row?.clientId) clientIds.push(row.clientId);
  return row;
}
async function existingCard(d: string): Promise<string> {
  const card = await prisma.client.create({ data: { fullName: `Карточка ${runId}`, phone: `+992${d}`, source: "WHATSAPP", kind: "BUYER",
    acceptedAt: new Date(Date.now() - 5 * 3600_000), assignedAt: new Date(Date.now() - 5 * 3600_000) } as never, select: { id: true } });
  clientIds.push(card.id);
  return card.id;
}
const sell = "Мехоҳам хонаамро фурӯшам, кӯчаи Ленинград";
const held = (content: string, min = 60): Msg => ({ role: "user", content, heldRouting: true, at: ago(min) });

beforeAll(async () => {
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true, botLeadOnlyMode: true, botUseWhatsappNumber: true } });
  saved = s;
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "23:59",
    chatUnansweredCardEnabled: true, chatBarePhoneToCardEnabled: true, botLeadOnlyMode: false } });
  const agent = await prisma.agent.create({ data: { fullName: `Агент ревью ${runId}`, phone: `+99293${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    role: "AGENT", passwordHash: "x" }, select: { id: true } });
  agentIds.push(agent.id);
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: { ...saved, chatUnansweredCardEnabled: true, chatBarePhoneToCardEnabled: true } });
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

describe("B1: только доказанный сбой", () => {
  it("бот просто молчит (нет удержания, ответа сотрудника, билета со сбоем) — карточки нет", async () => {
    const { id } = await waChat([{ role: "user", content: sell, at: ago(60) }]);
    await runPhoneLeadWatchdogTick();
    expect((await cardOf(id))?.clientId).toBeNull();
  });

  it("причина молчания ядра из общего списка намеренных — не сбой; иная причина — сбой", () => {
    const turn = { held: false, staffReplied: false, eventKeys: ["k1"] };
    expect(turnFailureProven(turn, [{ eventKey: "k1", errorCode: "ack_only_reaction" }])).toBe(false);
    expect(turnFailureProven(turn, [{ eventKey: "k1", errorCode: "spam_muted_no_reply" }])).toBe(false);
    expect(turnFailureProven(turn, [{ eventKey: "k1", errorCode: "lead_only_operator_silent" }])).toBe(false);
    expect(turnFailureProven(turn, [{ eventKey: "k1", errorCode: "consume_job_gave_up" }])).toBe(true);
    expect(turnFailureProven(turn, [{ eventKey: "k1", errorCode: "current_artifact_revision_mismatch" }])).toBe(true);
    expect(turnFailureProven(turn, [])).toBe(false);
  });

  it("стикер или фото без подписи, одна чужая ссылка, приветствие, «не пишите мне» — не обращение", () => {
    for (const content of ["[📷]", "[вложение: image]", "[вложение: sticker]", "https://www.instagram.com/reel/abc123/", "Салом", "Больше не пишите мне"]) {
      expect(substantiveClientText({ role: "user", content } as never), content).toBeNull();
    }
    expect(unansweredClientTurn([held(sell), held("Больше не пишите мне", 50)] as never, null, new Date())).toBeNull();
  });

  it("заглушённый спам, «не пишите» (optedOutAt), неясное направление без сотрудника — карточки нет", async () => {
    const muted = await waChat([held(sell)], { leadDraft: { stage: "chatting", spamMute: { turns: [], mutedUntil: new Date(Date.now() + 86400_000).toISOString() } } });
    const opted = await waChat([held(sell)], { optedOutAt: new Date() });
    const unclear = await waChat([held("Здравствуйте, подскажите пожалуйста")]);
    await runPhoneLeadWatchdogTick();
    expect((await cardOf(opted.id))?.clientId).toBeNull();
    expect((await cardOf(unclear.id))?.clientId).toBeNull();
    expect((await cardOf(muted.id))?.clientId).toBeNull();
  });

  it("режим «только заявки» без номера WhatsApp — карточка по отправителю не заводится", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: true, botUseWhatsappNumber: false } });
    try {
      const { id } = await waChat([held(sell)]);
      await runPhoneLeadWatchdogTick();
      expect((await cardOf(id))?.clientId).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { botLeadOnlyMode: false, botUseWhatsappNumber: true } });
    }
  });
});

describe("S2, S3, S5", () => {
  it("S2: разовый добор (ignoreAttempts) несостоявшиеся ходы WhatsApp не берёт", async () => {
    const { id } = await waChat([held(sell)]);
    const found = await findPhonesWithoutLead(new Date(), { ignoreAttempts: true, windowHours: 72 });
    expect(found.some((r) => r.conversationId === id)).toBe(false);
  });

  it("S3: сотрудник CRM вёл переписку — карточка уходит ему, даже если направление неясно", async () => {
    const staffId = agentIds[0];
    const { id } = await waChat([
      held("Здравствуйте, у меня вопрос по квартире", 90),
      { role: "assistant", content: "Слушаю вас", by: { kind: "agent", agentId: staffId, agentName: "Агент" }, at: ago(85) },
    ]);
    await runPhoneLeadWatchdogTick();
    const card = await cardOf(id);
    expect(card?.clientId).toBeTruthy();
    expect(card?.client?.assignedAgentId).toBe(staffId);
  });

  it("S5: отправитель WhatsApp — наш сотрудник: карточки нет", async () => {
    const d = digits9();
    const staff = await prisma.agent.create({ data: { fullName: `Сотрудник WA ${runId}`, phone: `+992${d}`, role: "AGENT", passwordHash: "x" }, select: { id: true } });
    agentIds.push(staff.id);
    const conv = await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: `992${d}`, messages: [held(sell)] as never,
      leadDraft: { stage: "chatting" } as never, lastMessageAt: new Date() }, select: { id: true } });
    conversationIds.push(conv.id);
    await runPhoneLeadWatchdogTick();
    expect((await cardOf(conv.id))?.clientId).toBeNull();
  });

  it("S5: номер агентства одним сообщением в карточку не пишется", async () => {
    const cardId = await existingCard(digits9());
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `rv-${runId}-${Math.random().toString(36).slice(2, 7)}`,
      clientId: cardId, messages: [] as never, lastMessageAt: new Date() }, select: { id: true } });
    conversationIds.push(conv.id);
    expect(await captureExplicitClientPhone({ kind: "CONVERSATION", id: conv.id, clientId: cardId, at: new Date(), text: "+992 44 650 14 14" })).toBe(false);
  });
});

describe("S1: свой предел у карточек WhatsApp", () => {
  it("обычный номер из текста оформляется, хотя очередь WhatsApp длиннее предела; лишние WhatsApp ждут, не тревога", async () => {
    const wa = [];
    for (let i = 0; i < 11; i++) wa.push(await waChat([held(`${sell}, дом ${i + 1}`)]));
    const d = digits9();
    const text = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `rv-${runId}-t`, lastMessageAt: new Date(),
      messages: [{ role: "user", content: `Хочу купить квартиру, ${spaced(d)}`, at: ago(30) }] as never, leadDraft: { stage: "chatting" } as never }, select: { id: true } });
    conversationIds.push(text.id);
    const before = await prisma.pendingDirectorAlert.count();

    await runPhoneLeadWatchdogTick();

    expect((await cardOf(text.id))?.clientId).toBeTruthy();
    const made = (await Promise.all(wa.map((w) => cardOf(w.id)))).filter((c) => c?.clientId).length;
    expect(made).toBe(10);
    expect(await prisma.pendingDirectorAlert.count()).toBe(before);
    await runPhoneLeadWatchdogTick();
    expect((await Promise.all(wa.map((w) => cardOf(w.id)))).filter((c) => c?.clientId).length).toBe(11);
  });
});

describe("S4, S6, S7: номер в уже заведённую карточку", () => {
  it("S4: после вопроса о номере хозяина «просто номер» — решает человек; после «ваш номер?» — пишется", () => {
    expect(bareOwnPhoneFact("900123456", "Дайте номер хозяина квартиры")).toBeNull();
    expect(bareOwnPhoneFact("900123456", "Рақами шавҳаратонро нависед")).toBeNull();
    expect(bareOwnPhoneFact("900123456", "Напишите ваш номер, пожалуйста")?.phone).toBe("+992900123456");
    expect(bareOwnPhoneFact("900123456", "Есть другой номер для связи?")?.phone).toBe("+992900123456");
  });

  it("S4: проход по карточкам не дописывает номер, присланный в ответ на вопрос о чужом номере", async () => {
    const other = digits9();
    const cardId = await existingCard(digits9());
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `rv-${runId}-s4`, clientId: cardId, lastMessageAt: new Date(),
      messages: [{ role: "assistant", content: "Номер собственника подскажете?", by: { kind: "agent", agentId: "x", agentName: "А" }, at: ago(20) },
        { role: "user", content: spaced(other), at: ago(15) }] as never }, select: { id: true } });
    conversationIds.push(conv.id);
    await sweepCardConversationPhones();
    const card = await prisma.client.findUnique({ where: { id: cardId }, select: { extraPhones: true } });
    expect(card?.extraPhones.some((p) => p.replace(/\D/g, "").endsWith(other))).toBe(false);
  });

  it("S6: переписка без новых сообщений второй раз не разбирается (отметка прохода)", async () => {
    const own = digits9();
    const cardId = await existingCard(digits9());
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `rv-${runId}-s6`, clientId: cardId, lastMessageAt: new Date(),
      messages: [{ role: "user", content: `Дата 2026-11-26, номер ${spaced(own)}`, at: ago(10) }, { role: "user", content: spaced(own), at: ago(9) }] as never },
      select: { id: true } });
    conversationIds.push(conv.id);
    await sweepCardConversationPhones();
    const first = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { phoneSweepAt: true } });
    expect(first?.phoneSweepAt).toBeTruthy();
    await sweepCardConversationPhones();
    const second = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { phoneSweepAt: true } });
    expect(second?.phoneSweepAt?.getTime()).toBe(first?.phoneSweepAt?.getTime());
    const card = await prisma.client.findUnique({ where: { id: cardId }, select: { extraPhones: true } });
    expect(card?.extraPhones.filter((p) => p.replace(/\D/g, "").endsWith(own))).toHaveLength(1);
  });

  it("S7: запись номера повторяется при параллельной правке карточки и не повторяется при отказе правила", async () => {
    const source = { kind: "CONVERSATION" as const, id: "c", clientId: "x", at: new Date(), text: "900123456" };
    const seq = (outcomes: ClientPhoneCaptureOutcome[]) => { let i = 0; const calls = { n: 0 };
      return { calls, fn: async () => { calls.n++; return outcomes[Math.min(i++, outcomes.length - 1)]; } }; };
    const a = seq(["conflict", "conflict", "saved"]);
    expect(await captureClientPhoneWithRetry(source, 3, a.fn)).toBe(true);
    expect(a.calls.n).toBe(3);
    const b = seq(["skipped"]);
    expect(await captureClientPhoneWithRetry(source, 3, b.fn)).toBe(false);
    expect(b.calls.n).toBe(1);
    const c = seq(["conflict"]);
    expect(await captureClientPhoneWithRetry(source, 3, c.fn)).toBe(false);
    expect(c.calls.n).toBe(3);
  });
});
