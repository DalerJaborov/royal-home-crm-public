import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { customerDeliveryTransportSchema, customerPropertyMediaWitnessSchema, type CustomerDeliveryPayload, type CustomerPropertyMediaWitness } from "./customerDeliveryContracts.js";
import { customerPropertyFocusSchema } from "@royal-home/shared";
import { projectCustomerPropertyFacts, CUSTOMER_PROPERTY_CHARACTERISTICS_SELECT } from "./customerPropertyFacts.js";
import { BOT_OFFER_SELECT, botOfferableWhere } from "./propertyMatch.js";
import { crmPublicBase, publicUploadUrl } from "./crmPublicUrl.js";
import { prisma, type TxClient } from "../db.js";
import { uploadsDir } from "../upload.js";

const MAX_CUSTOMER_PROPERTY_PHOTOS = 5;
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const imageChannelSchema = z.enum(["INSTAGRAM", "FACEBOOK", "WHATSAPP"]);
export const customerPropertyMediaEndpointSchema = customerDeliveryTransportSchema.extend({ channel: imageChannelSchema,
  subscriberId: z.string().min(1).max(512).optional(), peerId: z.string().min(1).max(512) }).strict();
const capabilitySchema = z.object({ photos: z.boolean(), photosPerOffer: z.number().int().min(0).max(MAX_CUSTOMER_PROPERTY_PHOTOS) }).strict();
export type CustomerPropertyMediaEndpoint = z.infer<typeof customerPropertyMediaEndpointSchema>;
export type CustomerPropertyMediaCapability = z.infer<typeof capabilitySchema>;
const endpointWitnessSchema = z.object({ channel: imageChannelSchema, endpointScopeId: z.string().uuid(), accountId: z.string().uuid().nullable(),
  peerId: z.string().min(1).max(512), transportKey: z.string().min(1).max(1024), scopeRevision: z.string().regex(/^\d+$/) }).strict();
