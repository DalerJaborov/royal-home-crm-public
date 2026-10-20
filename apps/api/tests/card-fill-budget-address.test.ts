import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * КАРТОЧКА НЕ ЗАПОЛНЯЛАСЬ, ХОТЯ ДАННЫЕ БЫЛИ (живой случай 13.08.2026, клиент Жасмин).
 *
 * В заметках карточки стояло «интересуется 2-комн. квартирой 60 м² на 8 этаже в
 * районе ДОК (кинотеатр Зебунисо) за 700 000 сомони», а поля «Бюджет» и «Адрес»
 * были ПУСТЫМИ. Район и комнаты при этом заполнились. То есть модель всё расслышала
 * и сложила в свободный текст, но по структурным полям не разложила — а подбор
 * объектов идёт именно по ним (GET /clients/:id/match), и клиент не получил ни
 * одного подходящего варианта.
 *
 * Две причины, обе стережёт этот файл:
 *  1. поля address в разборе не было вовсе — ориентир некуда было положить;
 *  2. схема просила ВИЛКУ (нижняя/верхняя граница), а клиент называет одну сумму;
 *     под «нижнюю» она не подходит, под «верхнюю» модель её не относила, и при
 *     запрете додумывать бюджет оставался пустым.
 *
 * Плюс два стыка, на которых сумма терялась молча: число, пришедшее строкой, и
 * карточка, которую агент перевёл в доллары.
 */

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));
// Оценка клиента к разбору карточки отношения не имеет, а лишний вызов модели
// в тесте только замедлял бы прогон. `importOriginal` — иначе мок стирает и
// `SCORABLE_CLIENT_STATUSES` (используется в lib/clientAutopilot.ts на уровне
// модуля), которого здесь никто не подменяет.
vi.mock("../src/ai/scoring.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scoreClient: async () => null,
}));

const { prisma } = await import("../src/db.js");
const { buildCardFillSuggestion } = await import("../src/ai/cardFill.js");
const { runClientAutopilot } = await import("../src/lib/clientAutopilot.js");
const { loadMoneyContext } = await import("../src/lib/money.js");

const runId = Date.now();
const districtName = `ДОК-тест-${runId}`;
let agentId = "";
let districtId = "";
const clientIds: string[] = [];

async function makeClient(name: string, data: Record<string, unknown> = {}) {
  const client = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9921${clientIds.length}${runId}`,
      source: "WHATSAPP",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      ...data,
    },
  });
  clientIds.push(client.id);
  return client.id;
}

/** Переписка клиента с ботом. Без неё разбор не запускается вовсе — платить за
 *  вызов модели, когда клиент ничего не писал, незачем. */
async function attachChat(clientId: string, text: string) {
  await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-${clientId}`,
      clientId,
      messages: [{ role: "user", content: text }] as never,
      leadDraft: { stage: "chatting" } as never,
    },
  });
}

function cardOf(clientId: string) {
  return prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    select: { budgetMin: true, budgetMax: true, address: true, currency: true },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: districtName } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент карточки ${runId}`, phone: `+992919${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue(null);
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Разбор переписки: одна сумма и ориентир", () => {
  it("названную сумму кладёт в потолок бюджета, а ориентир — в адрес", async () => {
    const clientId = await makeClient("Жасмин");
    await attachChat(clientId, "2-хонага дар ДОК, назди кинотеатри Зебунисо, то 700 ҳазор");
    callAiText.mockResolvedValue({
      budgetMax: 700000,
      address: "ДОК, напротив кинотеатра Зебунисо",
      districtName,
      rooms: 2,
      notes: "Ищет 2-комнатную квартиру",
    });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.budgetMax).toBe(700000);
    // Потолок без нижней границы — это НЕ дыра: подбор умеет искать «до суммы»,
    // а выдуманный минимум отрезал бы клиенту всё, что дешевле.
    expect(suggestion.budgetMin).toBeNull();
    expect(suggestion.address).toBe("ДОК, напротив кинотеатра Зебунисо");
  });

  it("сумму, пришедшую строкой, не выбрасывает", async () => {
    const clientId = await makeClient("Сумма строкой");
    await attachChat(clientId, "бюджет 700 000 сомони");
    // Схема просит число, но модели время от времени отдают его строкой — раньше
    // такая сумма молча пропадала, и бюджет в карточке оставался пустым.
    callAiText.mockResolvedValue({ budgetMax: "700 000" });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.budgetMax).toBe(700000);
  });

  it("одинаковые границы схлопывает в потолок", async () => {
    const clientId = await makeClient("Ровно 700");
    await attachChat(clientId, "700 ҳазор");
    callAiText.mockResolvedValue({ budgetMin: 700000, budgetMax: 700000 });

    const suggestion = await buildCardFillSuggestion(clientId);

    // Вилка 700 000–700 000 после допуска подбора ±10% означала бы «только
    // 630–770 тысяч»: квартира за 500 000 клиенту с таким потолком не показалась бы.
    expect(suggestion.budgetMin).toBeNull();
    expect(suggestion.budgetMax).toBe(700000);
  });

  it("настоящую вилку оставляет как есть", async () => {
    const clientId = await makeClient("Вилка");
    await attachChat(clientId, "от 300 до 500 тысяч");
    callAiText.mockResolvedValue({ budgetMin: 300000, budgetMax: 500000 });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.budgetMin).toBe(300000);
    expect(suggestion.budgetMax).toBe(500000);
  });

  it("мусор вместо адреса в карточку не попадает", async () => {
    const clientId = await makeClient("Адрес мусором");
    await attachChat(clientId, "салом");
    callAiText.mockResolvedValue({ address: "   " });

    const suggestion = await buildCardFillSuggestion(clientId);

    expect(suggestion.address).toBeNull();
  });
});

