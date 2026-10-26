import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const { testPaths } = vi.hoisted(() => ({ testPaths: { uploadsDir: "" } }));
vi.mock("../src/upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/upload.js")>()),
  get uploadsDir() { return testPaths.uploadsDir; },
}));

const { prepareCustomerPropertyMedia, customerPropertyMediaWitnessMatches, customerPropertyMediaWitnessCurrent,
  customerPropertyMediaWitnessIssuedBy, explicitCustomerPropertyPhotoRequest, customerPropertyMediaExecutionMode } = await import("../src/lib/customerPropertyMedia.js");
const { customerDeliveryPayloadSchema } = await import("../src/lib/customerDeliveryContracts.js");

const PROPERTY_ID = "00000000-0000-4000-8000-000000000123";
const SCOPE_ID = "00000000-0000-4000-8000-000000000456";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000789";
const endpoint = { endpointScopeId: SCOPE_ID, channel: "WHATSAPP", accountId: ACCOUNT_ID,
  accountExternalId: "meta-account-1", transportKey: "wa:account-1:peer-1", scopeRevision: "7", peerId: "peer-1" };
const capability = { photos: true, photosPerOffer: 2 };
const mediaContext = { agentRevisionId: "c".repeat(64), eventKey: "a".repeat(64),
  scopeKey: "b".repeat(64), focusGeneration: "00000000-0000-4000-8000-000000000111" };
const row = (photos: string[] = ["/uploads/first.png", "/uploads/second.jpg", "/uploads/third.png"]) => ({
  id: PROPERTY_ID, shortId: 731, price: "125000", currency: "USD", updatedAt: new Date("2026-10-26T00:00:00.000Z"),
  type: "APARTMENT", rooms: 2, areaSqm: "64", landAreaSotka: null, floor: 4, totalFloors: 9,
  condition: "GOOD", marketType: "SECONDARY", stage: null,
  status: "AVAILABLE", deletedAt: null, offSite: false, publishedOnSite: true, instagramUrl: null,
  publishedChannels: [], siteListingId: 99, district: { name: "Сино", city: "Душанбе" },
  photos: photos.map(url => ({ url })),
});
const dbFor = (record: ReturnType<typeof row> | null, feature = { botCanSendPhotos: true, botPhotosPerOffer: 2 }) => ({
  property: { findFirst: vi.fn(async () => record) }, settings: { findUnique: vi.fn(async () => feature) },
});
let uploadRoot = "";

beforeEach(async () => {
  uploadRoot = await mkdtemp(path.join(os.tmpdir(), "customer-property-media-"));
  testPaths.uploadsDir = uploadRoot;
  vi.stubEnv("CRM_PUBLIC_URL", "https://crm-test.example/");
  await mkdir(uploadRoot, { recursive: true });
  const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 180, g: 40, b: 25 } } }).png().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  await writeFile(path.join(uploadRoot, "first.png"), png);
  await writeFile(path.join(uploadRoot, "second.jpg"), jpeg);
  await writeFile(path.join(uploadRoot, "third.png"), png);
});
afterEach(async () => { vi.unstubAllEnvs(); if (uploadRoot) await rm(uploadRoot, { recursive: true, force: true }); });

