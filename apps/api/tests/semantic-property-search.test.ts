import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * semanticPropertySearch (lib/embeddingSearch.ts) — семантический слой ПОВЕРХ
 * структурного подбора (routes/matching.ts), не вместо него.
 *
 * cosineSimilarity — настоящая реализация (не мок): именно ранжирование по ней и
 * проверяется. Мокается только embedText — сетевой вызов к Gemini, который в
 * тестах бить незачем (см. тот же приём в ai-assistant-grounded-search.test.ts).
 */

const embedText = vi.fn();
vi.mock("../src/ai/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, embedText };
});

const { prisma } = await import("../src/db.js");
const { semanticPropertySearch } = await import("../src/lib/embeddingSearch.js");

const runId = Date.now();
let districtId: string;
const propertyIds: string[] = [];

async function makeProperty(suffix: string, extra: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Семантика ${suffix} ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 60000,
      currency: "TJS",
      districtId,
      address: `Тестовая, ${suffix}`,
      condition: "GOOD",
      status: "AVAILABLE",
      ...extra,
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

let idClose: string; // embedding [1,0,0] — совпадает с моком запроса
let idFar: string; // embedding [0,1,0] — ортогонален запросу
let idNoVector: string; // без эмбеддинга вовсе
let idWithdrawn: string; // не AVAILABLE
let idOffSite: string; // несайтовый — исключается всегда, как и в структурном подборе

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Семантика-тест-${runId}` } })).id;

  idClose = await makeProperty("A", { embedding: [1, 0, 0], embeddingUpdatedAt: new Date() });
  idFar = await makeProperty("B", { embedding: [0, 1, 0], embeddingUpdatedAt: new Date() });
  idNoVector = await makeProperty("C", {});
  idWithdrawn = await makeProperty("D", {
    status: "WITHDRAWN",
    embedding: [1, 0, 0],
    embeddingUpdatedAt: new Date(),
  });
  idOffSite = await makeProperty("E", { offSite: true, embedding: [1, 0, 0], embeddingUpdatedAt: new Date() });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("semanticPropertySearch", () => {
  it("ранжирует по косинусному сходству, отсекает объекты без вектора", async () => {
    embedText.mockReset().mockResolvedValue([1, 0, 0]);
    const result = await semanticPropertySearch("светлая квартира рядом со школой");
    const ids = result.map((r) => r.propertyId);

    expect(ids).toContain(idClose);
    expect(ids).not.toContain(idNoVector);

    const indexClose = ids.indexOf(idClose);
    const indexFar = ids.indexOf(idFar);
    expect(indexClose).toBeLessThan(indexFar);
    expect(result.find((r) => r.propertyId === idClose)!.score).toBeCloseTo(1, 10);
    expect(result.find((r) => r.propertyId === idFar)!.score).toBeCloseTo(0, 10);
  });

  it("границы видимости — те же, что у структурного подбора: не AVAILABLE не попадает, «только в CRM» попадает", async () => {
    embedText.mockReset().mockResolvedValue([1, 0, 0]);
    const result = await semanticPropertySearch("что угодно");
    const ids = result.map((r) => r.propertyId);
    expect(ids).not.toContain(idWithdrawn);
    /**
     * Объект «только в CRM» из подбора БОЛЬШЕ НЕ ИСКЛЮЧАЕТСЯ (владелец 09.09.2026,
     * отмена части правила 18.08.2026): он и так виден всем агентам в разделе
     * «Объекты» и уходит клиенту приватной ссылкой, а прятать его от подбора
     * значило требовать, чтобы агент вспомнил про него сам. На сайт он по-прежнему
     * не идёт никогда, и в продажу выходит только с шестью фотографиями.
     */
    expect(ids).toContain(idOffSite);
  });

  it("statusFilter переопределяет AVAILABLE по умолчанию", async () => {
    embedText.mockReset().mockResolvedValue([1, 0, 0]);
    const result = await semanticPropertySearch("что угодно", { statusFilter: "WITHDRAWN" });
    const ids = result.map((r) => r.propertyId);
    expect(ids).toContain(idWithdrawn);
    expect(ids).not.toContain(idClose);
  });

  it("пустой запрос — embedText не зовём вовсе, результат пуст", async () => {
    embedText.mockReset();
    const result = await semanticPropertySearch("   ");
    expect(result).toEqual([]);
    expect(embedText).not.toHaveBeenCalled();
  });

  it("Gemini не вернул вектор — пустой результат, а не падение", async () => {
    embedText.mockReset().mockResolvedValue(null);
    const result = await semanticPropertySearch("что угодно, Gemini недоступен");
    expect(result).toEqual([]);
  });
});
