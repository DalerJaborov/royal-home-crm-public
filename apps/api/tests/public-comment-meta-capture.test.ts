import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { registerAuthenticatedMetaCustomerRequest, type CustomerMetaIssuerStore } from "../src/lib/customerIngressAuthority.js";
import { createMetaPublicCapture, type MetaPublicCapturePort } from "../src/lib/metaPublicCommentCapture.js";
import type { PublicInstallation } from "@royal-home/shared";
function fixture() {
  const accountId = randomUUID(), resource = "synthetic-ig-account", secret = "synthetic-own-comment-app-secret";
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: resource, changes: [{ field: "comments", value: {
    id: "synthetic-comment", media: { id: "synthetic-publication" }, from: { id: "synthetic-public-author" }, text: "Нархаш чанд?" } }] }] }));
  const request = { rawBody, get: (name: string) => name === "x-hub-signature-256" ? signature : undefined };
  let signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const installation: PublicInstallation = { id: "synthetic-public-scope", revision: "3", channel: "INSTAGRAM", accountId,
    resourceId: resource, transportKey: `messenger-account:${accountId}` };
  const store: CustomerMetaIssuerStore = {
    readTarget: vi.fn(async (_channel, target) => target === resource ? [{ id: accountId, explicitSecret: true, secret,
      endpointScopeId: installation.id, scopeRevision: "3", policyRevision: "4" }] : []),
    readGlobalSecrets: vi.fn(async () => ({ global: "synthetic-other-app-key", instagram: null })),
    readInstalledTarget: vi.fn(async () => null),
  };
  const port: MetaPublicCapturePort = { readInstallation: vi.fn(async () => ({ installation: structuredClone(installation), policyRevision: "4" })),
    // Atomic store is a declared fake: this unit proves real signature/capture closure, not SQL durability/ACK.
    commitQueueAndCapture: vi.fn(async () => ({ status: "current", value: [{ table: "meta", id: "synthetic-source-row" }] })) };
  const open = createMetaPublicCapture(port, store);
  return { request, port, store, open, installation, setSignature: (value: string) => { signature = value; } };
}
describe("Meta public capture uses actual same-request target HMAC, never verified JSON", () => {
  it("valid signed comment batch retains exact public source and can commit a filtered subset once", async () => {
    const f = fixture(); registerAuthenticatedMetaCustomerRequest(f.request);
    const capture = await f.open(f.request); expect(capture.status).toBe("current"); if (capture.status !== "current") throw new Error("fixture");
    expect(capture.value.items[0]).toMatchObject({ mediaId: "synthetic-publication", authorId: "synthetic-public-author", text: "Нархаш чанд?" });
    expect(await capture.value.commitFiltered([...capture.value.items], true)).toMatchObject({ status: "current" });
    expect(await capture.value.commitFiltered([...capture.value.items], true)).toEqual({ status: "held", reason: "capture_expired" });
    expect(f.port.commitQueueAndCapture).toHaveBeenCalledTimes(1);
  });
  it("matching signed JSON without actual middleware provenance cannot create origin", async () => {
    const f = fixture(); expect(await f.open(f.request)).toEqual({ status: "held", reason: "origin_missing" }); expect(f.port.commitQueueAndCapture).not.toHaveBeenCalled();
  });
  it("another app global secret cannot replace this target's explicit own key", async () => {
    const f = fixture(); registerAuthenticatedMetaCustomerRequest(f.request);
    f.setSignature(`sha256=${createHmac("sha256", "synthetic-other-app-key").update(f.request.rawBody).digest("hex")}`);
    expect(await f.open(f.request)).toEqual({ status: "held", reason: "origin_missing" }); expect(f.port.commitQueueAndCapture).not.toHaveBeenCalled();
  });
  it("credential epoch changed during verification cannot be adopted", async () => {
    const f = fixture(); registerAuthenticatedMetaCustomerRequest(f.request);
    vi.mocked(f.port.readInstallation).mockResolvedValueOnce({ installation: { ...f.installation, revision: "3" }, policyRevision: "4" })
      .mockResolvedValueOnce({ installation: { ...f.installation, revision: "5" }, policyRevision: "4" });
    expect(await f.open(f.request)).toEqual({ status: "held", reason: "installation_changed" }); expect(f.port.commitQueueAndCapture).not.toHaveBeenCalled();
  });
  it("filtered capture cannot replace signed text/publication with model content", async () => {
    const f = fixture(); registerAuthenticatedMetaCustomerRequest(f.request);
    const capture = await f.open(f.request); if (capture.status !== "current") throw new Error("fixture");
    expect(await capture.value.commitFiltered([{ ...capture.value.items[0], text: "Invented", mediaId: "foreign-post" }], true)).toEqual({ status: "held", reason: "origin_changed" });
    expect(f.port.commitQueueAndCapture).not.toHaveBeenCalled();
  });
  it("missing actual durable installation remains held despite valid signature", async () => {
    const f = fixture(); registerAuthenticatedMetaCustomerRequest(f.request); vi.mocked(f.port.readInstallation).mockResolvedValueOnce(null);
    expect(await f.open(f.request)).toEqual({ status: "held", reason: "installation_missing" }); expect(f.port.commitQueueAndCapture).not.toHaveBeenCalled();
  });
});