describe("customer property media parity port", () => {
  it("defaults execution mode to OFF and rejects invalid values", () => {
    expect(customerPropertyMediaExecutionMode()).toBe("OFF");
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "invalid"); expect(customerPropertyMediaExecutionMode()).toBe("OFF");
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "PREVIEW"); expect(customerPropertyMediaExecutionMode()).toBe("PREVIEW");
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "LIVE"); expect(customerPropertyMediaExecutionMode()).toBe("LIVE");
  });

  it("recognizes explicit photo requests in Russian, Tajik, and English without treating denials as requests", () => {
    expect(explicitCustomerPropertyPhotoRequest("Можно отправить фото этой квартиры?" )).toBe(true);
    expect(explicitCustomerPropertyPhotoRequest("Расмҳояшро фиристед, лутфан." )).toBe(true);
    expect(explicitCustomerPropertyPhotoRequest("Please send photos." )).toBe(true);
    expect(explicitCustomerPropertyPhotoRequest("Не нужны фото, расскажите про район." )).toBe(false);
    expect(explicitCustomerPropertyPhotoRequest("Фотографии хорошие." )).toBe(false);
  });

  it("does not treat the feature gate as authority when the current photo capability is off", async () => {
    const db = dbFor(row());
    const result = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext,
      capability: { photos: false, photosPerOffer: 2 }, db: db as never });
    expect(result).toEqual({ status: "denied", reason: "photos_disabled" });
    expect(db.property.findFirst).not.toHaveBeenCalled();
  });

  it("requires an exact supported Meta endpoint and denies the website channel", async () => {
    const db = dbFor(row());
    const result = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID,
      endpoint: { ...endpoint, channel: "WEBSITE" } as never, ...mediaContext, capability, db: db as never });
    expect(result).toEqual({ status: "denied", reason: "invalid_media_context" });
    expect(db.property.findFirst).not.toHaveBeenCalled();
  });

  it("uses only current offerable CRM photos, ordered and capped by the existing photos-per-offer value", async () => {
    const db = dbFor(row());
    const result = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext, capability, db: db as never });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(db.property.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: PROPERTY_ID, status: "AVAILABLE", AND: [expect.any(Object)] },
      select: expect.objectContaining({ photos: { orderBy: { order: "asc" }, take: 2, select: { url: true } } }),
    }));
    expect(result.images).toHaveLength(2);
    expect(result.images.map(item => item.witness.sourcePath)).toEqual(["/uploads/first.png", "/uploads/second.jpg"]);
    expect(result.images[0].payload.url).toMatch(/^https:\/\/crm-test\.example\/uploads\/msg\/customer-property-[a-f0-9]{64}\.jpg$/);
    expect(await readFile(path.join(uploadRoot, "msg", path.basename(result.images[0].witness.assetPath)))).toBeTruthy();
    expect(result.images[0].witness.endpoint).toEqual(expect.objectContaining({
      channel: "WHATSAPP", endpointScopeId: SCOPE_ID, accountId: ACCOUNT_ID, peerId: "peer-1", scopeRevision: "7",
    }));
  });

  it("fails closed for unpublished, deleted, off-site, or unavailable property records", async () => {
    for (const unavailable of [null, { ...row(), status: "SOLD" }, { ...row(), offSite: true }, { ...row(), deletedAt: new Date() }]) {
      const result = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext, capability,
        db: dbFor(unavailable as ReturnType<typeof row> | null) as never });
      expect(result.status).toBe("unavailable");
      expect(result).not.toHaveProperty("images");
    }
  });

  it("creates content-addressed immutable JPEGs and binds each witness to source bytes and the exact endpoint", async () => {
    const first = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext, capability, db: dbFor(row(["/uploads/first.png"])) as never });
    const repeat = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext, capability, db: dbFor(row(["/uploads/first.png"])) as never });
    expect(first.status).toBe("ready");
    expect(repeat.status).toBe("ready");
    if (first.status !== "ready" || repeat.status !== "ready") return;
    expect(customerPropertyMediaWitnessIssuedBy({ witness: first.images[0].witness, eventKey: mediaContext.eventKey,
      agentRevisionId: mediaContext.agentRevisionId, focusGeneration: mediaContext.focusGeneration })).toBe(true);
    expect(customerPropertyMediaWitnessIssuedBy({ witness: structuredClone(first.images[0].witness), eventKey: mediaContext.eventKey,
      agentRevisionId: mediaContext.agentRevisionId, focusGeneration: mediaContext.focusGeneration })).toBe(false);
    expect(customerPropertyMediaWitnessMatches(first.images[0].witness,
      { ...first.images[0].witness, agentRevisionId: "00000000-0000-4000-8000-000000000999" })).toBe(false);
    expect(first.images[0].witness.assetPath).toBe(repeat.images[0].witness.assetPath);
    expect(customerPropertyMediaWitnessMatches(first.images[0].witness, repeat.images[0].witness)).toBe(true);

    const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 25, g: 150, b: 180 } } }).png().toBuffer();
    await writeFile(path.join(uploadRoot, "first.png"), png);
    const changed = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext, capability, db: dbFor(row(["/uploads/first.png"])) as never });
    expect(changed.status).toBe("ready");
    if (changed.status !== "ready") return;
    expect(customerPropertyMediaWitnessMatches(first.images[0].witness, changed.images[0].witness)).toBe(false);
    const otherEndpoint = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID,
      endpoint: { ...endpoint, peerId: "peer-2", transportKey: "wa:account-1:peer-2" }, ...mediaContext, capability,
      db: dbFor(row(["/uploads/first.png"])) as never });
    expect(otherEndpoint.status).toBe("ready");
    if (otherEndpoint.status === "ready") expect(customerPropertyMediaWitnessMatches(changed.images[0].witness, otherEndpoint.images[0].witness)).toBe(false);
  });

  it("requires the current server witness and rejects legacy URL-only images or mismatched revision witnesses", async () => {
    const prepared = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext, capability,
      db: dbFor(row(["/uploads/first.png"])) as never });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const payload = prepared.images[0].payload;
    expect(customerDeliveryPayloadSchema.safeParse(payload).success).toBe(true);
    expect(customerDeliveryPayloadSchema.safeParse({ kind: "image", url: "https://attacker.example/image.jpg" }).success).toBe(false);
    const stale = { ...payload, mediaWitness: { ...payload.mediaWitness, agentRevisionId: "d".repeat(64) } };
    expect(customerDeliveryPayloadSchema.safeParse(stale).success).toBe(true);
    expect(customerPropertyMediaWitnessMatches(payload.mediaWitness, stale.mediaWitness)).toBe(false);
    expect(customerDeliveryPayloadSchema.safeParse({ ...payload, mediaWitness: { ...payload.mediaWitness,
      agentRevisionId: "00000000-0000-4000-8000-000000000999" } }).success).toBe(false);
  });

  it("revalidates the exact photo setting, cap, current property and bytes immediately before a managed send", async () => {
    const db = dbFor(row(["/uploads/first.png"]));
    const prepared = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, ...mediaContext, capability, db: db as never });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    const witness = prepared.images[0].witness;
    const args = { witness, endpoint, eventKey: mediaContext.eventKey, agentRevisionId: mediaContext.agentRevisionId,
      focusGeneration: mediaContext.focusGeneration, db: db as never };
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "LIVE");
    expect(await customerPropertyMediaWitnessCurrent(args)).toBe(true);
    expect(await customerPropertyMediaWitnessCurrent({ ...args, agentRevisionId: "d".repeat(64) })).toBe(false);
    expect(await customerPropertyMediaWitnessCurrent({ ...args, db: dbFor(row(["/uploads/first.png"]),
      { botCanSendPhotos: false, botPhotosPerOffer: 2 }) as never })).toBe(false);
    expect(await customerPropertyMediaWitnessCurrent({ ...args, db: dbFor(row(["/uploads/first.png"]),
      { botCanSendPhotos: true, botPhotosPerOffer: 1 }) as never })).toBe(false);
    const replacement = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 30, g: 100, b: 210 } } }).png().toBuffer();
    await writeFile(path.join(uploadRoot, "first.png"), replacement);
    expect(await customerPropertyMediaWitnessCurrent(args)).toBe(false);
  });

  it("rejects arbitrary remote URLs, traversal, missing files, and a tampered content-addressed asset", async () => {
    const invalid = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, capability,
      ...mediaContext,
      db: dbFor(row(["https://evil.example/image.jpg", "/uploads/../secret.jpg", "/uploads/missing.jpg"])) as never });
    expect(invalid).toEqual({ status: "unavailable", reason: "no_sendable_property_photos" });

    const prepared = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, capability,
      ...mediaContext,
      db: dbFor(row(["/uploads/first.png"])) as never });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    await writeFile(path.join(uploadRoot, "msg", path.basename(prepared.images[0].witness.assetPath)), Buffer.from("tampered"));
    const replay = await prepareCustomerPropertyMedia({ propertyId: PROPERTY_ID, endpoint, capability,
      ...mediaContext,
      db: dbFor(row(["/uploads/first.png"])) as never });
    expect(replay).toEqual({ status: "unavailable", reason: "immutable_asset_unavailable" });
  });
});
