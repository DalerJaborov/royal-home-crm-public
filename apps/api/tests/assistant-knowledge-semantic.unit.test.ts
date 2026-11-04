import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), embed: vi.fn(), reserve: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn(), $queryRaw: mocks.query, $executeRaw: mocks.execute } }));
// Full provider boundary mock: never load keys, settings, or SEO dependencies in offline tests.
vi.mock("../src/ai/embeddings.js", () => ({ embedText: mocks.embed,
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b)) }));
vi.mock("../src/ai/geminiTransport.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ai/geminiTransport.js")>(), GEMINI_EMBEDDING_MODEL: "gemini-embedding-001", GEMINI_EMBEDDING_DIMENSIONS: 2,
}));
import { indexCompanyKnowledge, semanticKnowledgeSearch, pendingKnowledgeIndex, KNOWLEDGE_SEMANTIC_SCAN_MAX } from "../src/ai/assistant/knowledgeSemantic.js";
import { searchCompanyKnowledge, type CompanyKnowledge } from "../src/ai/assistant/knowledge.js";
const row: CompanyKnowledge = { id: "test-knowledge", key: "test", title: "Порядок показа", content: "Согласуйте время до выезда.", source: "Инструкция отдела", revision: 1,
  authorId: "test-agent", archived: false, validUntil: null, createdAt: new Date(), updatedAt: new Date() };
