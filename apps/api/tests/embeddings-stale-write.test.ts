import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * CHANNEL-NEW-28 (аудит Codex, 04.10.2026): две быстрые правки описания объекта запускают
 * два параллельных `embedAndSaveProperty`. Быстрый пересчёт нового описания сохранял
 * верный вектор, а поздний ответ по старому описанию писал `update where id` и затирал
 * его, поставив свежий embeddingUpdatedAt. Поиск по смыслу работал по старому тексту.
 *
 * Gemini подменён (ключ и fetch): ответ по старому описанию висит, пока тест не отпустит.
 */
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: vi.fn(async () => ({ keys: ["test-key"] })),
}));

const { prisma } = await import("../src/db.js");
const { embedAndSaveProperty } = await import("../src/ai/embeddings.js");

const runId = Date.now();
let districtId = "";
let propertyId = "";

function geminiResponse(values: number[]): Response {
  return { ok: true, status: 200, text: async () => "", json: async () => ({ embedding: { values } }) } as unknown as Response;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Эмбеддинг-район-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Эмбеддинг ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 50000,
        currency: "USD",
        districtId,
        address: `Эмбеддинг ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        description: "СТАРОЕ_ОПИСАНИЕ",
      },
    })
  ).id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("embedAndSaveProperty: поздний ответ по старому тексту не затирает вектор нового", () => {
  it("вектор нового описания остаётся, когда ответ по старому приходит последним", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldStarted!: () => void;
    const oldRequested = new Promise<void>((resolve) => { oldStarted = resolve; });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        const text = String(init?.body);
        if (text.includes("СТАРОЕ_ОПИСАНИЕ")) {
          oldStarted();
          await oldGate;
          return geminiResponse([1, 0, 0]);
        }
        return geminiResponse([0, 1, 0]);
      })
    );

    const first = embedAndSaveProperty(propertyId); // читает старое описание, ответ Gemini ждёт
    await oldRequested;
    await prisma.property.update({ where: { id: propertyId }, data: { description: "НОВОЕ_ОПИСАНИЕ" } });
    await embedAndSaveProperty(propertyId); // быстрый пересчёт нового описания
    releaseOld();
    await first;

    const saved = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { embedding: true } });
    expect(saved.embedding).toEqual([0, 1, 0]);
  });
});
