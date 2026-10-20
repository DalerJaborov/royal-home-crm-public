import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicCommentSourceIssuer, publicCommentSourceDigest } from "../src/lib/publicCommentSourceIssuer.js";
import { projectPublicCommentCapabilities, publicModerationProposal } from "../src/lib/publicCommentCapabilities.js";
import type { ServerPublicCommentSnapshot } from "@royal-home/shared";
const propertyId = randomUUID();
function fixture(channel: "INSTAGRAM" | "TELEGRAM" = "INSTAGRAM") {
  const installation = { id: "synthetic-installation", revision: "3", channel, accountId: channel === "TELEGRAM" ? null : randomUUID(), resourceId: "synthetic-account", transportKey: "synthetic-transport" };
  const row: { -readonly [K in keyof ServerPublicCommentSnapshot]: ServerPublicCommentSnapshot[K] } = { source: { table: channel === "TELEGRAM" ? "telegram" : "meta", id: channel === "TELEGRAM" ? "cmgsyntheticcuid000000001" : randomUUID() },
    sourceRevision: "5", status: "WORKING", target: { channel, publicationId: "public-post", commentId: "public-comment", parentId: null,
      threadId: "public-comment", threadKind: channel === "TELEGRAM" ? "discussion_post" : "comment_anchor", accountExternalId: installation.resourceId },
    text: "Нархаш чанд?", currentInstallation: installation,
    settings: { policyRevision: "7", contractVersion: "scoped", rolloutMode: "SHADOW", publicRead: true,
      botEnabled: true, botCanAnswerComments: true, botInstagramEnabled: true, botFacebookEnabled: true, botTelegramEnabled: true, metaEnabled: true },
    proof: null };
  row.proof = { version: 1, origin: channel === "TELEGRAM" ? "telegram_verified_discussion_update" : "meta_verified_comment",
    installation: structuredClone(installation), source: structuredClone(row.source), sourceRevision: "5", policyRevision: "7", digest: publicCommentSourceDigest(row) };
  const facts = { propertyId, shortId: 19, price: "40000", currency: "USD", availability: "AVAILABLE", publicAddress: "Сино, Душанбе",
    addressPolicy: "district_city_only", builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: "a".repeat(64) };
  const read = vi.fn(async () => structuredClone(facts)), load = vi.fn(async () => structuredClone(row));
  const issuer = createPublicCommentSourceIssuer({ loadFromServer: load, readPublicPropertyFacts: read });
  return { row, facts, read, load, issuer };
}
afterEach(() => { vi.restoreAllMocks(); });
describe("public comment identity uses persisted producer proof, never DM identity", () => {
  it.each(["INSTAGRAM", "TELEGRAM"] as const)("%s valid source can read only strict public facts (TEXT/CUID supported)", async channel => {
    const f = fixture(channel), loaded = await f.issuer.load(f.row.source);
    expect(loaded.status).toBe("current"); if (loaded.status !== "current") throw new Error("Expected synthetic persisted origin");
    expect(loaded.value.privateAuthorization).toBe("none"); expect(Object.isFrozen(loaded.value.installation)).toBe(true);
    expect(await f.issuer.withPublicRead(loaded.value, "get_property_facts")).toMatchObject({ status: "current", value: { price: "40000", addressPolicy: "district_city_only" } });
    for (const tool of ["save_contact", "request_callback", "book_showing", "read_client", "send_dm", "runTool"]) {
      expect(await f.issuer.withPublicRead(loaded.value, tool)).toEqual({ status: "held", reason: "tool_denied" });
    }
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("current row with no durable producer origin cannot mint principal", async () => {
    const f = fixture(); f.row.proof = null;
    expect(await f.issuer.load(f.row.source)).toEqual({ status: "held", reason: "origin_missing" }); expect(f.read).not.toHaveBeenCalled();
  });
  it("JSON copy of a real principal is not an opaque authority", async () => {
    const f = fixture(), loaded = await f.issuer.load(f.row.source); if (loaded.status !== "current") throw new Error("fixture");
    expect(await f.issuer.revalidate(JSON.parse(JSON.stringify(loaded.value)))).toEqual({ status: "held", reason: "principal_unknown" });
  });
  it.each(["text", "publication", "parent", "scope_aba", "policy", "source"] as const)("original %s change across await cannot be adopted", async change => {
    const f = fixture(), loaded = await f.issuer.load(f.row.source); if (loaded.status !== "current") throw new Error("fixture");
    f.read.mockImplementationOnce(async () => {
      if (change === "text") f.row.text = "Different public edition";
      if (change === "publication") f.row.target.publicationId = "other-post";
      if (change === "parent") f.row.target.parentId = "other-parent";
      if (change === "scope_aba") f.row.currentInstallation = { ...f.row.currentInstallation!, revision: "5" };
      if (change === "policy") f.row.settings = { ...f.row.settings, policyRevision: "8" };
      if (change === "source") f.row.sourceRevision = "6";
      return f.facts;
    });
    expect(await f.issuer.withPublicRead(loaded.value, "get_property_facts")).toMatchObject({ status: "held" }); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("fact provider cannot leak raw private Property/Client fields", async () => {
    const f = fixture(), loaded = await f.issuer.load(f.row.source); if (loaded.status !== "current") throw new Error("fixture");
    const privateFacts = { ...f.facts, ownerPhone: "SYNTHETIC-PRIVATE" }; f.read.mockResolvedValueOnce(privateFacts);
    expect(await f.issuer.withPublicRead(loaded.value, "get_property_facts")).toEqual({ status: "held", reason: "facts_unavailable" });
  });
  it("OFF and held source never advertise ready core or private effects", () => {
    const f = fixture();
    const caps = projectPublicCommentCapabilities("INSTAGRAM", { ...f.row.settings, rolloutMode: "OFF" }, "current");
    expect(caps).toMatchObject({ publicAgentReadReady: false, directMessage: false, contactWrite: false, publicDelivery: "requires_p12_public_target" });
    expect(projectPublicCommentCapabilities("INSTAGRAM", f.row.settings, "held").answerPlan).toBe("held");
  });
  it("real criticism and owner cannot auto-moderate; TG has no hide capability", () => {
    for (const classification of ["owner", "criticism", "uncertain"] as const) expect(publicModerationProposal({ classification, effect: "delete" }, "INSTAGRAM")).toEqual({ kind: "review" });
    expect(publicModerationProposal({ classification: "spam", effect: "hide" }, "TELEGRAM")).toEqual({ kind: "review" });
    expect(publicModerationProposal({ classification: "spam", effect: "delete" }, "TELEGRAM")).toMatchObject({ kind: "moderation_proposal", staffApprovalRequired: true });
  });
});