const mediaWitnessBodySchema = z.object({ version: z.literal(1), propertyId: z.string().uuid(), shortId: z.number().int().positive(),
  propertyFactsSignature: z.string().regex(/^[a-f0-9]{64}$/), ordinal: z.number().int().min(0).max(MAX_CUSTOMER_PROPERTY_PHOTOS - 1),
  sourcePath: z.string().regex(/^\/uploads\/[^/\\?#]+$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  assetPath: z.string().regex(/^\/uploads\/msg\/customer-property-[a-f0-9]{64}\.jpg$/), assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  publicUrl: z.string().url().refine(value => value.startsWith("https://")), endpoint: endpointWitnessSchema,
  photosPerOffer: z.number().int().min(1).max(MAX_CUSTOMER_PROPERTY_PHOTOS), agentRevisionId: z.string().regex(/^[a-f0-9]{64}$/),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/), scopeKey: z.string().regex(/^[a-f0-9]{64}$/), focusGeneration: z.string().uuid() }).strict();
export { customerPropertyMediaWitnessSchema };
export type CustomerPropertyMediaImage = { payload: Extract<CustomerDeliveryPayload, { kind: "image" }>; witness: CustomerPropertyMediaWitness };
export type CustomerPropertyMediaPlan = { status: "ready"; propertyId: string; shortId: number; factsSignature: string;
  endpoint: z.infer<typeof endpointWitnessSchema>; photosPerOffer: number; images: readonly CustomerPropertyMediaImage[] } |
  { status: "denied" | "unavailable"; reason: string };

export type CustomerPropertyMediaExecutionMode = "OFF" | "PREVIEW" | "LIVE";
/** Absent, malformed, or unexpected values fail closed. */
export function customerPropertyMediaExecutionMode(): CustomerPropertyMediaExecutionMode {
  const value = process.env.CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE;
  return value === "PREVIEW" || value === "LIVE" ? value : "OFF";
}

/** Explicit request classifier over the authenticated current text only. */
export function explicitCustomerPropertyPhotoRequest(text: string): boolean {
  if (text.length > 2000 || /(?:без\s+(?:фото|снимк)|не\s+(?:нужны|надо|нужно)\s+(?:фото|снимк)|фото\s+не\s+надо)/iu.test(text)) return false;
  const photo = /(?:фото|сним|расм|акс|photos?|pictures?)\p{L}*/iu.exec(text);
  const action = /(?:пришл|отправ|скинь|покаж|дайте|можно|хочу|фирист|равон|нишон|дих|send|show|share)\p{L}*/iu.exec(text);
  return !!photo && !!action && Math.abs(photo.index - action.index) <= 100;
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const issuedWitnesses = new WeakMap<object, { eventKey: string; agentRevisionId: string; focusGeneration: string }>();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sourceFilename(uploadPath: string): string | null {
  if (!/^\/uploads\/[^/\\?#]+$/u.test(uploadPath) || uploadPath.includes("..")) return null;
  const filename = uploadPath.slice("/uploads/".length);
  const extension = path.extname(filename).toLowerCase();
  return path.basename(filename) === filename && !filename.startsWith(".") && [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension)
    ? filename : null;
}
async function realUploadFile(uploadPath: string): Promise<{ filename: string; absolute: string; bytes: Buffer } | null> {
  const filename = sourceFilename(uploadPath);
  if (!filename) return null;
  try {
    const root = await fs.realpath(uploadsDir), absolute = path.join(root, filename), real = await fs.realpath(absolute);
    if (!within(root, real)) return null;
    const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > MAX_SOURCE_IMAGE_BYTES) return null;
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!after.isFile() || after.size !== before.size || bytes.length !== after.size || bytes.length > MAX_SOURCE_IMAGE_BYTES) return null;
      return { filename, absolute: real, bytes };
    } finally { await handle.close(); }
  } catch { return null; }
}
async function writeImmutableAsset(mediaPath: string, bytes: Buffer, digest: string): Promise<boolean> {
  try {
    const root = await fs.realpath(uploadsDir), directory = path.join(root, "msg");
    await fs.mkdir(directory, { recursive: true });
    const realDirectory = await fs.realpath(directory);
    if (!within(root, realDirectory)) return false;
    const filename = path.posix.basename(mediaPath), destination = path.join(realDirectory, filename);
    const temporary = path.join(realDirectory, `.customer-property-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
      try { await fs.link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      }
    }
    catch { return false; }
    finally { await fs.unlink(temporary).catch(() => {}); }
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isFile()) return false;
    }
    catch (error) {
      return false;
    }
    const real = await fs.realpath(destination);
    if (!within(realDirectory, real) || real !== destination) return false;
    return sha256(await fs.readFile(real)) === digest;
  } catch { return false; }
}
function witnessFingerprint(body: z.infer<typeof mediaWitnessBodySchema>): string { return sha256(canonical(body)); }

/**
 * Prepare only server-selected, currently offerable CRM property photos.
 * This helper does not authorize a customer turn or send anything: callers must
 * still use the existing principal, inbox/outbox, fence, dispatcher and receipt.
 * No model-supplied URL or file path is accepted by this API.
 */
export async function prepareCustomerPropertyMedia(input: {
  propertyId: string; endpoint: CustomerPropertyMediaEndpoint; capability: CustomerPropertyMediaCapability;
  agentRevisionId: string; eventKey: string; scopeKey: string; focusGeneration: string;
  db?: Pick<TxClient, "property" | "settings">;
}): Promise<CustomerPropertyMediaPlan> {
  try {
    const endpoint = customerPropertyMediaEndpointSchema.safeParse(input.endpoint), capability = capabilitySchema.safeParse(input.capability);
    if (!endpoint.success || !capability.success) return { status: "denied", reason: "invalid_media_context" };
    const channel = endpoint.data.channel;
    if (!capability.data.photos || capability.data.photosPerOffer < 1) return { status: "denied", reason: "photos_disabled" };
    const propertyId = z.string().uuid().safeParse(input.propertyId);
    if (!propertyId.success) return { status: "denied", reason: "invalid_property_id" };
    const agentRevisionId = z.string().regex(/^[a-f0-9]{64}$/).safeParse(input.agentRevisionId),
      eventKey = z.string().regex(/^[a-f0-9]{64}$/).safeParse(input.eventKey),
      scopeKey = z.string().regex(/^[a-f0-9]{64}$/).safeParse(input.scopeKey), focusGeneration = z.string().uuid().safeParse(input.focusGeneration);
    if (!agentRevisionId.success || !eventKey.success || !scopeKey.success || !focusGeneration.success) return { status: "denied", reason: "invalid_media_context" };
    const publicBase = crmPublicBase();
    if (!publicBase) return { status: "unavailable", reason: "public_media_origin_unavailable" };

    const db = input.db ?? prisma;
    const row = await db.property.findFirst({ where: { id: propertyId.data, status: "AVAILABLE", AND: [botOfferableWhere()] },
      select: { ...BOT_OFFER_SELECT, id: true, shortId: true, price: true, currency: true, updatedAt: true,
        ...CUSTOMER_PROPERTY_CHARACTERISTICS_SELECT, district: { select: { name: true, city: true } },
        photos: { orderBy: { order: "asc" }, take: capability.data.photosPerOffer, select: { url: true } } } });
    if (!row) return { status: "unavailable", reason: "property_not_currently_offerable" };
    const facts = projectCustomerPropertyFacts(row, channel);
    if (!facts || facts.availability !== "AVAILABLE") return { status: "unavailable", reason: "property_facts_not_public" };

    const images: CustomerPropertyMediaImage[] = [], seenSources = new Set<string>();
    for (const [photoIndex, photo] of row.photos.entries()) {
      const source = await realUploadFile(photo.url);
      if (!source) continue;
      const sourceSha256 = sha256(source.bytes);
      if (seenSources.has(sourceSha256)) continue;
      let jpeg: Buffer;
      try { jpeg = await sharp(source.bytes, { limitInputPixels: 80_000_000 }).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer(); }
      catch { continue; }
      if (!jpeg.length || jpeg.length > MAX_IMAGE_BYTES) continue;
      const assetSha256 = sha256(jpeg), assetPath = `/uploads/msg/customer-property-${assetSha256}.jpg`;
      if (!await writeImmutableAsset(assetPath, jpeg, assetSha256)) return { status: "unavailable", reason: "immutable_asset_unavailable" };
      const publicUrl = publicUploadUrl(assetPath);
      if (!publicUrl || publicUrl !== `${publicBase}${assetPath}` || !publicUrl.startsWith("https://")) {
        return { status: "unavailable", reason: "public_media_url_unavailable" };
      }
      const body = mediaWitnessBodySchema.parse({ version: 1, propertyId: facts.propertyId, shortId: facts.shortId,
        propertyFactsSignature: facts.signature, ordinal: photoIndex, sourcePath: photo.url, sourceSha256,
        assetPath, assetSha256, publicUrl, endpoint: { channel, endpointScopeId: endpoint.data.endpointScopeId,
          accountId: endpoint.data.accountId, peerId: endpoint.data.peerId, transportKey: endpoint.data.transportKey,
          scopeRevision: endpoint.data.scopeRevision }, photosPerOffer: capability.data.photosPerOffer,
        agentRevisionId: agentRevisionId.data, eventKey: eventKey.data, scopeKey: scopeKey.data, focusGeneration: focusGeneration.data });
      const witness = customerPropertyMediaWitnessSchema.parse({ ...body, fingerprint: witnessFingerprint(body) });
      issuedWitnesses.set(witness, { eventKey: eventKey.data, agentRevisionId: agentRevisionId.data, focusGeneration: focusGeneration.data });
      images.push({ payload: { kind: "image", url: publicUrl, mediaWitness: witness }, witness });
      seenSources.add(sourceSha256);
    }
    if (!images.length) return { status: "unavailable", reason: "no_sendable_property_photos" };
    return Object.freeze({ status: "ready", propertyId: facts.propertyId, shortId: facts.shortId, factsSignature: facts.signature,
      endpoint: endpointWitnessSchema.parse({ channel, endpointScopeId: endpoint.data.endpointScopeId,
        accountId: endpoint.data.accountId, peerId: endpoint.data.peerId, transportKey: endpoint.data.transportKey,
        scopeRevision: endpoint.data.scopeRevision }), photosPerOffer: capability.data.photosPerOffer, images: Object.freeze(images) });
  } catch { return { status: "unavailable", reason: "property_media_unavailable" }; }
}

/** Stored witness JSON is data, never authority; compare it to a freshly prepared server plan. */
export function customerPropertyMediaWitnessMatches(expected: unknown, actual: unknown): boolean {
  const left = customerPropertyMediaWitnessSchema.safeParse(expected), right = customerPropertyMediaWitnessSchema.safeParse(actual);
  if (!left.success || !right.success) return false;
  const { fingerprint: leftFingerprint, ...leftBody } = left.data;
  const { fingerprint: rightFingerprint, ...rightBody } = right.data;
  return leftFingerprint === witnessFingerprint(leftBody) && rightFingerprint === witnessFingerprint(rightBody) &&
    canonical(left.data) === canonical(right.data);
}

/** Only the original in-process asset preparation may authorize outbox planning. */
export function customerPropertyMediaWitnessIssuedBy(input: { witness: unknown; eventKey: string; agentRevisionId: string; focusGeneration: string }): boolean {
  if (!input.witness || typeof input.witness !== "object") return false;
  const issued = issuedWitnesses.get(input.witness);
  return !!issued && issued.eventKey === input.eventKey && issued.agentRevisionId === input.agentRevisionId &&
    issued.focusGeneration === input.focusGeneration;
}

export async function customerPropertyMediaFocusCurrent(input: { db: Pick<TxClient, "$queryRaw">; conversationId: string;
  scopeKey: string; eventKey: string; witness: unknown }): Promise<boolean> {
  try {
    const witness = customerPropertyMediaWitnessSchema.safeParse(input.witness);
    if (!witness.success || witness.data.eventKey !== input.eventKey) return false;
    const [row] = await input.db.$queryRaw<Array<{ customerPropertyFocus: unknown }>>`SELECT "customerPropertyFocus" FROM "BotConversation" WHERE "id"=${input.conversationId}`;
    const focus = customerPropertyFocusSchema.safeParse(row?.customerPropertyFocus);
    return !!focus.success && focus.data.scopeKey === input.scopeKey && focus.data.eventKey === input.eventKey &&
      focus.data.generation === witness.data.focusGeneration && focus.data.status === "resolved" &&
      focus.data.propertyId === witness.data.propertyId;
  } catch { return false; }
}

/** Revalidate a persisted image against current settings, publication, source bytes,
 * immutable JPEG bytes, endpoint, original ticket and pinned revision. No transform
 * or model/provider call is performed here. */
export async function customerPropertyMediaWitnessCurrent(input: {
  witness: unknown; endpoint: unknown; eventKey: string; agentRevisionId: string; focusGeneration: string;
  db?: Pick<TxClient, "property" | "settings">;
}): Promise<boolean> {
  try {
    if (customerPropertyMediaExecutionMode() !== "LIVE") return false;
  const parsed = customerPropertyMediaWitnessSchema.safeParse(input.witness), endpoint = customerPropertyMediaEndpointSchema.safeParse(input.endpoint);
    if (!parsed.success || !endpoint.success) return false;
    const witness = parsed.data, { fingerprint, ...body } = witness;
    if (fingerprint !== witnessFingerprint(body) || witness.eventKey !== input.eventKey || witness.agentRevisionId !== input.agentRevisionId ||
        witness.focusGeneration !== input.focusGeneration || canonical(witness.endpoint) !== canonical({ channel: endpoint.data.channel,
          endpointScopeId: endpoint.data.endpointScopeId, accountId: endpoint.data.accountId, peerId: endpoint.data.peerId,
          transportKey: endpoint.data.transportKey, scopeRevision: endpoint.data.scopeRevision })) return false;
    const db = input.db ?? prisma;
    const settings = await db.settings.findUnique({ where: { id: "singleton" }, select: { botCanSendPhotos: true, botPhotosPerOffer: true } });
    const cap = Math.max(0, Math.min(MAX_CUSTOMER_PROPERTY_PHOTOS, settings?.botPhotosPerOffer ?? 0));
    if (settings?.botCanSendPhotos !== true || cap < 1 || cap !== witness.photosPerOffer) return false;
    const row = await db.property.findFirst({ where: { id: witness.propertyId, status: "AVAILABLE", AND: [botOfferableWhere()] },
      select: { ...BOT_OFFER_SELECT, id: true, shortId: true, price: true, currency: true, updatedAt: true,
        ...CUSTOMER_PROPERTY_CHARACTERISTICS_SELECT, district: { select: { name: true, city: true } },
        photos: { orderBy: { order: "asc" }, take: cap, select: { url: true } } } });
    if (!row) return false;
    const facts = projectCustomerPropertyFacts(row, endpoint.data.channel);
    if (!facts || facts.availability !== "AVAILABLE" || facts.propertyId !== witness.propertyId || facts.shortId !== witness.shortId ||
        facts.signature !== witness.propertyFactsSignature) return false;
    const selectedPhoto = row.photos[witness.ordinal];
    if (!selectedPhoto || selectedPhoto.url !== witness.sourcePath) return false;
    const selectedSource = await realUploadFile(selectedPhoto.url);
    if (!selectedSource || sha256(selectedSource.bytes) !== witness.sourceSha256) return false;
    for (const photo of row.photos.slice(0, witness.ordinal)) {
      const prior = await realUploadFile(photo.url);
      if (prior && sha256(prior.bytes) === witness.sourceSha256) return false;
    }
    const publicBase = crmPublicBase();
    if (!publicBase || witness.assetPath !== `/uploads/msg/customer-property-${witness.assetSha256}.jpg` ||
        witness.publicUrl !== `${publicBase}${witness.assetPath}` || publicUploadUrl(witness.assetPath) !== witness.publicUrl) return false;
    const root = await fs.realpath(uploadsDir), assetFile = path.join(root, "msg", path.posix.basename(witness.assetPath));
    const real = await fs.realpath(assetFile), stat = await fs.lstat(assetFile);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES || real !== assetFile || !within(root, real)) return false;
    const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > MAX_IMAGE_BYTES) return false;
      const bytes = await handle.readFile(), after = await handle.stat();
      return after.isFile() && after.size === before.size && bytes.length === after.size && bytes.length <= MAX_IMAGE_BYTES &&
        sha256(bytes) === witness.assetSha256;
    } finally { await handle.close(); }
  } catch { return false; }
}
