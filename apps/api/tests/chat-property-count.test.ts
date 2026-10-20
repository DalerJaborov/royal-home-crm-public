import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const callAiText = vi.fn();
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { prisma } = await import("../src/db.js");
const { analyzeMessageForPropertyCounts } = await import("../src/ai/chatPropertyCount.js");

/**
 * ЧИСЛО ОБЪЕКТОВ ИЗ ПЕРЕПИСКИ — ФОНОВЫЙ РАЗБОР (владелец 06.09.2026, разбор
 * слепых зон п.3 + «а если хочет купить несколько»).
 *
 * Проверяем: дешёвый предфильтр не зовёт ИИ на сообщения без намёка на число;
 * продавец и покупатель пишутся в РАЗНЫЕ поля карточки; новое число заменяет
 * прежнее, а не складывается.
 */

const runId = Date.now();
let clientIds: string[] = [];

async function makeClient(kind: "SELLER" | "BUYER" = "SELLER") {
  const c = await prisma.client.create({
    data: {
      fullName: `Чат-число ${runId}-${clientIds.length}`,
      phone: `+992977${runId}${clientIds.length}`,
      source: "INSTAGRAM",
      kind,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeEach(() => {
  callAiText.mockClear();
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

describe("analyzeMessageForPropertyCounts", () => {
  it("сообщение без намёка на число — ИИ не вызывается вовсе", async () => {
    const client = await makeClient();
    await analyzeMessageForPropertyCounts(client.id, "Спасибо, буду ждать звонка");
    expect(callAiText).not.toHaveBeenCalled();

    const unchanged = await prisma.client.findUnique({ where: { id: client.id } });
    expect(unchanged?.sellerDeclaredPropertyCount).toBeNull();
  });

  it("таджикские формы количества проходят предфильтр, пустые реплики — нет (CHANNEL-NEW-25)", async () => {
    const client = await makeClient("SELLER");
    callAiText.mockResolvedValue({});
    for (const text of ["Ду хона дорам, ҳар дуяшро мефурӯшам", "2 хона дорам", "Се манзил дорам, фурӯхтан мехоҳам", "Якчанд хона дорам"]) {
      callAiText.mockClear();
      await analyzeMessageForPropertyCounts(client.id, text);
      expect(callAiText, text).toHaveBeenCalledTimes(1);
    }
    for (const text of ["ок", "хуб", "Рахмат, ташаккур", "Салом"]) {
      callAiText.mockClear();
      await analyzeMessageForPropertyCounts(client.id, text);
      expect(callAiText, text).not.toHaveBeenCalled();
    }
  });

  it("продавец называет число в переписке — пишется в sellerDeclaredPropertyCount", async () => {
    const client = await makeClient("SELLER");
    callAiText.mockResolvedValueOnce({ sellerPropertyCount: 2 });

    await analyzeMessageForPropertyCounts(client.id, "У меня две квартиры на продажу, обе в Сино");
    expect(callAiText).toHaveBeenCalledTimes(1);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBe(2);
    expect(updated?.sellerDeclaredPropertyCountAt).not.toBeNull();
    expect(updated?.buyerDesiredPropertyCount).toBeNull();
  });

  it("покупатель хочет купить несколько — пишется в buyerDesiredPropertyCount, не в sellerDeclaredPropertyCount", async () => {
    const client = await makeClient("BUYER");
    callAiText.mockResolvedValueOnce({ buyerPropertyCount: 2 });

    await analyzeMessageForPropertyCounts(client.id, "Хочу купить две квартиры — себе и под сдачу");

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.buyerDesiredPropertyCount).toBe(2);
    expect(updated?.sellerDeclaredPropertyCount).toBeNull();
  });

  it("большее новое число заменяет прежнее (не складывается)", async () => {
    const client = await makeClient("SELLER");
    callAiText.mockResolvedValueOnce({ sellerPropertyCount: 2 });
    await analyzeMessageForPropertyCounts(client.id, "У меня две квартиры на продажу");

    callAiText.mockResolvedValueOnce({ sellerPropertyCount: 3 });
    await analyzeMessageForPropertyCounts(client.id, "На самом деле три объекта, забыл про дом");

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBe(3);
  });

  /**
   * Тот же класс бага, что и в звонках (ai/callAnalysis.ts, живой случай
   * Ахтам/Ноза 18.09.2026): одно сообщение почти всегда про ОДИН из уже
   * названных объектов — меньшее число не должно тихо понижать уже известное
   * большее.
   */
  it("меньшее число из следующего сообщения НЕ понижает уже известное большее", async () => {
    const client = await makeClient("SELLER");
    callAiText.mockResolvedValueOnce({ sellerPropertyCount: 4 });
    await analyzeMessageForPropertyCounts(client.id, "Продаю четыре квартиры в разных районах");

    callAiText.mockResolvedValueOnce({ sellerPropertyCount: 1 });
    await analyzeMessageForPropertyCounts(client.id, "По той квартире на Сино, где 2 комнаты, готов снизить цену");

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBe(4);
  });

  it("ИИ ничего не нашёл (пустой ответ) — поле не трогается", async () => {
    const client = await makeClient("SELLER");
    callAiText.mockResolvedValueOnce({});

    await analyzeMessageForPropertyCounts(client.id, "У меня несколько вопросов по документам");

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated?.sellerDeclaredPropertyCount).toBeNull();
  });

  it("без clientId — ничего не делает, не падает", async () => {
    await expect(analyzeMessageForPropertyCounts(null, "У меня три квартиры")).resolves.toBeUndefined();
    expect(callAiText).not.toHaveBeenCalled();
  });
});
