import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { planCustomerLeadOnlyTurn, runCustomerLeadOnlyIntake, type CustomerLeadOnlyTurnInput } from "../src/lib/customerLeadOnlyCore.js";
import { leadOnlyHandoverTag, leadOnlyHumanNotifiedRecently, notifyLeadOnlyHandover } from "../src/lib/leadOnlyHandover.js";
import { appendConversationMessages } from "../src/messengers/appendMessages.js";
import { LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * ЧЕТВЁРТОЕ РЕВЬЮ РЕЖИМА «ТОЛЬКО ЗАЯВКИ» (13.11.2026): ядро, дверь передачи и запись ответа на настоящей базе.
 * Слова (отказ / время / горячее) — таблица tests/lead-only-phrases.test.ts. Номер находки — в имени теста;
 * каждый тест проверен внесённой поломкой (журнал docs/journal/2026-11-13-bot-lead-only-mode.md).
 */
const runId = Date.now().toString(36);
const config = { ...LEAD_ONLY_DEFAULTS, enabled: true, workHoursStart: "00:00", workHoursEnd: "24:00" };
const conversations: string[] = [], clients: string[] = [], agents: string[] = [], properties: string[] = [];
let ownerA: string, ownerB: string, propertyA: string, propertyB: string;
const waPeer = () => `99293${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const settle = () => new Promise(resolve => setTimeout(resolve, 300)); // запись в ленту идёт в отрыве

function input(over: Partial<CustomerLeadOnlyTurnInput>): CustomerLeadOnlyTurnInput {
  return { config, channel: "INSTAGRAM", peer: `review4-${runId}-${randomUUID()}`, conversationId: randomUUID(), eventKey: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    language: "ru", inputText: "", focusPropertyId: null, focusFromThisMessage: false, turns: [], sentTexts: [], jobTopic: false, ...over };
}
async function conversation(channel: "INSTAGRAM" | "WHATSAPP", subscriberId: string, clientId?: string, messages: unknown[] = []) {
  const row = await prisma.botConversation.create({ data: { channel, subscriberId, messages: messages as never, ...(clientId ? { clientId } : {}) } });
  conversations.push(row.id); return row.id;
}
async function client(assignedAgentId: string | null) {
  const row = await prisma.client.create({ data: { fullName: `Клиент ревью4 ${runId}`, phone: `+99291${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    source: "INSTAGRAM", ...(assignedAgentId ? { assignedAgentId } : {}) } });
  clients.push(row.id); return row.id;
}
/** Пометка заявки для агента (Client.requirementsNotes) карточки, заведённой по диалогу. */
async function requirementsOf(conversationId: string): Promise<string> {
  const row = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { client: { select: { requirementsNotes: true } } } });
  expect(row.client).not.toBeNull();
  return row.client?.requirementsNotes ?? "";
}
const notes = (id: string) => prisma.notification.findMany({ where: { tag: { startsWith: `${leadOnlyHandoverTag(id)}:` } },
  select: { agentId: true, tag: true } });

beforeAll(async () => {
  for (const suffix of ["A", "B"]) {
    const agent = await prisma.agent.create({ data: { fullName: `Хозяин ${suffix} ревью4 ${runId}`,
      phone: `+99290${suffix === "A" ? 5 : 4}${String(Date.now()).slice(-6)}`, role: "AGENT", passwordHash: "x" } });
    const property = await prisma.property.create({ data: { title: `Объект ${suffix} ревью4 ${runId}`, type: "APARTMENT", status: "AVAILABLE",
      publishedOnSite: true, price: 400000, currency: "TJS", rooms: 2, areaSqm: 55, condition: "GOOD", assignedAgentId: agent.id } });
    agents.push(agent.id); properties.push(property.id);
  }
  [ownerA, ownerB] = agents; [propertyA, propertyB] = properties;
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
  await prisma.property.deleteMany({ where: { id: { in: properties } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
});

describe("№1: отказ от звонка со словом времени", () => {
  it("клиент с карточкой «Не звоните мне, я сейчас на работе, пишите здесь» — без обещания звонка, агенту пометка «писать в чат»", async () => {
    const clientId = await client(ownerA);
    const id = await conversation("INSTAGRAM", `review4-nocall-${runId}`, clientId);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Не звоните мне, я сейчас на работе, пишите здесь" }));
    expect(plan?.scenario).toBe("no_call");
    expect(plan?.text).toContain("ответит вам здесь");
    expect(plan?.text).not.toMatch(/позвон|удобное вам время/iu);
    expect(await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).toEqual({ status: "notified" });
    await settle();
    expect((await notes(id)).find(n => n.agentId === ownerA)?.tag).toMatch(/:no_call$/u);
    expect(await prisma.interaction.findFirst({ where: { clientId, notes: { contains: "не звонить" } } })).not.toBeNull();
  });

  it("Instagram без карточки «Хотим посмотреть, куда ехать? Звонить не надо, пишите потом» — номер не просим, звонок не обещаем", async () => {
    const id = await conversation("INSTAGRAM", `review4-ig-${runId}`);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: "Хотим посмотреть, куда ехать? Звонить не надо, пишите потом",
      focusPropertyId: propertyA }));
    expect(plan?.scenario).toBe("hot");
    expect(plan?.text).toContain("ответит вам здесь");
    // Номер офиса — можно («позвоните нам сами»); просьба номера и «агент позвонит» — нет.
    expect(plan?.text).not.toMatch(/оставьте|напишите номер|агент[^.]*позвонит/iu);
  });

  it("WhatsApp без карточки: «Хочу продать квартиру. Не звоните, пишите здесь» — звонок не обещан, заявка с пометкой «писать в чат»", async () => {
    const peer = waPeer();
    const id = await conversation("WHATSAPP", peer);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, channel: "WHATSAPP", peer, inputText: "Хочу продать квартиру. Не звоните, пишите здесь" }));
    expect(plan?.scenario).toBe("seller");
    expect(plan?.text).not.toMatch(/агент[^.]*позвонит|этот номер/iu);
    expect(plan?.remember).toBeNull();
    expect((await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).status).toBe("accepted");
    expect(await requirementsOf(id)).toContain("Просит не звонить");
  });
});

