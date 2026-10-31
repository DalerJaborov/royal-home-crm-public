import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * search_properties + semanticQuery (ai/assistant.ts) — тумблер Settings.
 * semanticSearchEnabled (по умолчанию выключен, пункт 3 очереди ИИ, 23.08.2026).
 *
 * semanticPropertySearch мокается целиком: тест про то, ЧТО делает runTool с её
 * результатом (зовёт только за тумблером, переставляет структурную выдачу по её
 * рангу), а не про саму семантику — та проверена отдельно, semantic-property-
 * search.test.ts. geminiClient не участвует вовсе: runTool вызывается напрямую,
 * тем же приёмом, что и в ai-assistant-tools.test.ts.
 */

const semanticPropertySearch = vi.fn();
vi.mock("../src/lib/embeddingSearch.js", () => ({ semanticPropertySearch }));

const { prisma } = await import("../src/db.js");
const { runTool } = await import("../src/ai/assistant.js");
// Тумблеры помощника кэшируются на 15 с (ai/assistant/runtime.ts) — после каждого
// переключения в базе кэш сбрасывается, иначе runTool увидел бы прошлое значение.
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");

const runId = Date.now();
let districtId: string;
let idOld: string;
let idMid: string;
let idNew: string;

const actor = {
  id: "semantic-search-test-actor",
  role: "AGENT",
  canViewAllClients: false,
  canViewPhone: false,
  canViewReports: false,
  canViewFinance: false,
  canViewAllDeals: false,
};

let savedToggle: boolean;

beforeAll(async () => {
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  savedToggle = settings.semanticSearchEnabled;

  districtId = (await prisma.district.create({ data: { name: `Ассистент-семантика-${runId}` } })).id;
  const make = (suffix: string, msAgo: number) =>
    prisma.property.create({
      data: {
        title: `Семантика ассистента ${suffix} ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 60000,
        currency: "TJS",
        districtId,
        address: `Тест, ${suffix}`,
        condition: "GOOD",
        status: "AVAILABLE",
        createdAt: new Date(Date.now() - msAgo),
      },
    });
  // createdAt desc по умолчанию => без семантики порядок: New, Mid, Old.
  idOld = (await make("Old", 3 * 60_000)).id;
  idMid = (await make("Mid", 2 * 60_000)).id;
  idNew = (await make("New", 1 * 60_000)).id;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { semanticSearchEnabled: savedToggle } });
  resetAssistantRuntimeCache();
  await prisma.property.deleteMany({ where: { id: { in: [idOld, idMid, idNew] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("тумблер Settings.semanticSearchEnabled — выключен по умолчанию", () => {
  it("semanticQuery передан, но тумблер выключен — семантику не зовём, порядок обычный", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { semanticSearchEnabled: false } });
    resetAssistantRuntimeCache();
    semanticPropertySearch.mockReset();

    const result = (await runTool(
      "search_properties",
      { districtName: `Ассистент-семантика-${runId}`, semanticQuery: "светлая квартира" },
      actor
    )) as Array<{ id: string }>;

    expect(semanticPropertySearch).not.toHaveBeenCalled();
    expect(result.map((p) => p.id)).toEqual([idNew, idMid, idOld]);
  });
});

describe("тумблер Settings.semanticSearchEnabled — включён", () => {
  it("semanticQuery не передан — семантику всё равно не зовём", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { semanticSearchEnabled: true } });
    resetAssistantRuntimeCache();
    semanticPropertySearch.mockReset();

    await runTool("search_properties", { districtName: `Ассистент-семантика-${runId}` }, actor);

    expect(semanticPropertySearch).not.toHaveBeenCalled();
  });

  it("семантика переставляет структурную выдачу по своему рангу, не отменяя фильтры", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { semanticSearchEnabled: true } });
    resetAssistantRuntimeCache();
    semanticPropertySearch.mockReset().mockResolvedValue([
      { propertyId: idOld, score: 0.9 },
      { propertyId: idMid, score: 0.5 },
      // idNew намеренно не ранжирован — объект без вектора остаётся в выдаче,
      // просто уходит в конец.
    ]);

    const result = (await runTool(
      "search_properties",
      { districtName: `Ассистент-семантика-${runId}`, semanticQuery: "тихий двор, рядом парк" },
      actor
    )) as Array<{ id: string }>;

    expect(semanticPropertySearch).toHaveBeenCalledWith(
      "тихий двор, рядом парк",
      expect.objectContaining({ statusFilter: "AVAILABLE" })
    );
    expect(result.map((p) => p.id)).toEqual([idOld, idMid, idNew]);
  });
});
