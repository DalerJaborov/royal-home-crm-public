import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { postCommentReply, postCommentReplyResponse } from "../src/messengers/comments.js";
import { publicCommentWireFixture } from "./helpers/publicCommentWireFixture.js";
// The public wire fixture owns an in-memory source/receipt, not a database.
// Keep actual wire parsing and source rechecks; isolate the ledger DB seam.
// Its real SQL/UNKNOWN behavior is covered by physical-postgres integration.
const physicalLedger = vi.hoisted(() => ({ admit: vi.fn(), settle: vi.fn() }));
vi.mock("../src/lib/customerLegacyPhysical.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/customerLegacyPhysical.js")>()),
  admitLegacyPhysicalPost: physicalLedger.admit, settleLegacyPhysicalPost: physicalLedger.settle,
}));
beforeEach(() => {
  physicalLedger.admit.mockReset().mockResolvedValue("synthetic-public-unit-attempt");
  physicalLedger.settle.mockReset().mockResolvedValue(undefined);
});
vi.mock("../src/messengers/meta.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: vi.fn(async () => ({ igToken: "synthetic-token", pageId: "synthetic-page", pageToken: "synthetic-token" })),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const target = { channel: "FACEBOOK" as const, accountExternalId: "synthetic-page", mediaId: "post-1", commentId: "comment-1", parentId: null };
it("actual Meta wire preserves contradictory response instead of extracting ID early", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "contradictory-id", success: false }), { status: 200 })); vi.stubGlobal("fetch", fetch);
  const wire = publicCommentWireFixture(target);
  await expect(wire.run(beforePost => postCommentReplyResponse(target, "Synthetic", "synthetic-token", beforePost)))
    .rejects.toMatchObject({ reason: "contradictory_provider_response", receipt: { outcome: "unknown" } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(physicalLedger.settle).toHaveBeenCalledWith("synthetic-public-unit-attempt", "UNKNOWN");
});
it("actual Meta same original target positive keeps its returned ID", async () => {
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => { expect(String(url)).toContain("/comment-1/comments"); expect(JSON.parse(String(init?.body))).toEqual({ message: "Synthetic" });
    return new Response(JSON.stringify({ id: "real-fake-id" }), { status: 200 }); }); vi.stubGlobal("fetch", fetch);
  const wire = publicCommentWireFixture(target);
  expect(await wire.run(beforePost => postCommentReplyResponse(target, "Synthetic", "synthetic-token", beforePost))).toBe("real-fake-id");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(physicalLedger.settle).toHaveBeenCalledWith("synthetic-public-unit-attempt", "ACCEPTED", "real-fake-id");
});
it("actual Meta awaits credentials then rejects a revoked source before POST", async () => {
  const { loadCredentials } = await import("../src/messengers/meta.js"); const wire = publicCommentWireFixture(target);
  vi.mocked(loadCredentials).mockImplementationOnce(async () => { await Promise.resolve(); wire.state.current = false;
    return { igToken: "synthetic-token", pageId: "synthetic-page", pageToken: "synthetic-token" }; });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(wire.run(beforePost => postCommentReplyResponse(target, "Synthetic", "synthetic-token", beforePost))).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect(fetch).not.toHaveBeenCalled();
});
it("actual Meta inherited connection retry cannot repeat public POST", async () => {
  const fetch = vi.fn(async () => { throw new Error("Synthetic connect failure", { cause: { code: "ECONNREFUSED" } }); }); vi.stubGlobal("fetch", fetch);
  const wire = publicCommentWireFixture(target);
  await expect(wire.run(beforePost => postCommentReplyResponse(target, "Synthetic", "synthetic-token", beforePost))).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("existing manual reply facade uses strict full-wire response while keeping its nullable ABI", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "contradictory", ok: false }), { status: 200 })); vi.stubGlobal("fetch", fetch);
  expect(await postCommentReply(target, "Synthetic manual", "synthetic-token")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
