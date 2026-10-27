import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { customerDeliveryMediaWitnessIssuedBy, prepareCustomerVoiceAsset } from "../src/lib/customerDeliveryMedia.js";
import type { CustomerDeliveryMediaEndpoint } from "../src/lib/customerDeliveryContracts.js";
import { prepareCustomerVoiceReply, type CustomerVoiceReplyAuthority } from "../src/lib/customerVoiceReply.js";

const text = "Здравствуйте, чем помочь?";
const sealedTextSha256 = createHash("sha256").update(text).digest("hex");
const authority: CustomerVoiceReplyAuthority = {
  voiceReplies: true,
  voiceTrigger: { kind: "inbound_voice", messageId: "synthetic-message", attachmentId: "synthetic-audio" },
  channel: "INSTAGRAM", endpointScopeId: "0d59a1fc-bbf2-45c1-a4ab-2a58fd8a9f5f", accountId: null,
  transportKey: "synthetic-transport", scopeRevision: "7", peer: "synthetic-peer", agentRevisionId: "a".repeat(64),
  eventKey: "b".repeat(64), scopeKey: "c".repeat(64), turnKey: "d".repeat(64),
};
const endpoint: CustomerDeliveryMediaEndpoint = {
  channel: "INSTAGRAM", endpointScopeId: authority.endpointScopeId, accountId: null,
  peerId: authority.peer, transportKey: authority.transportKey, scopeRevision: authority.scopeRevision,
};

describe("customer voice asset preparation cutoff", () => {
  it("does not mint an asset or witness from an encoder that finishes after the cutoff", async () => {
    vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "LIVE");
    vi.stubEnv("CRM_PUBLIC_URL", "https://crm-test.example");
    try {
      const startedAt = Date.now();
      const deadlineAtMs = startedAt + 5_000;
      const preparationDeadlineAtMs = startedAt + 40;
      const prepared = await prepareCustomerVoiceReply({ sealedText: text, sealedTextSha256, authority,
        deadlineAtMs, stillCurrent: async () => true }, {
        synthesize: async () => ({ audioBase64: Buffer.from([1, 0, 2, 0]).toString("base64"), sampleRateHz: 24_000 }),
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") return;

      let resolveEncoder!: (value: Buffer) => void;
      const encoder = vi.fn(() => new Promise<Buffer>(resolve => { resolveEncoder = resolve; }));
      const preparationPromise = prepareCustomerVoiceAsset({ prepared, authority, expectedSealedTextSha256: sealedTextSha256,
        expectedDeadlineAtMs: deadlineAtMs, preparationDeadlineAtMs, stillCurrent: async () => true, endpoint },
      { transcodeToM4a: encoder });
      const asset = await preparationPromise;

      expect(asset).toBeNull();
      expect(encoder).toHaveBeenCalledOnce();
      expect(Date.now()).toBeLessThan(deadlineAtMs);
      expect(customerDeliveryMediaWitnessIssuedBy({ payload: asset?.payload ?? null, eventKey: authority.eventKey,
        agentRevisionId: authority.agentRevisionId, turnKey: authority.turnKey })).toBe(false);

      resolveEncoder(Buffer.from("synthetic-late-encoded-audio"));
      await Promise.resolve();
      expect(asset).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(["", "http://crm-test.example", "https://user:password@crm-test.example", "https://crm-test.example?token=synthetic", "https://crm-test.example#fragment"])("rejects an invalid public voice origin before encoding: %s", async publicBase => {
    vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "LIVE");
    vi.stubEnv("CRM_PUBLIC_URL", publicBase);
    try {
      const deadlineAtMs = Date.now() + 10_000;
      const prepared = await prepareCustomerVoiceReply({ sealedText: text, sealedTextSha256, authority,
        deadlineAtMs, stillCurrent: async () => true }, {
        synthesize: async () => ({ audioBase64: Buffer.from([1, 0, 2, 0]).toString("base64"), sampleRateHz: 24_000 }),
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") return;
      const encoder = vi.fn(async () => Buffer.from("synthetic-audio"));
      expect(await prepareCustomerVoiceAsset({ prepared, authority, expectedSealedTextSha256: sealedTextSha256,
        expectedDeadlineAtMs: deadlineAtMs, preparationDeadlineAtMs: deadlineAtMs - 5_000,
        stillCurrent: async () => true, endpoint }, { transcodeToM4a: encoder })).toBeNull();
      expect(encoder).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
