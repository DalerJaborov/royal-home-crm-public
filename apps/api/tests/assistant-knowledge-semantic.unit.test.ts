import { readFileSync } from "node:fs";
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
import { searchAssistantCompanyKnowledge, knowledgeKey, type CompanyKnowledge } from "../src/ai/assistant/knowledge.js";
const [handoff,,, showing] = JSON.parse(readFileSync(new URL("../../../docs/design/pilots/company-memory-workflows.json", import.meta.url), "utf8"));
const row: CompanyKnowledge = { ...showing, id: "test-knowledge", key: knowledgeKey(showing.title), revision: 1,
  authorId: "test-agent", archived: false, validUntil: null, createdAt: new Date(), updatedAt: new Date() };
const options = () => ({ beforeAttempt: mocks.reserve });
beforeEach(() => {
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "true");
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED", "true");
  mocks.query.mockReset().mockResolvedValue([]); mocks.execute.mockReset().mockResolvedValue(1);
  mocks.embed.mockReset().mockResolvedValue([1, 0]); mocks.reserve.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("disabled by default and never embeds or queries index when disabled", async () => {
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "");
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED", "");
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([]);
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
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([]);
  mocks.query.mockResolvedValue(Array.from({ length: KNOWLEDGE_SEMANTIC_SCAN_MAX + 1 }, () => ({ ...row, embedding: [1, 0] })));
  await expect(semanticKnowledgeSearch("property-showing", options())).rejects.toThrow("предел");
  expect(mocks.embed).not.toHaveBeenCalled();
});
it("queries only current model/dimensions/revision and rechecks after embedding", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([row]);
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([row]);
  expect(mocks.embed).toHaveBeenCalledTimes(1);
  expect(mocks.embed).toHaveBeenCalledWith("Порядок назначения показа объекта. Тартиби таъйин кардани намоиши хона.", "RETRIEVAL_QUERY", { beforeAttempt: mocks.reserve, maxAttempts: 1 });
  const sql = mocks.query.mock.calls[0][0];
  expect(sql.text).toContain('e."revision" = k."revision"');
  expect(sql.values).toContain("gemini-embedding-001"); expect(sql.values).toContain(2);
});
it("drops a record archived while its query embedding was pending", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([]);
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([]);
});
it("refreshes keyword fallback when paid semantic retrieval fails", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([]);
  mocks.embed.mockRejectedValue(new Error("embedding unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await searchAssistantCompanyKnowledge("Порядок показа", options())).toEqual([]);
  expect(mocks.query).toHaveBeenCalledTimes(2);
});
it("propagates cancellation instead of returning fallback facts", async () => {
  const controller = new AbortController();
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]);
  mocks.embed.mockImplementation(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
  await expect(searchAssistantCompanyKnowledge("Порядок показа", { ...options(), signal: controller.signal })).rejects.toThrow("cancelled");
});
it("keeps live CRM queries lexical and only embeds the fixed policy topic", async () => {
  mocks.query.mockResolvedValueOnce([row]);
  expect(await searchAssistantCompanyKnowledge("Сколько стоила карточка объекта на показе?", options())).toEqual([row]);
  expect(mocks.embed).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenCalledTimes(1);

  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([row]);
  expect(await searchAssistantCompanyKnowledge("Какие правила показа, спросил сотрудник Нур?", options())).toEqual([row]);
  expect(mocks.embed).toHaveBeenCalledExactlyOnceWith(
    "Порядок назначения показа объекта. Тартиби таъйин кардани намоиши хона.",
    "RETRIEVAL_QUERY",
    expect.objectContaining({ beforeAttempt: mocks.reserve, maxAttempts: 1, signal: expect.any(AbortSignal) }),
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
  expect(await semanticKnowledgeSearch("raw user content" as never, options())).toEqual([]);
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.query.mockResolvedValue([{ ...row, embedding: [0, 0] }]);
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([]);
  expect(mocks.embed).not.toHaveBeenCalled();
});
it("excludes records whose revision changed during query embedding", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([{ ...row, revision: 2 }]);
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([]);
  const recheck = mocks.query.mock.calls[1][0];
  expect(recheck.text).toContain('"validUntil" > now()');
  expect(recheck.text).toContain('"archived" = false');
});
it("queues missing, changed-version and changed-model indexes for the reviewed active revisions", async () => {
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

it("keeps lookup and indexing independently controllable", async () => {
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED", "false");
  expect(await pendingKnowledgeIndex()).toEqual([]);
  await expect(indexCompanyKnowledge([row], options())).rejects.toThrow("выключен");
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([row]);
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([row]);
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "false");
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED", "true");
  await pendingKnowledgeIndex();
  expect(mocks.query).toHaveBeenCalledTimes(3);
});

it("never pays to embed an unreviewed document even when its title and revision match", async () => {
  const altered = { ...row, content: "Unreviewed document" };
  mocks.query.mockResolvedValueOnce([altered]).mockResolvedValueOnce([altered])
    .mockResolvedValueOnce([{ ...altered, embedding: [1, 0] }]);
  expect(await pendingKnowledgeIndex()).toEqual([]);
  expect(await indexCompanyKnowledge([altered], options())).toEqual({ indexed: 0, skipped: 1 });
  expect(await semanticKnowledgeSearch("property-showing", options())).toEqual([]);
  expect(mocks.embed).not.toHaveBeenCalled();
});

it("checks semantic confidence and uses the reviewed local rule below threshold", async () => {
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [1, 0] }]).mockResolvedValueOnce([row]);
  mocks.embed.mockResolvedValue([0, 1]);
  expect(await searchAssistantCompanyKnowledge("Барои нишон додани хона чӣ даркор?", options())).toEqual([row]);
  expect(mocks.query).toHaveBeenCalledTimes(2);
});

it("does not answer with a different approved topic when similarity disagrees", async () => {
  const other = { ...row, ...handoff, id: "handoff", key: knowledgeKey(handoff.title), embedding: [1, 0] };
  mocks.query.mockResolvedValueOnce([{ ...row, embedding: [0.9, 0.1] }, other]).mockResolvedValueOnce([row]);
  expect(await searchAssistantCompanyKnowledge("Барои нишон додани хона чӣ даркор?", options())).toEqual([row]);
  expect(mocks.query).toHaveBeenCalledTimes(2);
});

it("uses local lookup without a provider reservation in a group", async () => {
  mocks.query.mockResolvedValueOnce([row]);
  expect(await searchAssistantCompanyKnowledge("Барои нишон додани хона чӣ даркор?")).toEqual([row]);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.embed).not.toHaveBeenCalled();
});
