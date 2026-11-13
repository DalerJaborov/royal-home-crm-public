import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { planCustomerLeadOnlyTurn, runCustomerLeadOnlyIntake, type CustomerLeadOnlyTurnInput } from "../src/lib/customerLeadOnlyCore.js";
import { leadOnlyNotificationsSince } from "./helpers/leadOnlyQuiet.js";
import { LEAD_ONLY_DEFAULTS, LEAD_ONLY_OFFICE_PHONE_TEXT } from "../src/ai/leadOnlyMode.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * ПЯТОЕ РЕВЬЮ РЕЖИМА «ТОЛЬКО ЗАЯВКИ» (13.11.2026): решения ядра на настоящей базе (planCustomerLeadOnlyTurn и задание
 * заявки). Сквозные ходы ядра — раздел «пятое ревью» в lead-only-mode-core-postgres, старый путь — в
 * lead-only-mode-legacy-postgres. Каждый тест проверен внесённой поломкой (журнал docs/journal/2026-11-13-bot-lead-only-mode.md).
 */
const runId = Date.now().toString(36);
const config = { ...LEAD_ONLY_DEFAULTS, enabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" };
const conversations: string[] = [], clients: string[] = [], agents: string[] = [];
let agentId: string;
const waPeer = () => `99294${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const phone9 = () => `93${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

function input(over: Partial<CustomerLeadOnlyTurnInput>): CustomerLeadOnlyTurnInput {
  return { config, channel: "INSTAGRAM", peer: `review5-${runId}-${randomUUID()}`, conversationId: randomUUID(), eventKey: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    language: "ru", inputText: "", focusPropertyId: null, focusFromThisMessage: false, turns: [], sentTexts: [], jobTopic: false, ...over };
}
async function conversation(channel: "INSTAGRAM" | "WHATSAPP", subscriberId: string, clientId?: string) {
  const row = await prisma.botConversation.create({ data: { channel, subscriberId, messages: [], ...(clientId ? { clientId } : {}) } });
  conversations.push(row.id); return row.id;
}
async function client(assignedAgentId: string | null, extra: { phone?: string; extraPhones?: string[] } = {}) {
  const row = await prisma.client.create({ data: { fullName: `Клиент ревью5 ${runId}`, phone: extra.phone ?? `+992${phone9()}`,
    extraPhones: extra.extraPhones ?? [], source: "INSTAGRAM", ...(assignedAgentId ? { assignedAgentId } : {}) } });
  clients.push(row.id); return row.id;
}

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: `Агент ревью5 ${runId}`, phone: `+99290${String(Date.now()).slice(-7)}`,
    role: "AGENT", passwordHash: "x" } })).id;
  agents.push(agentId);
});
beforeEach(async () => { await drainBackgroundTasks(3000); });
afterAll(async () => {
  await drainBackgroundTasks(3000);
  const linked = await prisma.botConversation.findMany({ where: { id: { in: conversations } }, select: { clientId: true } });
  clients.push(...linked.flatMap(row => (row.clientId ? [row.clientId] : [])));
  await prisma.botConversation.deleteMany({ where: { id: { in: conversations } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
});

describe("№1: «соедините с человеком» без номера (ядро)", () => {
  it("Instagram: ответ сервера — просьба номера, без задания, без уведомлений", async () => {
    const since = new Date();
    const id = await conversation("INSTAGRAM", `review5-staff-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Соедините меня с менеджером, пожалуйста" }));
    expect(plan?.scenario).toBe("escalate");
    expect(plan?.text).toBe("С этим вопросом поможет агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.");
    expect(plan?.intake).toBeNull();
    expect(await leadOnlyNotificationsSince(id, since, [agentId])).toBe(0);
  });
  it("Instagram, просьбы исчерпаны и офис называли — номер офиса", async () => {
    const id = await conversation("INSTAGRAM", `review5-staff-office-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Оператор", sentTexts: [
      "Оставьте, пожалуйста, номер телефона, агент перезвонит.", "Если удобно, напишите номер, и агент позвонит сам.",
      `Если удобнее, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`] }));
    expect(plan?.text).toContain(LEAD_ONLY_OFFICE_PHONE_TEXT);
  });
  it("WhatsApp: номер отправителя есть — это заявка («вопрос к агенту»), как и любой вопрос к сотруднику", async () => {
    const peer = waPeer();
    const id = await conversation("WHATSAPP", peer);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, channel: "WHATSAPP", peer, inputText: "Хочу поговорить с оператором" }));
    expect(plan?.scenario).toBe("escalate");
    expect(plan?.intake).toMatchObject({ scenario: "escalate" });
  });
});

