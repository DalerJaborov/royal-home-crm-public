import { describe, expect, it, vi } from "vitest";
import type { CustomerPropertyAdmission } from "@royal-home/shared";
import {
  customerPropertyEvidenceFromMeta,
  customerPropertyEvidenceFromText,
} from "../src/lib/customerPropertyEvidence.js";
import {
  resolveCustomerPropertyEvidence,
  type CustomerPropertyRegistry,
} from "../src/lib/customerPropertyResolver.js";

const property = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: Pick<CustomerPropertyAdmission, "conversationId" | "scopeKey" | "accountId" | "channel"> = {
  conversationId: property(100), scopeKey: "a".repeat(64), accountId: property(101), channel: "INSTAGRAM",
};

function registry(overrides: Partial<CustomerPropertyRegistry> = {}): CustomerPropertyRegistry {
  return {
    ad: vi.fn(async () => null),
    media: vi.fn(async () => []),
    url: vi.fn(async () => []),
    reply: vi.fn(async () => []),
    selector: vi.fn(async (reference: string) => {
      const id = Number(reference.replace(/^short:/, ""));
      return id > 0 ? [property(id)] : [];
    }),
    ...overrides,
  };
}

describe("customer property independent review regressions", () => {
  it("does not pick the first object in an explicit two-object question", async () => {
    const evidence = customerPropertyEvidenceFromText("Сравни объект 123 и объект 456, какая цена?");
    const result = await resolveCustomerPropertyEvidence(evidence, scope, registry());
    expect(result).toMatchObject({ status: "ambiguous", propertyId: null });
    expect(result.candidates).toEqual(expect.arrayContaining([property(123), property(456)]));
  });

  it("keeps one object when its selector is repeated", async () => {
    const evidence = customerPropertyEvidenceFromText("Объект 123, уточню: объект 123. Цена?");
    expect(await resolveCustomerPropertyEvidence(evidence, scope, registry()))
      .toMatchObject({ status: "resolved", propertyId: property(123) });
  });

  it.each(["audio", "image"])("does not treat a WhatsApp %s file ID as a new property", (attachmentType) => {
    const evidence = customerPropertyEvidenceFromMeta({
      channel: "WHATSAPP", senderId: "fake-peer", text: "", attachmentType,
      mediaId: "54321", messageId: "fake-incoming",
    });
    expect(evidence).toEqual([]);
  });

  it("resolves the Instagram publication ID when the shared reel URL is a CDN file", async () => {
    const evidence = customerPropertyEvidenceFromMeta({
      channel: "INSTAGRAM", senderId: "fake-peer", text: "Какая цена?", messageId: "fake-reel",
      attachmentType: "share", attachmentMediaId: "54321",
      attachmentUrl: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=fictional",
    });
    const reads = registry({ media: vi.fn(async (id) => id === "54321" ? [property(1)] : []) });
    expect(await resolveCustomerPropertyEvidence(evidence, scope, reads))
      .toMatchObject({ status: "resolved", propertyId: property(1) });
  });

  it("keeps conflicting objects in extra attachments instead of choosing the first share", async () => {
    const evidence = customerPropertyEvidenceFromMeta({
      channel: "INSTAGRAM", senderId: "fake-peer", text: "Сколько стоят?", messageId: "fake-shares",
      attachmentType: "share", attachmentUrl: "https://www.instagram.com/reel/FIRST/",
      extraAttachments: [{ type: "share", url: "https://www.instagram.com/reel/SECOND/" }],
    });
    const reads = registry({ url: vi.fn(async (url) => url.kind === "instagram"
      ? [property(url.shortcode === "FIRST" ? 1 : 2)] : []) });
    expect(await resolveCustomerPropertyEvidence(evidence, scope, reads))
      .toMatchObject({ status: "ambiguous", propertyId: null });
  });

  it("does not infer uniqueness from intersecting two truncated candidate lists", async () => {
    const adIds = Array.from({ length: 9 }, (_, n) => property(n + 1));
    const mediaIds = [property(1), ...Array.from({ length: 8 }, (_, n) => property(n + 20))];
    // Nine is the registry overflow sentinel, not proof that all matches were read.
    const reads = registry({ ad: vi.fn(async () => ({ ids: adIds })), media: vi.fn(async () => mediaIds) });
    const result = await resolveCustomerPropertyEvidence([
      { kind: "ad", origin: "referral", reference: "fake-ad", secondaryReference: "fake-media" },
    ], scope, reads);
    expect(result).toMatchObject({ status: "ambiguous", propertyId: null });
  });

  it("does not read a CRM property by pathname copied onto a foreign origin", async () => {
    const reads = registry({ url: vi.fn(async () => [property(1)]) });
    const evidence = customerPropertyEvidenceFromText("https://foreign.example/listing/by-crm/00000000-0000-4000-8000-000000000001");
    expect(await resolveCustomerPropertyEvidence(evidence, scope, reads))
      .toMatchObject({ status: "denied", propertyId: null });
    expect(reads.url).not.toHaveBeenCalled();
  });
});
