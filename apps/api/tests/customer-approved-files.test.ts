import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  CUSTOMER_BUYER_GUIDE_CURRENT,
  customerApprovedFileWitnessCurrent,
  customerApprovedFileFollowPromptIssuedBy,
  customerApprovedFilePlanSchema,
  isCurrentIssuedCustomerApprovedFile,
  prepareCustomerApprovedFile,
  customerBuyerGuideRelevant,
  type CustomerApprovedFileAuthority,
  type CustomerApprovedFileDependencies,
  type CustomerApprovedFileEligibility,
} from "../src/lib/customerApprovedFiles.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const filePath = `/uploads/lead-magnets/${campaignId}-1761500000000.pdf`;
const pdf = Buffer.from("%PDF-1.7\nsynthetic approved campaign PDF bytes\n", "ascii");
const authority: CustomerApprovedFileAuthority = {
  endpointScopeId: "22222222-2222-4222-8222-222222222222", accountId: "33333333-3333-4333-8333-333333333333",
  transportKey: "d".repeat(64), scopeRevision: "12", peer: "synthetic-peer",
  agentRevisionId: "a".repeat(64), eventKey: "b".repeat(64), scopeKey: "c".repeat(64), turnKey: "e".repeat(64),
};
const eligibility = (overrides: Partial<CustomerApprovedFileEligibility> = {}): CustomerApprovedFileEligibility => ({
  canSendGuide: true, requested: true, alreadySent: false, awaitingFollowSince: null,
  followerState: true, now: new Date("2026-10-26T12:00:00.000Z"), ...overrides,
});
const row = (overrides: Partial<{
  id: string; enabled: boolean; createdAt: Date; updatedAt: Date; filePath: string | null;
  fileName: string | null; fileSize: number | null; deliverIfUnsure: boolean;
}> = {}) => ({
  id: campaignId, enabled: true, createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-20T00:00:00.000Z"), filePath, fileName: "Памятка.pdf",
  fileSize: pdf.length, deliverIfUnsure: false, ...overrides,
});
function deps(options: {
  campaign?: ReturnType<typeof row> | null;
  bytes?: Buffer | null;
  immutableBytes?: Buffer | null;
  base?: string | undefined;
  url?: string | null;
} = {}): CustomerApprovedFileDependencies {
  const copies = new Map<string, Buffer>();
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return {
    findCurrentCampaign: async () => options.campaign === undefined ? row() : options.campaign,
    readCampaignPdf: async () => options.bytes === undefined ? pdf : options.bytes,
    publishImmutablePdf: async (bytes, expectedHash) => {
      if (sha256(bytes) !== expectedHash) return false;
      const assetPath = `/uploads/msg-files/customer-approved-${expectedHash}.pdf`;
      const existing = copies.get(assetPath);
      if (existing && sha256(existing) !== expectedHash) return false;
      if (!existing) copies.set(assetPath, Buffer.from(bytes));
      return true;
    },
    readImmutablePdf: async (assetPath, expectedHash, length) => {
      const expected = options.immutableBytes === undefined ? copies.get(assetPath) : options.immutableBytes;
      return expected && expected.length === length && sha256(expected) === expectedHash ? Buffer.from(expected) : null;
    },
    publicBase: () => options.base === undefined ? "https://crm.example" : options.base,
    publicUploadUrl: (p) => options.url === undefined ? `https://crm.example${p}` : options.url,
  };
}
function input(overrides: Partial<Parameters<typeof prepareCustomerApprovedFile>[0]> = {}) {
  return {
    assetRef: CUSTOMER_BUYER_GUIDE_CURRENT, channel: "WHATSAPP", authority, eligibility: eligibility(),
    stillCurrent: vi.fn(async () => true), ...overrides,
  };
}