describe("№2: карточка без агента — без «передаю», «позвонит», «в курсе»", () => {
  const promises = /передаю|позвонит|в курсе|агент/iu;
  it("горячие слова: «записали, свяжутся», без задания и уведомлений; с агентом — прежнее «передаю агенту»", async () => {
    const since = new Date();
    const orphan = await conversation("INSTAGRAM", `review5-noagent-${runId}`, await client(null));
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: orphan, inputText: "Хотим посмотреть, куда ехать?" }));
    expect(plan?.scenario).toBe("hot");
    expect(plan?.text).toMatch(/^Записали, с вами свяжутся /u);
    expect(plan?.text).not.toMatch(promises);
    expect(plan?.intake).toBeNull();
    expect(await leadOnlyNotificationsSince(orphan, since, [agentId])).toBe(0);
    const owned = await conversation("INSTAGRAM", `review5-agent-${runId}`, await client(agentId));
    expect((await planCustomerLeadOnlyTurn(input({ conversationId: owned, inputText: "Хотим посмотреть, куда ехать?" })))?.text).toMatch(/передаю агенту/u);
  });
  it("агент отключён — то же честное «записали»", async () => {
    const off = (await prisma.agent.create({ data: { fullName: `Уволен ревью5 ${runId}`, phone: `+99290${String(Date.now() + 7).slice(-7)}`,
      role: "AGENT", passwordHash: "x", isActive: false } })).id;
    agents.push(off);
    const id = await conversation("INSTAGRAM", `review5-inactive-${runId}`, await client(off));
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Соедините с менеджером" }));
    expect(plan?.text).toMatch(/^Записали, с вами свяжутся /u);
  });
  it("время звонка и «не звоните» у карточки без агента — тоже без обещаний агента, пометка в карточке остаётся", async () => {
    const id = await conversation("INSTAGRAM", `review5-noagent-cb-${runId}`, await client(null));
    const callback = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Позвоните завтра после шести" }));
    expect(callback?.scenario).toBe("callback");
    expect(callback?.text).not.toMatch(promises);
    expect(callback?.intake).not.toBeNull();
    const noCall = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Не звоните мне, пишите здесь" }));
    expect(noCall?.scenario).toBe("no_call");
    expect(noCall?.text).not.toMatch(promises);
  });
});

describe("№5: другой номер у клиента с карточкой (одна дверь с старым путём)", () => {
  it("номер уже в запасных (его туда кладёт приём номера из переписки) — всё равно пометка «просит звонить на»", async () => {
    const extra = `+992${phone9()}`;
    const clientId = await client(agentId, { extraPhones: [extra] });
    const id = await conversation("INSTAGRAM", `review5-phone-${runId}`, clientId);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: `Звоните лучше на ${extra.slice(4)}` }));
    expect(plan?.intake).not.toBeNull();
    const since = new Date();
    expect(await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).toEqual({ status: "noted" });
    expect(await prisma.interaction.findFirst({ where: { clientId, notes: { contains: "просит звонить на" } } })).not.toBeNull();
    expect(await leadOnlyNotificationsSince(id, since, [agentId])).toBe(0);
  });
  it("тот же основной номер — без пометки", async () => {
    const main = `+992${phone9()}`;
    const clientId = await client(agentId, { phone: main });
    const id = await conversation("INSTAGRAM", `review5-same-${runId}`, clientId);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: `Мой номер ${main.slice(4)}` }));
    expect(await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).toEqual({ status: "skipped", reason: "card_exists" });
  });
});