describe("№2: окно горячего — на разговор и объект", () => {
  it("горячее по объекту B после A доходит до хозяина B; повтор по A гасится; «агент в курсе» видит горячее по объекту", async () => {
    const id = await conversation("INSTAGRAM", `review4-hot-${runId}`);
    expect(await leadOnlyHumanNotifiedRecently(id, new Date(), [propertyA])).toBe(false);
    expect((await notifyLeadOnlyHandover({ conversationId: id, propertyId: propertyA, reason: "hot", summary: "хотим посмотреть A" })).status).toBe("notified");
    await settle();
    expect((await notifyLeadOnlyHandover({ conversationId: id, propertyId: propertyB, reason: "hot", summary: "хотим посмотреть B" })).status).toBe("notified");
    await settle();
    expect((await notifyLeadOnlyHandover({ conversationId: id, propertyId: propertyA, reason: "hot", summary: "куда ехать к A?" })).status).toBe("deduped");
    const sent = await notes(id);
    expect(sent.some(n => n.agentId === ownerA)).toBe(true);
    expect(sent.some(n => n.agentId === ownerB)).toBe(true);
    expect(await leadOnlyHumanNotifiedRecently(id, new Date(), [propertyB])).toBe(true);
  });
});

describe("№5: время звонка — только за сутки (ядро читает переписку с её временем)", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  it.each([[3 * 24 * 60 * 60_000, false], [60 * 60_000, true]] as const)("«позвоните вечером» %i мс назад → в пометке: %s", async (age, expected) => {
    const id = await conversation("INSTAGRAM", `review4-time-${age}-${runId}`, undefined,
      [{ role: "user", content: "Ищу квартиру, позвоните вечером", at: ago(age) }]);
    const plan = await planCustomerLeadOnlyTurn(input({ conversationId: id, inputText: `Ищу квартиру, мой номер 93 ${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      sentTexts: ["Понял вас. Оставьте, пожалуйста, номер телефона, агент перезвонит."] }));
    expect(plan?.intake).not.toBeNull();
    expect((await runCustomerLeadOnlyIntake(plan!.intake!, { force: true })).status).toBe("accepted");
    expect((await requirementsOf(id)).includes("Когда звонить: «Ищу квартиру, позвоните вечером»")).toBe(expected);
  });
});

describe("№5: сбой записи памяти не откатывает ответ бота", () => {
  it("сопутствующая запись упала — реплика в переписке, ошибка возвращена; удачная — обе записаны", async () => {
    const id = await conversation("INSTAGRAM", `review4-append-${runId}`);
    const failed = await appendConversationMessages(id, [{ role: "assistant", content: "Ответ при сбое памяти" }],
      async (tx) => { await tx.$executeRaw`SELECT * FROM "НетТакойТаблицы"`; });
    expect(failed.alongsideError).toBeTruthy();
    const ok = await appendConversationMessages(id, [{ role: "assistant", content: "Ответ с памятью" }],
      async (tx) => { await tx.botConversation.update({ where: { id }, data: { leadOnlyPending: { version: 1, scenario: "buyer", propertyId: null,
        askedAt: new Date().toISOString() } } }); });
    expect(ok.alongsideError).toBeNull();
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { messages: true, leadOnlyPending: true } });
    expect((row.messages as Array<{ content: string }>).map(m => m.content)).toEqual(["Ответ при сбое памяти", "Ответ с памятью"]);
    expect(row.leadOnlyPending).toMatchObject({ scenario: "buyer" });
  });
});
