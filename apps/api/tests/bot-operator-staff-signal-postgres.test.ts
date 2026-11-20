import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Общие настройки базы этот файл НЕ меняет (соседние файлы идут параллельно на той же базе): режим «только заявки» и
// «Бот отвечает сам» подменены в их единственных дверях чтения (importOriginal: остальной модуль живой, audit:mocks).
const mocks = vi.hoisted(() => ({ push: vi.fn(async () => 1), pushMany: vi.fn(async () => 1), log: vi.fn(async () => undefined),
  leadOnlyOn: true, answersItself: false }));
vi.mock("../src/push.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: mocks.push, sendPushToAgents: mocks.pushMany }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.log }));
vi.mock("../src/lib/leadOnlyConfig.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/leadOnlyConfig.js")>()),
  leadOnlyQuietBeforeLead: async () => mocks.leadOnlyOn }));
vi.mock("../src/lib/botAnswersItself.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/botAnswersItself.js")>()),
  loadBotAnswersItself: async () => mocks.answersItself }));

const { prisma } = await import("../src/db.js");
const { alertClientWaiting } = await import("../src/lib/clientWaitingAlert.js");
const { resolveAdTopic } = await import("../src/lib/adAttribution.js");

/**
 * ЖАЛОБА И ГРУБОСТЬ — ЧЕЛОВЕК ПРАВДА УЗНАЁТ (расхождение №2 проверки #311, живой диалог Instagram 19.11.2026).
 *
 * Клиент: «По этим номерам никто не отвечает» → бот: «Ваше сообщение увидит руководитель.» (SPEC, случай 26). Сигнал
 * оператора шёл дверью «клиент ждёт» поводом follow_up, а её правило режима «только заявки» (до карточки людей не
 * беспокоим, решение владельца 13.11) этот повод глушило. Прежний тест staffRequired (bot-answers-itself-postgres) этого не
 * видел: он выключает режим «только заявки», а на проде режим включён. Здесь режим включён (подменой двери чтения).
 * Пути ядра и старого бота — в bot-operator-core-postgres и bot-operator-legacy-postgres.
 */
const runId = `sig-${randomUUID().slice(0, 8)}`;
const convIds: string[] = [];
const clientIds: string[] = [];
const adIds: string[] = [];
let agentId = "";