const options = () => ({ beforeAttempt: mocks.reserve });
beforeEach(() => {
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "true");
  mocks.query.mockReset().mockResolvedValue([]); mocks.execute.mockReset().mockResolvedValue(1);
  mocks.embed.mockReset().mockResolvedValue([1, 0]); mocks.reserve.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("disabled by default and never embeds or queries index when disabled", async () => {
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "");
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
  expect(await pendingKnowledgeIndex()).toEqual([]);
  await expect(indexCompanyKnowledge([{ id: row.id, revision: 1 }], options())).rejects.toThrow("выключен");
  expect(mocks.embed).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
});
it("uses the reservation hook and at most one physical attempt per approved document", async () => {
  mocks.query.mockResolvedValue([row]);
  expect(await indexCompanyKnowledge([{ id: row.id, revision: 1 }], options())).toEqual({ indexed: 1, skipped: 0 });
  expect(mocks.embed).toHaveBeenCalledWith(expect.stringContaining(row.content), "RETRIEVAL_DOCUMENT", { beforeAttempt: mocks.reserve, maxAttempts: 1 });
  const sql = mocks.execute.mock.calls[0][0];
  expect(sql.text).toContain('"revision" <= EXCLUDED."revision"');
  expect(sql.text).toContain('"archived" = false'); expect(sql.values).toContain(row.revision);
});
it("skips changed/archived records before any paid request", async () => {
  expect(await indexCompanyKnowledge([{ id: row.id, revision: 1 }], options())).toEqual({ indexed: 0, skipped: 1 });
  expect(mocks.embed).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
});
it("does not count a late embedding as indexed when revision CAS loses", async () => {
  mocks.query.mockResolvedValue([row]); mocks.execute.mockResolvedValue(0);
  expect(await indexCompanyKnowledge([{ id: row.id, revision: 1 }], options())).toEqual({ indexed: 0, skipped: 1 });
});
it.each([[1], [NaN, 0], [0, 0], [Infinity, 1]].map((vector) => [vector]))("never saves invalid vector %j", async (vector) => {
  mocks.query.mockResolvedValue([row]); mocks.embed.mockResolvedValue(vector);
  await expect(indexCompanyKnowledge([{ id: row.id, revision: 1 }], options())).rejects.toThrow("вектор");
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("bounds approved batches and rejects missing accounting before I/O", async () => {
  await expect(indexCompanyKnowledge(Array.from({ length: 11 }, (_, i) => ({ id: String(i), revision: 1 })), options())).rejects.toThrow("пакет");
  await expect(indexCompanyKnowledge([{ id: row.id, revision: 1 }], {} as never)).rejects.toThrow("учёт");
  expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.embed).not.toHaveBeenCalled();
});
it("does not pay for an empty index or an oversized scan", async () => {
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
  mocks.query.mockResolvedValue(Array.from({ length: KNOWLEDGE_SEMANTIC_SCAN_MAX + 1 }, () => ({ ...row, embedding: [1, 0] })));
  await expect(semanticKnowledgeSearch("показ", options())).rejects.toThrow("предел");
  expect(mocks.embed).not.toHaveBeenCalled();
});
it("queries only current model/dimensions/revision and rechecks after embedding", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([row]);
  expect(await semanticKnowledgeSearch("совсем другие слова", options())).toEqual([row]);
  expect(mocks.embed).toHaveBeenCalledTimes(1);
  expect(mocks.embed).toHaveBeenCalledWith("совсем другие слова", "RETRIEVAL_QUERY", { beforeAttempt: mocks.reserve, maxAttempts: 1 });
  const sql = mocks.query.mock.calls[0][0];
  expect(sql.text).toContain('e."revision" = k."revision"');
  expect(sql.values).toContain("gemini-embedding-001"); expect(sql.values).toContain(2);
});
it("drops a record archived while its query embedding was pending", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([]);
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
});
it("refreshes keyword fallback when paid semantic retrieval fails", async () => {
  mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([]);
  mocks.embed.mockRejectedValue(new Error("embedding unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await searchCompanyKnowledge("Порядок показа", options())).toEqual([]);
  expect(mocks.query).toHaveBeenCalledTimes(3);
});
it("propagates cancellation instead of returning fallback facts", async () => {
  const controller = new AbortController();
  mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]);
  mocks.embed.mockImplementation(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
  await expect(searchCompanyKnowledge("Порядок показа", { ...options(), signal: controller.signal })).rejects.toThrow("cancelled");
});
it("keeps live CRM queries lexical and only embeds the fixed policy topic", async () => {
  mocks.query.mockResolvedValueOnce([row]);
  expect(await searchCompanyKnowledge("Сколько стоила карточка объекта на показе?", options())).toEqual([row]);
  expect(mocks.embed).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenCalledTimes(1);

  mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ ...row, embedding: [1, 0] }])
    .mockResolvedValueOnce([row]).mockResolvedValueOnce([row]);
  expect(await searchCompanyKnowledge("Какие правила показа, спросил сотрудник Нур?", options())).toEqual([row]);
  expect(mocks.embed).toHaveBeenCalledExactlyOnceWith(
    "Порядок назначения показа объекта. Тартиби таъйин кардани намоиши хона.",
    "RETRIEVAL_QUERY",
    { beforeAttempt: mocks.reserve, maxAttempts: 1 },
  );
});
it("stops a partial batch after provider failure without repeating the successful document", async () => {
  const second = { ...row, id: "second" }, third = { ...row, id: "third" };
  mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([second]).mockResolvedValueOnce([third]);
  mocks.embed.mockResolvedValueOnce([1, 0]).mockRejectedValueOnce(new Error("budget exhausted"));
  await expect(indexCompanyKnowledge([row, second, third], options())).rejects.toThrow("budget exhausted");
  expect(mocks.embed).toHaveBeenCalledTimes(2);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.query).toHaveBeenCalledTimes(2);
});
it("rejects duplicate approved IDs before any database or provider access", async () => {
  await expect(indexCompanyKnowledge([row, row], options())).rejects.toThrow("пакет");
  expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.embed).not.toHaveBeenCalled();
});
it("does not pay for blank queries or an index containing only invalid vectors", async () => {
  expect(await semanticKnowledgeSearch("   ", options())).toEqual([]);
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.query.mockResolvedValue([{ ...row, embedding: [0, 0] }]);
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
  expect(mocks.embed).not.toHaveBeenCalled();
});
it("excludes records whose revision changed during query embedding", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([{ ...row, revision: 2 }]);
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
  const recheck = mocks.query.mock.calls[1][0];
  expect(recheck.text).toContain('"validUntil" > now()');
  expect(recheck.text).toContain('"archived" = false');
});
it("queues missing, changed-version and changed-model indexes while excluding expired facts", async () => {
  await pendingKnowledgeIndex();
  const sql = mocks.query.mock.calls[0][0];
  expect(sql.text).toContain('e."knowledgeId" IS NULL');
  expect(sql.text).toContain('e."revision" <> k."revision"');
  expect(sql.text).toContain('e."model" <>');
  expect(sql.text).toContain('e."dimensions" <>');
  expect(sql.text).toContain('k."validUntil" > now()');
  expect(sql.values).toContain("gemini-embedding-001");
  expect(sql.values).toContain(10);
});