describe("customer approved campaign files", () => {
  it("limits buyer-guide relevance to buyer context or an explicit own buyer-guide request", () => {
    expect(customerBuyerGuideRelevant({ topic: "buyer", currentOwnText: "Сколько стоит эта квартира?" })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "buyer", currentOwnText: "Не надо памятку, спасибо." })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "buyer", currentOwnText: "«Пришлите памятку по покупке квартиры»" })).toBe(false);

    expect(customerBuyerGuideRelevant({ topic: "job", currentOwnText: "Отправьте резюме в PDF, какие документы нужны для работы?" })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "seller", currentOwnText: "Документы на объект отправлю в PDF." })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "unknown", currentOwnText: "У меня есть PDF." })).toBe(false);

    const explicit = "Пришлите памятку по покупке квартиры";
    expect(customerBuyerGuideRelevant({ topic: "job", currentOwnText: explicit })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "seller", currentOwnText: explicit })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "unknown", currentOwnText: explicit })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "unknown", currentOwnText: "Что проверить перед покупкой квартиры?" })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "job", currentOwnText: "Пришлите памятку по покупке квартиры, но не надо." })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "job", currentOwnText: "Равон кунед роҳнамо барои харидани хона." })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "unknown", currentOwnText: "Лозим нест роҳнамо барои харидани хона." })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "unknown", currentOwnText: "Пришлите резюме. Цитата: «Пришлите памятку по покупке квартиры»." })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "unknown", currentOwnText: "" })).toBe(false);
    const now = new Date("2026-10-26T12:00:00.000Z"), awaitingFollowSince = new Date("2026-10-25T12:00:00.000Z");
    const follow = { currentOwnText: "Я подписался, отправьте памятку", awaitingFollowSince, now };
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...follow })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...follow, awaitingFollowSince: new Date("2026-10-18T12:00:00.000Z") })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "job", ...follow })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...follow, currentOwnText: "Не надо памятку" })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...follow, currentOwnText: "Пришлите резюме в PDF" })).toBe(false);
    const accepted = { currentOwnText: "Можно еще раз прислать памятку?", hasAcceptedGuide: true };
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...accepted })).toBe(true);
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...accepted, hasAcceptedGuide: false })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "job", ...accepted })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "seller", ...accepted })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "rent", ...accepted })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...accepted, currentOwnText: "Не отправляйте памятку" })).toBe(false);
    expect(customerBuyerGuideRelevant({ topic: "unknown", ...accepted, currentOwnText: "«Пришлите памятку»" })).toBe(false);
  });

  it("prepares only the current server-selected campaign PDF and issues an opaque in-process result", async () => {
    const turn = input();
    const result = await prepareCustomerApprovedFile(turn, deps());
    const hash = createHash("sha256").update(pdf).digest("hex");
    const immutablePath = `/uploads/msg-files/customer-approved-${hash}.pdf`;
    expect(result).toMatchObject({ status: "prepared", assetRef: CUSTOMER_BUYER_GUIDE_CURRENT,
      sourceId: campaignId, sourceRevision: "2026-10-20T00:00:00.000Z", filePath,
      assetPath: immutablePath, publicUrl: `https://crm.example${immutablePath}`, fileName: "Памятка.pdf", mimeType: "application/pdf",
      byteLength: pdf.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), deliveryKind: "file", needsFollow: false });
    expect(customerApprovedFilePlanSchema.safeParse(result).success).toBe(true);
    expect(customerApprovedFilePlanSchema.safeParse({ ...result, unexpected: true }).success).toBe(false);
    expect(turn.stillCurrent).toHaveBeenCalledTimes(2);
    expect(isCurrentIssuedCustomerApprovedFile(result, authority)).toBe(true);
    expect(isCurrentIssuedCustomerApprovedFile({ ...result }, authority)).toBe(false);
    expect(isCurrentIssuedCustomerApprovedFile(result, { ...authority, turnKey: "f".repeat(64) })).toBe(false);
  });

  it("returns the exact public CRM URL as an Instagram link without using a campaign or model external link", async () => {
    const result = await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM" }), deps());
    const hash = createHash("sha256").update(pdf).digest("hex");
    const immutablePath = `/uploads/msg-files/customer-approved-${hash}.pdf`;
    expect(result).toMatchObject({ status: "prepared", deliveryKind: "link", assetPath: immutablePath, publicUrl: `https://crm.example${immutablePath}` });
    const extraUrl = await prepareCustomerApprovedFile(input(), deps({ url: "https://attacker.example/file.pdf" }));
    expect(extraUrl).toMatchObject({ status: "skip", reason: "invalid_public_url" });
  });

  it("keeps campaign capability, deduplication, request, follow, and seven-day waiting gates", async () => {
    expect(await prepareCustomerApprovedFile(input({ eligibility: eligibility({ canSendGuide: false }) }), deps()))
      .toMatchObject({ status: "skip", reason: "guide_disabled" });
    expect(await prepareCustomerApprovedFile(input({ eligibility: eligibility({ alreadySent: true }) }), deps()))
      .toMatchObject({ status: "skip", reason: "already_delivered" });
    expect(await prepareCustomerApprovedFile(input({ eligibility: eligibility({ requested: false }) }), deps()))
      .toMatchObject({ status: "skip", reason: "not_requested" });
    expect(await prepareCustomerApprovedFile(input({ channel: "TELEGRAM" }), deps()))
      .toMatchObject({ status: "skip", reason: "unsupported_channel" });

    const noFollow = deps({ campaign: row({ deliverIfUnsure: false }) });
    const followPrompt = await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM", eligibility: eligibility({ followerState: false }) }), noFollow);
    expect(followPrompt).toMatchObject({ status: "skip", reason: "follow_required", needsFollow: true, deliverIfUnsure: false });
    expect(customerApprovedFileFollowPromptIssuedBy(followPrompt, authority)).toBe(true);
    expect(customerApprovedFileFollowPromptIssuedBy({ ...followPrompt }, authority)).toBe(false);
    expect(customerApprovedFileFollowPromptIssuedBy(followPrompt, { ...authority, turnKey: "f".repeat(64) })).toBe(false);
    const unknownFollow = await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM", eligibility: eligibility({ followerState: undefined }) }), noFollow);
    expect(unknownFollow).toMatchObject({ status: "skip", reason: "follow_required", needsFollow: true });
    expect(customerApprovedFileFollowPromptIssuedBy(unknownFollow, authority)).toBe(true);

    const withinWindow = new Date("2026-10-20T12:00:00.000Z");
    expect(await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM", eligibility: eligibility({ requested: false,
      awaitingFollowSince: withinWindow, followerState: true }) }), deps())).toMatchObject({ status: "prepared", deliveryKind: "link" });
    const stillWaiting = await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM", eligibility: eligibility({ requested: false,
      awaitingFollowSince: withinWindow, followerState: false }) }), noFollow);
    expect(stillWaiting).toMatchObject({ status: "skip", reason: "awaiting_follow", needsFollow: false });
    expect(customerApprovedFileFollowPromptIssuedBy(stillWaiting, authority)).toBe(false);
    const afterWindow = new Date("2026-10-18T11:59:59.000Z");
    expect(await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM", eligibility: eligibility({ requested: false,
      awaitingFollowSince: afterWindow, followerState: true }) }), deps())).toMatchObject({ status: "skip", reason: "not_requested" });

    expect(await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM", eligibility: eligibility({ followerState: undefined }) }),
      deps({ campaign: row({ deliverIfUnsure: true }) }))).toMatchObject({ status: "prepared", deliveryKind: "link" });
  });

  it("fails closed on invalid campaign paths, metadata, bytes, and non-HTTPS or mismatched public URLs", async () => {
    const read = vi.fn(async () => pdf);
    const badPath = row({ filePath: `/uploads/lead-magnets/${campaignId}-../secret.pdf` });
    expect(await prepareCustomerApprovedFile(input(), { ...deps({ campaign: badPath }), readCampaignPdf: read }))
      .toMatchObject({ status: "skip", reason: "invalid_campaign_file" });
    expect(read).not.toHaveBeenCalled();

    expect(await prepareCustomerApprovedFile(input(), deps({ campaign: row({ fileSize: pdf.length + 1 }) })))
      .toMatchObject({ status: "skip", reason: "file_unavailable" });
    expect(await prepareCustomerApprovedFile(input(), deps({ campaign: row({ fileName: null, fileSize: null }) })))
      .toMatchObject({ status: "prepared", fileName: "Перед покупкой квартиры.pdf", byteLength: pdf.length });
    expect(await prepareCustomerApprovedFile(input(), deps({ bytes: Buffer.from("not a PDF", "ascii") })))
      .toMatchObject({ status: "skip", reason: "file_unavailable" });
    expect(await prepareCustomerApprovedFile(input(), deps({ immutableBytes: Buffer.from("%PDF-1.7\nwrong copy", "ascii") })))
      .toMatchObject({ status: "skip", reason: "file_unavailable" });
    expect(await prepareCustomerApprovedFile(input(), deps({ bytes: Buffer.alloc(25 * 1024 * 1024 + 1, 65) })))
      .toMatchObject({ status: "skip", reason: "file_unavailable" });
    expect(await prepareCustomerApprovedFile(input(), deps({ base: "http://crm.example" })))
      .toMatchObject({ status: "skip", reason: "invalid_public_url" });
    expect(await prepareCustomerApprovedFile(input(), deps({ url: "https://other.example/elsewhere.pdf" })))
      .toMatchObject({ status: "skip", reason: "invalid_public_url" });
    expect(await prepareCustomerApprovedFile(input(), deps({ url: `https://crm.example${filePath}?x=1` })))
      .toMatchObject({ status: "skip", reason: "invalid_public_url" });
  });

  it("rechecks the original turn before and after local preparation and never issues stale evidence", async () => {
    const before = input({ stillCurrent: vi.fn(async () => false) });
    expect(await prepareCustomerApprovedFile(before, deps())).toMatchObject({ status: "skip", reason: "stale_turn" });
    expect(before.stillCurrent).toHaveBeenCalledTimes(1);

    const after = input({ stillCurrent: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) });
    const result = await prepareCustomerApprovedFile(after, deps());
    expect(result).toMatchObject({ status: "skip", reason: "stale_turn" });
    expect(isCurrentIssuedCustomerApprovedFile(result, authority)).toBe(false);
  });

  it("revalidates a persisted witness against current file bytes, source revision, URL and bound channel without a follower lookup", async () => {
    const initialDeps = deps();
    const prepared = await prepareCustomerApprovedFile(input({ channel: "INSTAGRAM" }), initialDeps);
    expect(prepared.status).toBe("prepared");
    const witness = prepared as Extract<typeof prepared, { status: "prepared" }>;
    const stillCurrent = vi.fn(async () => true);
    expect(await customerApprovedFileWitnessCurrent({ witness, channel: "INSTAGRAM", authority, stillCurrent }, initialDeps)).toBe(true);
    expect(stillCurrent).toHaveBeenCalledTimes(2);
    expect(await customerApprovedFileWitnessCurrent({ witness, channel: "WHATSAPP", authority,
      stillCurrent: async () => true }, deps())).toBe(false);
    expect(await customerApprovedFileWitnessCurrent({ witness: { ...witness, sha256: "f".repeat(64) }, channel: "INSTAGRAM",
      authority, stillCurrent: async () => true }, deps())).toBe(false);
    expect(await customerApprovedFileWitnessCurrent({ witness: { ...witness, arbitraryUrl: "https://attacker.example/" }, channel: "INSTAGRAM",
      authority, stillCurrent: async () => true }, deps())).toBe(false);
    expect(await customerApprovedFileWitnessCurrent({ witness, channel: "INSTAGRAM", authority,
      stillCurrent: async () => true }, deps({ bytes: Buffer.from("%PDF-1.7\nchanged bytes", "ascii") }))).toBe(false);
    expect(await customerApprovedFileWitnessCurrent({ witness, channel: "INSTAGRAM", authority,
      stillCurrent: async () => true }, deps({ campaign: row({ updatedAt: new Date("2026-10-21T00:00:00.000Z") }) }))).toBe(false);
    expect(witness.publicUrl).toContain(witness.assetPath);
    expect(witness.publicUrl).not.toContain(witness.filePath);
  });

  it("keeps the prepared historical URL content-addressed while refusing dispatch after the campaign source is replaced", async () => {
    let currentCampaign = row();
    let currentBytes = Buffer.from(pdf);
    const copies = new Map<string, Buffer>();
    const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const injected: CustomerApprovedFileDependencies = {
      findCurrentCampaign: async () => currentCampaign,
      readCampaignPdf: async () => Buffer.from(currentBytes),
      publishImmutablePdf: async (bytes, hash) => {
        if (sha256(bytes) !== hash) return false;
        const asset = `/uploads/msg-files/customer-approved-${hash}.pdf`;
        if (!copies.has(asset)) copies.set(asset, Buffer.from(bytes));
        return sha256(copies.get(asset)!) === hash;
      },
      readImmutablePdf: async (asset, hash, length) => {
        const stored = copies.get(asset);
        return stored && stored.length === length && sha256(stored) === hash ? Buffer.from(stored) : null;
      },
      publicBase: () => "https://crm.example",
      publicUploadUrl: (asset) => `https://crm.example${asset}`,
    };

    const prepared = await prepareCustomerApprovedFile(input(), injected);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const historicalUrl = prepared.publicUrl;
    const historicalPath = prepared.assetPath;
    expect(copies.get(historicalPath)).toEqual(pdf);

    currentBytes = Buffer.from("%PDF-1.7\nreplacement PDF bytes\n", "ascii");
    currentCampaign = row({
      filePath: `/uploads/lead-magnets/${campaignId}-1761600000000.pdf`,
      fileSize: currentBytes.length,
      updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    });
    expect(await customerApprovedFileWitnessCurrent({ witness: prepared, channel: "WHATSAPP", authority,
      stillCurrent: async () => true }, injected)).toBe(false);
    expect(prepared.publicUrl).toBe(historicalUrl);
    expect(historicalUrl).toBe(`https://crm.example${historicalPath}`);
    expect(copies.get(historicalPath)).toEqual(pdf);
  });
});
