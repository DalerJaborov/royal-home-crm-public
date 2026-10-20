import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * search_properties В АССИСТЕНТЕ: ПОТОЛОК ЦЕНЫ С УЧЁТОМ ВАЛЮТЫ (CHANNEL-NEW-41, аудит 04.10.2026).
 *
 * Инструмент фильтровал price <= maxPrice по сырой колонке, а Property.price лежит
 * в своей валюте объекта. «До 200 000 сомони» пропускало объект за 100 000 USD
 * (это миллион сомони), а бюджет в долларах цеплял сомонёвые объекты по номиналу.
 * Теперь бюджет в сомони по умолчанию и пересчёт по курсу, как в подборе бота
 * (lib/propertyMatch.ts). Курс подменён: 1 USD = 10 TJS.
 */

vi.mock("../src/lib/money.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/money.js")>()),
  loadMoneyContext: vi.fn(async () => ({ usdToTjs: 10 })),
}));
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  resolveGeminiKey: vi.fn(),
  callGemini: vi.fn(),
  callGeminiTools: vi.fn(),
}));

const { prisma } = await import("../src/db.js");
const { runTool } = await import("../src/ai/assistant.js");

const runId = Date.now();
let districtId: string;
const ids: Record<string, string> = {};

const actor = {
  id: "assistant-price-actor",
  role: "DIRECTOR",
  canViewAllClients: true,
  canViewPhone: true,
  canViewReports: true,
  canViewFinance: true,
  canViewAllDeals: true,
};

async function make(key: string, price: number, currency: "TJS" | "USD") {
  const p = await prisma.property.create({
    data: {
      title: `Цена-${key}-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price,
      currency,
      districtId,
      address: `Тестовая ${key}`,
      condition: "GOOD",
    },
  });
  ids[key] = p.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Ассистент-цена-${runId}` } })).id;
  await make("tjs150k", 150000, "TJS"); // 150 000 сомони
  await make("usd100k", 100000, "USD"); // 1 000 000 сомони
  await make("usd15k", 15000, "USD"); // 150 000 сомони
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

const search = async (input: Record<string, unknown>) =>
  ((await runTool("search_properties", { districtName: `Ассистент-цена-${runId}`, ...input }, actor as never)) as Array<{
    id: string;
  }>).map((p) => p.id);

describe("search_properties: maxPrice и валюта", () => {
  it("до 200 000 сомони: объект за 100 000 USD не проходит, равные по сомони проходят", async () => {
    const found = await search({ maxPrice: 200000 });
    expect(found).toContain(ids.tjs150k);
    expect(found).toContain(ids.usd15k);
    expect(found).not.toContain(ids.usd100k);
  });

  it("бюджет в долларах: до 20 000 USD цепляет 15 000 USD и 150 000 сомони, но не 100 000 USD", async () => {
    const found = await search({ maxPrice: 20000, currency: "USD" });
    expect(found).toContain(ids.usd15k);
    expect(found).toContain(ids.tjs150k);
    expect(found).not.toContain(ids.usd100k);
  });
});