describe("Автозаполнение карточки", () => {
  it("записывает бюджет и адрес в пустую карточку", async () => {
    const clientId = await makeClient("Пустая карточка");
    await attachChat(clientId, "то 700 ҳазор, назди кинотеатри Зебунисо");
    callAiText.mockResolvedValue({
      budgetMax: 700000,
      address: "напротив кинотеатра Зебунисо",
      districtName,
    });

    const result = await runClientAutopilot(clientId, "client_message");

    expect(result.filled).toContain("budgetMax");
    expect(result.filled).toContain("address");
    const card = await cardOf(clientId);
    expect(Number(card.budgetMax)).toBe(700000);
    expect(card.address).toBe("напротив кинотеатра Зебунисо");
  });

  it("не затирает то, что человек вписал руками", async () => {
    const clientId = await makeClient("Правка агента", {
      budgetMax: 400000,
      address: "Рудаки 55, кв. 12",
    });
    await attachChat(clientId, "то 700 ҳазор, назди Зебунисо");
    callAiText.mockResolvedValue({ budgetMax: 700000, address: "напротив кинотеатра Зебунисо" });

    await runClientAutopilot(clientId, "client_message");

    // Агент, поговоривший с клиентом, знает больше, чем модель, читающая переписку.
    const card = await cardOf(clientId);
    expect(Number(card.budgetMax)).toBe(400000);
    expect(card.address).toBe("Рудаки 55, кв. 12");
  });

  it("дописывает настоящее имя поверх запасного «Покупатель №…»", async () => {
    const clientId = await makeClient("__placeholder__");
    // makeClient всегда даёт fullName вида "__placeholder__ 123" — переписываем
    // на настоящую запасную форму, которую и проверяет autopilot.
    await prisma.client.update({ where: { id: clientId }, data: { fullName: "Покупатель №0042" } });
    await attachChat(clientId, "Меня зовут Дилноза, ищу 2-комнатную");
    callAiText.mockResolvedValue({ clientName: "Дилноза", rooms: 2 });

    const result = await runClientAutopilot(clientId, "client_message");

    expect(result.filled).toContain("fullName");
    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { fullName: true } });
    expect(card.fullName).toBe("Дилноза");
  });

  it("не трогает уже настоящее имя, даже если модель что-то расслышала", async () => {
    const clientId = await makeClient("Фарход");
    await attachChat(clientId, "то 500 ҳазор");
    callAiText.mockResolvedValue({ clientName: "Другое Имя", budgetMax: 500000 });

    await runClientAutopilot(clientId, "client_message");

    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { fullName: true } });
    expect(card.fullName).toBe(`Фарход ${runId}`);
  });

  it("похожее на мусор в clientName в карточку не попадает", async () => {
    const clientId = await makeClient("__placeholder2__");
    await prisma.client.update({ where: { id: clientId }, data: { fullName: "Продавец №0007" } });
    await attachChat(clientId, "салом");
    callAiText.mockResolvedValue({ clientName: "boss_____00065" });

    const suggestion = await buildCardFillSuggestion(clientId);
    expect(suggestion.clientName).toBeNull();
  });

  it("в долларовую карточку кладёт доллары, а не сомони", async () => {
    const clientId = await makeClient("Бюджет в долларах", { currency: "USD" });
    await attachChat(clientId, "бюджет 50 тысяч долларов");
    // Разбор ВСЕГДА отдаёт сомони (так написан промт), а карточка ведётся в валюте,
    // которую выбрал агент. Без пересчёта в неё легло бы «700 000 долларов».
    callAiText.mockResolvedValue({ budgetMax: 700000 });

    await runClientAutopilot(clientId, "client_message");

    const { usdToTjs } = await loadMoneyContext();
    const card = await cardOf(clientId);
    expect(Number(card.budgetMax)).toBe(Math.round(700000 / usdToTjs));
  });
});
