import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ buyer: vi.fn(), seller: vi.fn(), legacy: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: {
  $disconnect: vi.fn(),
  postShowingCall: { findFirst: mock.buyer },
  sellerProbeCall: { findFirst: mock.seller },
  showingSurveyCall: { findFirst: mock.legacy },
} }));
import { mayReadLiveVoiceSession } from "../src/lib/investigationCallChannels.js";

describe("live voice private session boundary", () => {
  beforeEach(() => { for (const fn of Object.values(mock)) { fn.mockReset(); fn.mockResolvedValue(null); } });
  it.each(["AGENT", "SECURITY", "HEAD_OF_SALES", "MARKETING"])("denies durable private recording to %s even after owning job channel changes", async (role) => {
    expect(await mayReadLiveVoiceSession(role, { channelId: "old-attempt", investigationOnly: true })).toBe(false);
    expect(mock.buyer).not.toHaveBeenCalled();
  });
  it.each(["buyer", "seller", "legacy"] as const)("protects historical %s scenario before marker backfill", async (kind) => {
    mock[kind].mockResolvedValue({ id: "case" });
    expect(await mayReadLiveVoiceSession("AGENT", { channelId: "linked", investigationOnly: false })).toBe(false);
  });
  it("preserves ordinary sales/HR diagnostics permissions", async () => {
    expect(await mayReadLiveVoiceSession("MARKETING", { channelId: "ordinary", investigationOnly: false })).toBe(true);
  });
  it.each(["ADMIN", "DIRECTOR"])("retains investigation evidence for %s", async (role) => {
    expect(await mayReadLiveVoiceSession(role, { channelId: "private", investigationOnly: true })).toBe(true);
  });
});