async function chat(opts: { card?: "agent" } = {}) {
  let clientId: string | null = null;
  if (opts.card) {
    const client = await prisma.client.create({ data: { fullName: `Клиент ${runId}-${convIds.length}`, source: "INSTAGRAM",
      phone: `+99294${String(Date.now() + convIds.length).slice(-7)}`, assignedAgentId: agentId } });
    clientId = client.id; clientIds.push(client.id);
  }
  const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `${runId}-${convIds.length}`,
    lastMessageAt: new Date(), messages: [{ role: "user", content: "По этим номерам никто не отвечает", at: new Date(Date.now() - 30_000).toISOString() }],
    ...(clientId ? { clientId } : {}) } });
  convIds.push(conv.id);
  return conv.id;
}
const leadershipAlerts = (convId: string) => prisma.pendingDirectorAlert.findMany({ where: { tag: `client-waiting-${convId}` },
  select: { title: true, body: true, recipientRoles: true, urgent: true, excludeAgentId: true } });

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: `Агент ${runId}`, phone: `+99295${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x" } })).id;
});
beforeEach(() => { vi.clearAllMocks(); mocks.leadOnlyOn = true; mocks.answersItself = false; });
afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: convIds.map((id) => `client-waiting-${id}`) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
});

describe("дверь «клиент ждёт»: решение оператора звать человека не глушит тишина режима до заявки", () => {
  it("жалоба без карточки — руководству, обычной срочностью, с фразой клиенту из набора; обычный follow_up до заявки — тишина", async () => {
    const quiet = await chat();
    expect(await alertClientWaiting({ conversationId: quiet, trigger: "follow_up", staffRequired: true })).toBe("excluded");
    const complaint = await chat();
    expect(await alertClientWaiting({ conversationId: complaint, trigger: "follow_up", staffRequired: true, staffReason: "complaint" })).toBe("director");
    const [alert] = await leadershipAlerts(complaint);
    // urgent=false: колокольчик сразу, пуш — в часы тревог; ночью не будит (lib/directorAlertQueue.ts).
    expect(alert).toMatchObject({ title: "💬 Жалоба клиента", recipientRoles: ["DIRECTOR", "ADMIN"], urgent: false });
    expect(alert!.body).toContain("клиент жалуется. Бот ответил «Ваше сообщение увидит руководитель.» и дальше молчит.");
  });

  it("жалоба по клиенту с агентом — агенту пушем И копия руководству (без дубля агенту)", async () => {
    const id = await chat({ card: "agent" });
    expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", staffReason: "complaint" })).toBe("agent");
    expect(mocks.push).toHaveBeenCalledWith(agentId, expect.objectContaining({ title: "💬 Жалоба клиента" }));
    expect(await leadershipAlerts(id)).toMatchObject([{ title: "💬 Жалоба клиента", urgent: false, excludeAgentId: agentId }]);
  });

  it("грубость: без карточки — руководству (обычной срочностью); с агентом — только агенту, как раньше", async () => {
    const noCard = await chat();
    expect(await alertClientWaiting({ conversationId: noCard, trigger: "follow_up", staffReason: "rude" })).toBe("director");
    const [alert] = await leadershipAlerts(noCard);
    expect(alert).toMatchObject({ urgent: false });
    expect(alert!.body).toContain("клиент написал грубо. Бот ответил «Понимаю вас, дальше с вами продолжит наш сотрудник.»");
    const withAgent = await chat({ card: "agent" });
    expect(await alertClientWaiting({ conversationId: withAgent, trigger: "follow_up", staffReason: "rude" })).toBe("agent");
    expect(await leadershipAlerts(withAgent)).toHaveLength(0);
  });

  it("прежний неотвеченный сигнал «агент уточнит» жалобу не глушит; «Бот отвечает сам» — тоже", async () => {
    const id = await chat();
    await prisma.botConversation.update({ where: { id }, data: { silenceAlertFor: new Date(Date.now() - 3_600_000) } });
    mocks.answersItself = true;
    expect(await alertClientWaiting({ conversationId: id, trigger: "follow_up", staffReason: "complaint", since: new Date() })).toBe("director");
  });

  it("две жалобы на одну реплику одновременно — один сигнал (ключ эпизода — время реплики)", async () => {
    const id = await chat();
    const since = new Date(Date.now() - 30_000);
    const outcomes = await Promise.all([1, 2].map(() => alertClientWaiting({ conversationId: id, trigger: "follow_up", staffReason: "complaint", since })));
    expect(outcomes.sort()).toEqual(["already", "director"]);
    expect(await leadershipAlerts(id)).toHaveLength(1);
  });
});

describe("тема рекламы: реклама самого агентства — не «объект» (корень расхождения №1)", () => {
  it("реклама агентства (Ad.brand) — темы нет; обычная реклама без объекта — «объект», как раньше; вакансия — «вакансия»", async () => {
    const brand = await prisma.ad.create({ data: { externalId: `${runId}-brand`, name: "Кампания с целью «Сообщения»", caption: "Позвоните нам", brand: true } });
    const listing = await prisma.ad.create({ data: { externalId: `${runId}-listing`, name: "Кампания с целью «Сообщения»", caption: "3 комнаты, Сино" } });
    const vacancy = await prisma.ad.create({ data: { externalId: `${runId}-job`, name: "Вакансия менеджер по продажам", brand: true } });
    adIds.push(brand.id, listing.id, vacancy.id);
    expect(await resolveAdTopic({ adId: brand.externalId, adRef: "Позвоните нам" })).toBeUndefined();
    expect(await resolveAdTopic({ adId: brand.externalId })).toBeUndefined();
    expect(await resolveAdTopic({ adId: listing.externalId, adRef: "3 комнаты, Сино" })).toBe("property");
    expect(await resolveAdTopic({ adId: listing.externalId })).toBe("property");
    expect(await resolveAdTopic({ adId: vacancy.externalId })).toBe("job");
  });
});
