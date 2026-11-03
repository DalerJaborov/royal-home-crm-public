import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), embed: vi.fn(), reserve: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute } }));
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
  expect(await searchCompanyKnowledge("показ", options())).toEqual([]);
  expect(mocks.query).toHaveBeenCalledTimes(3);
});
it("propagates cancellation instead of returning fallback facts", async () => {
  const controller = new AbortController();
  mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]);
  mocks.embed.mockImplementation(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
  await expect(searchCompanyKnowledge("показ", { ...options(), signal: controller.signal })).rejects.toThrow("cancelled");
});
