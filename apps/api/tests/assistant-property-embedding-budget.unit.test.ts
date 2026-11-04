import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ embed: vi.fn(), find: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn(), property: { findMany: mocks.find } } }));
vi.mock("../src/ai/embeddings.js", () => ({ embedText: mocks.embed, cosineSimilarity: () => 1 }));
import { semanticPropertySearch } from "../src/lib/embeddingSearch.js";
beforeEach(() => { mocks.embed.mockReset(); mocks.find.mockReset(); });
it("passes spending guard, cancellation and one attempt through property search", async () => {
  const embedding = { beforeAttempt: vi.fn(), signal: new AbortController().signal, maxAttempts: 1 };
  mocks.embed.mockResolvedValue([1]); mocks.find.mockResolvedValue([]);
  await semanticPropertySearch("светлая квартира", { embedding });
  expect(mocks.embed).toHaveBeenCalledWith("светлая квартира", "RETRIEVAL_QUERY", embedding);
});
it("does not scan properties after a denied paid embedding", async () => {
  const error = Object.assign(new Error("limit"), { code: "assistant_attempt_limit" });
  mocks.embed.mockRejectedValue(error);
  await expect(semanticPropertySearch("квартира", { embedding: { beforeAttempt: vi.fn() } })).rejects.toBe(error);
  expect(mocks.find).not.toHaveBeenCalled();
});
