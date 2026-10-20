import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Факты об объекте продавца (владелец 21.09.2026): фоновый разбор переписки и
 * звонков в накопленный снимок, который экраны читают без вызова ИИ.
 *
 * Главное, что здесь держится, — экономия: второй прогон без новых реплик не
 * зовёт модель вовсе, в модель идут только новые реплики, отказ модели (402)
 * не портит уже накопленное. Стиль и подмена callAiText — как в
 * tests/property-draft.test.ts.
 */

const aiCalls: { user: string; system: string; preferModel?: string }[] = [];
let aiReply: Record<string, unknown> | null = null;
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: async (params: { user?: string; system: string; preferModel?: string }) => {
    aiCalls.push({ user: params.user ?? "", system: params.system, preferModel: params.preferModel });
    return aiReply;
  },
}));

const { prisma } = await import("../src/db.js");
const { refreshSellerFacts } = await import("../src/ai/sellerFactsExtract.js");
const { getSellerObjectFacts, enqueueSellerFactsRefresh, sellerFactsDedupeKey } = await import(
  "../src/lib/sellerFacts.js"
);

const runId = Date.now();
let agentId = "";
let districtId = "";
const districtName = `Факты-продавца-${runId}`;
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function makeClient(name: string, kind: "SELLER" | "BUYER" = "SELLER") {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9928${clientIds.length}${runId}`,
      status: "NEW",
      kind,
      workStatus: "ACTIVE",
      source: "WEBSITE",
      assignedAgentId: agentId,
      currency: "TJS",
      acceptedAt: new Date(),
    } as never,
  });
  clientIds.push(c.id);
  return c.id;
}

type Msg = { role: "user" | "assistant"; content: string; at?: string };

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

async function attachConversation(clientId: string, messages: Msg[]) {
  return prisma.botConversation.create({
    data: { channel: "WHATSAPP", subscriberId: `sub-${clientId}`, clientId, messages: messages as never },
  });
}

async function setMessages(conversationId: string, messages: Msg[]) {
  await prisma.botConversation.update({ where: { id: conversationId }, data: { messages: messages as never } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: districtName } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент фактов продавца ${runId}`, phone: `+992936${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterEach(() => {
  aiCalls.length = 0;
  aiReply = null;
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({
    where: { dedupeKey: { in: clientIds.flatMap((id) => [sellerFactsDedupeKey(id), `${sellerFactsDedupeKey(id)}:next`]) } },
  });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Факты об объекте продавца — разбор", () => {
  it("извлекает факты из реплик продавца дешёвой моделью; бот источником не считается", async () => {
    const clientId = await makeClient("Первый разбор");
    await attachConversation(clientId, [
      { role: "assistant", content: "Сколько комнат в квартире?", at: minutesAgo(30) },
      { role: "user", content: "трёшка, 82 мкр, 85 тыс $", at: minutesAgo(29) },
      { role: "user", content: "[📷]", at: minutesAgo(28) },
    ]);
    aiReply = {
      type: "APARTMENT",
      rooms: 3,
      price: "85000",
      currency: "USD",
      districtName,
      address: "82 мкр",
    };

    expect(await refreshSellerFacts(clientId)).toBe("updated");
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].preferModel).toBeTruthy();
    // Вопрос бота — только контекстом к реплике, плейсхолдер фото в модель не идёт.
    expect(aiCalls[0].user).toContain("ПРОДАВЕЦ: трёшка, 82 мкр, 85 тыс $");
    expect(aiCalls[0].user).toContain("(вопрос: Сколько комнат в квартире?)");
    expect(aiCalls[0].user).not.toContain("[📷]");

    const facts = await getSellerObjectFacts(clientId);
    expect(facts).toMatchObject({
      type: "APARTMENT",
      rooms: 3,
      price: 85000,
      currency: "USD",
      districtId,
      address: "82 мкр",
    });
  });

  it("второй прогон без новых сообщений — ноль обращений к ИИ", async () => {
    const clientId = await makeClient("Без нового");
    await attachConversation(clientId, [{ role: "user", content: "Продаю дом, 6 соток", at: minutesAgo(20) }]);
    aiReply = { type: "HOUSE", landAreaSotka: 6 };
    expect(await refreshSellerFacts(clientId)).toBe("updated");
    expect(aiCalls).toHaveLength(1);

    aiCalls.length = 0;
    expect(await refreshSellerFacts(clientId)).toBe("nothing-new");
    expect(aiCalls).toHaveLength(0);
    expect((await getSellerObjectFacts(clientId))?.landAreaSotka).toBe(6);
  });

  it("инкрементально: в модель идут прошлые факты и только новые реплики; незатронутые поля сохраняются", async () => {
    const clientId = await makeClient("Инкремент");
    // Одна и та же реплика (тот же `at`) в обоих снимках переписки: minutesAgo(),
    // вызванный заново, дал бы метку позже границы, и старая реплика ушла бы как новая.
    const old: Msg = { role: "user", content: "Квартира 2 комнаты, 5 этаж", at: minutesAgo(40) };
    const conv = await attachConversation(clientId, [old]);
    aiReply = { type: "APARTMENT", rooms: 2, floor: 5 };
    await refreshSellerFacts(clientId);

    await setMessages(conv.id, [old, { role: "user", content: "цена 450 000 сомони", at: minutesAgo(1) }]);
    aiCalls.length = 0;
    // Модель вернула только изменившееся — комнаты и этаж обязаны остаться.
    aiReply = { price: 450000, currency: "TJS" };
    expect(await refreshSellerFacts(clientId)).toBe("updated");

    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].user).toContain("цена 450 000 сомони");
    expect(aiCalls[0].user).not.toContain("ПРОДАВЕЦ: Квартира 2 комнаты");
    expect(aiCalls[0].user).toContain('"rooms":2');

    expect(await getSellerObjectFacts(clientId)).toMatchObject({ rooms: 2, floor: 5, price: 450000, currency: "TJS" });
  });

  it("отказ модели (402) не портит накопленное и не сдвигает границу — реплики разберутся потом", async () => {
    const clientId = await makeClient("Отказ ИИ");
    const old: Msg = { role: "user", content: "3 комнаты", at: minutesAgo(50) };
    const conv = await attachConversation(clientId, [old]);
    aiReply = { rooms: 3 };
    await refreshSellerFacts(clientId);
    const before = await prisma.sellerObjectFacts.findUniqueOrThrow({ where: { clientId } });

    await setMessages(conv.id, [old, { role: "user", content: "евроремонт", at: minutesAgo(2) }]);
    aiReply = null;
    expect(await refreshSellerFacts(clientId)).toBe("ai-unavailable");
    const after = await prisma.sellerObjectFacts.findUniqueOrThrow({ where: { clientId } });
    expect(after.facts).toEqual(before.facts);
    expect(after.factsSourceUpTo?.getTime()).toBe(before.factsSourceUpTo?.getTime());
    expect(after.factsInputHash).toBe(before.factsInputHash);

    // Модель ожила — та же реплика уходит в разбор.
    aiCalls.length = 0;
    aiReply = { condition: "EXCELLENT" };
    expect(await refreshSellerFacts(clientId)).toBe("updated");
    expect(aiCalls[0].user).toContain("евроремонт");
    expect(await getSellerObjectFacts(clientId)).toMatchObject({ rooms: 3, condition: "EXCELLENT" });
  });

  it("продавец перешёл к другому объекту — набор начинается заново, без смеси", async () => {
    const clientId = await makeClient("Другой объект");
    const old: Msg = { role: "user", content: "квартира 3 комнаты, 7 этаж", at: minutesAgo(60) };
    const conv = await attachConversation(clientId, [old]);
    aiReply = { type: "APARTMENT", rooms: 3, floor: 7 };
    await refreshSellerFacts(clientId);

    await setMessages(conv.id, [old, { role: "user", content: "а ещё участок 8 соток продаю", at: minutesAgo(1) }]);
    aiReply = { newObject: true, type: "LAND", landAreaSotka: 8 };
    await refreshSellerFacts(clientId);

    expect(await getSellerObjectFacts(clientId)).toMatchObject({
      type: "LAND",
      landAreaSotka: 8,
      rooms: null,
      floor: null,
    });
  });

  it("факты, из которых уже завели объект, в следующий объект не подставляются", async () => {
    const clientId = await makeClient("Объект заведён");
    await attachConversation(clientId, [{ role: "user", content: "2 комнаты", at: minutesAgo(30) }]);
    aiReply = { rooms: 2 };
    await refreshSellerFacts(clientId);
    expect(await getSellerObjectFacts(clientId)).not.toBeNull();

    const property = await prisma.property.create({
      data: {
        title: `Объект продавца ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        sellerClientId: clientId,
      },
    });
    propertyIds.push(property.id);

    expect(await getSellerObjectFacts(clientId)).toBeNull();
    // Старые реплики (до заведения объекта) повторно в модель не идут.
    aiCalls.length = 0;
    expect(await refreshSellerFacts(clientId)).toBe("nothing-new");
    expect(aiCalls).toHaveLength(0);
  });

  it("покупатель не разбирается и не ставится в очередь", async () => {
    const clientId = await makeClient("Покупатель", "BUYER");
    await attachConversation(clientId, [{ role: "user", content: "ищу 2 комнаты", at: minutesAgo(5) }]);
    expect(await refreshSellerFacts(clientId)).toBe("not-seller");
    expect(aiCalls).toHaveLength(0);

    await enqueueSellerFactsRefresh(clientId);
    expect(await prisma.backgroundJob.findUnique({ where: { dedupeKey: sellerFactsDedupeKey(clientId) } })).toBeNull();
  });
});

describe("Факты об объекте продавца — дребезг постановки", () => {
  it("первая реплика ставит разбор на +15 минут, следующая отодвигает тот же, а не заводит второй", async () => {
    const clientId = await makeClient("Дребезг");
    const key = sellerFactsDedupeKey(clientId);

    const t0 = Date.now();
    await enqueueSellerFactsRefresh(clientId);
    const first = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(first.type).toBe("seller-facts");
    expect(first.status).toBe("PENDING");
    expect(first.runAt.getTime()).toBeGreaterThanOrEqual(t0 + 14 * 60_000);

    await new Promise((r) => setTimeout(r, 20));
    await enqueueSellerFactsRefresh(clientId);
    const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey: { startsWith: key } } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runAt.getTime()).toBeGreaterThan(first.runAt.getTime());
  });
});
