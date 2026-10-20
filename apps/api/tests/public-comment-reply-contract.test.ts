import { describe, expect, it, vi } from "vitest";
import { publicReplyReceipt, publicReplyTargetHash, sendRecordedPublicReply, type PublicReplyStore, type PublicReplyTarget } from "../src/messengers/publicCommentReply.js";

const target: PublicReplyTarget = { channel: "FACEBOOK", accountExternalId: "synthetic-page", mediaId: "synthetic-post", commentId: "synthetic-comment", parentId: null };
function fixture() {
  const row = { revision: 1n, state: "IDLE", status: "WORKING", note: "", providerId: null as string | null, text: null as string | null, hash: publicReplyTargetHash(target) };
  const store: PublicReplyStore = {
    claim: vi.fn(async (expected, attemptKey, _target, hash) => {
      if (row.state !== "IDLE" || row.revision !== expected || row.hash !== hash) return null;
      row.state = "IN_FLIGHT"; return { attemptKey, targetHash: hash, sourceRevision: row.revision };
    }),
    isCurrent: vi.fn(async lease => row.state === "IN_FLIGHT" && row.revision === lease.sourceRevision && row.hash === lease.targetHash),
    complete: vi.fn(async (lease, receipt, text) => {
      const applicable = row.revision === lease.sourceRevision && row.hash === lease.targetHash;
      row.state = receipt.outcome.toUpperCase(); row.providerId = receipt.providerId;
      if (applicable) { row.status = receipt.outcome === "accepted" ? "REPLIED" : "ESCALATED"; if (receipt.outcome === "accepted") row.text = text; }
      return applicable;
    }),
  };
  const run = (send: (beforePost: () => Promise<void>) => Promise<unknown>) => sendRecordedPublicReply({ provider: "FACEBOOK", target,
    expectedSourceRevision: row.revision, text: "Synthetic public answer", store, send });
  return { row, store, run };
}
describe("public reply receipt is separate from generated text and moderation", () => {
  it.each(["INSTAGRAM", "FACEBOOK", "YOUTUBE"] as const)("%s requires its actual reply ID", provider => {
    expect(publicReplyReceipt(provider, { id: "provider-public-7" })).toMatchObject({ outcome: "accepted", providerId: "provider-public-7" });
    expect(publicReplyReceipt(provider, { success: true }).outcome).toBe("unknown");
    expect(publicReplyReceipt(provider, { id: "contradictory-id", error: {} }).outcome).toBe("unknown");
    expect(publicReplyReceipt(provider, { id: "contradictory-id", success: false }).outcome).toBe("unknown");
    expect(publicReplyReceipt(provider, { id: "contradictory-id", ok: false }).outcome).toBe("unknown");
  });
  it("TG keeps the exact returned message ID, not a success boolean", () => {
    expect(publicReplyReceipt("TELEGRAM", { message_id: 74 })).toMatchObject({ outcome: "accepted", providerId: "74" });
    expect(publicReplyReceipt("TELEGRAM", { message_id: 0 }).outcome).toBe("unknown");
    expect(publicReplyReceipt("TELEGRAM", { message_id: 74, success: false }).outcome).toBe("unknown");
  });
  it("accepted provider ID is persisted before dependent DM", async () => {
    const f = fixture(), dm = vi.fn(async () => { expect(f.row.state).toBe("ACCEPTED"); expect(f.row.providerId).toBe("public-1"); });
    expect(await f.run(async beforePost => { await beforePost(); return "public-1"; })).toBe("public-1"); await dm();
    expect(dm).toHaveBeenCalledTimes(1); expect(f.row.text).toBe("Synthetic public answer");
  });
  it.each([null, {}, { success: true }])("2xx without reply ID stays UNKNOWN and cannot start DM: %j", async raw => {
    const f = fixture(), dm = vi.fn();
    await expect((async () => { await f.run(async beforePost => { await beforePost(); return raw; }); dm(); })()).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
    expect(dm).not.toHaveBeenCalled(); expect(f.row).toMatchObject({ state: "UNKNOWN", providerId: null, text: null, status: "ESCALATED" });
  });
  it("timeout after POST is terminal UNKNOWN, including a later status/note edit", async () => {
    const f = fixture(), fetch = vi.fn().mockRejectedValue(new DOMException("synthetic after POST", "TimeoutError"));
    await expect(f.run(async beforePost => { await beforePost(); return fetch(); })).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
    f.row.note = ""; f.row.status = "PENDING"; f.row.revision++;
    await expect(f.run(async () => fetch())).rejects.toMatchObject({ reason: "source_changed_or_attempt_exists" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepted POST then failed receipt commit remains IN_FLIGHT; another worker cannot POST", async () => {
    const f = fixture(), fetch = vi.fn().mockResolvedValue("accepted-then-db-fault");
    vi.mocked(f.store.complete).mockRejectedValueOnce(new Error("synthetic commit failure"));
    await expect(f.run(async beforePost => { await beforePost(); return fetch(); })).rejects.toMatchObject({ reason: "receipt_persistence_unavailable", receipt: { outcome: "accepted", providerId: "accepted-then-db-fault" } });
    expect(f.row.state).toBe("IN_FLIGHT");
    await expect(f.run(async () => fetch())).rejects.toMatchObject({ reason: "source_changed_or_attempt_exists" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.row.status).not.toBe("REPLIED");
  });
  it("source/staff takeover during credential await is checked immediately before POST", async () => {
    const f = fixture(), fetch = vi.fn();
    await expect(f.run(async beforePost => { f.row.revision++; f.row.status = "HIDDEN"; await beforePost(); return fetch(); })).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
    expect(fetch).not.toHaveBeenCalled(); expect(f.row.status).toBe("HIDDEN");
  });
  it("source changes after POST: retain original acceptance but do not overwrite staff status or start DM", async () => {
    const f = fixture(), dm = vi.fn();
    await expect((async () => { await f.run(async beforePost => { await beforePost(); f.row.revision++; f.row.status = "HIDDEN"; return "original-target-id"; }); dm(); })())
      .rejects.toMatchObject({ reason: "source_changed_after_post", receipt: { outcome: "accepted" } });
    expect(f.row).toMatchObject({ state: "ACCEPTED", providerId: "original-target-id", status: "HIDDEN", text: null }); expect(dm).not.toHaveBeenCalled();
  });
  it("one lease admits only one physical callback, including concurrent calls", async () => {
    const f = fixture(), fetch = vi.fn(), dm = vi.fn();
    await expect((async () => { await f.run(async beforePost => { await beforePost(); await fetch(); await beforePost(); await fetch(); return "must-not-confirm"; }); dm(); })())
      .rejects.toMatchObject({ receipt: { outcome: "unknown" } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(dm).not.toHaveBeenCalled();
    const g = fixture();
    await expect(g.run(async beforePost => { await Promise.all([beforePost(), beforePost()]); return "never-confirm"; })).rejects.toMatchObject({ receipt: { outcome: "unknown" } });
  });
  it("an ID from an unhooked sender is UNKNOWN and cannot start downstream DM", async () => {
    const f = fixture(), dm = vi.fn();
    await expect((async () => { await f.run(async () => "unhooked-id"); dm(); })()).rejects.toMatchObject({ reason: "physical_post_callback_missing", receipt: { outcome: "unknown" } });
    expect(dm).not.toHaveBeenCalled(); expect(f.row.providerId).toBeNull();
  });
});

it("authoritative P12 MID collision downgrades the provisional wire ID to UNKNOWN", async () => {
  const f = fixture(), dm = vi.fn();
  vi.mocked(f.store.complete).mockResolvedValueOnce({ applicable: false, receipt: { outcome: "unknown", providerId: null, reason: "mid_conflict" } });
  await expect((async () => { await f.run(async beforePost => { await beforePost(); return { id: "duplicate-provider-id" }; }); dm(); })())
    .rejects.toMatchObject({ reason: "mid_conflict", receipt: { outcome: "unknown", providerId: null } });
  expect(dm).not.toHaveBeenCalled();
});
