import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { crmPublicBase, publicUploadUrl } from "./crmPublicUrl.js";
import { prisma } from "../db.js";
import { uploadsDir } from "../upload.js";
import { customerOwnUnquotedText } from "../ai/customerAgentConversationPolicy.js";

/** The only model-facing file reference for this first, bounded implementation. */
export const CUSTOMER_BUYER_GUIDE_CURRENT = "CUSTOMER_BUYER_GUIDE_CURRENT" as const;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const AWAIT_FOLLOW_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_CHANNELS = new Set(["INSTAGRAM", "WHATSAPP", "FACEBOOK"]);
const DEFAULT_GUIDE_FILE_NAME = "Перед покупкой квартиры.pdf";

/** Relevance guard for the one buyer guide; this is not an intent grant. */
export function customerBuyerGuideRelevant(input: {
  topic: "buyer" | "seller" | "job" | "rent" | "unknown";
  currentOwnText: string;
  awaitingFollowSince?: Date | null;
  hasAcceptedGuide?: boolean;
  now?: Date;
}): boolean {
  if (!input || typeof input.currentOwnText !== "string" || !input.currentOwnText.trim()) return false;
  const text = customerOwnUnquotedText(input.currentOwnText).normalize("NFKC").toLowerCase()
    .replace(/ё/gu, "е").replace(/[!?？.,;:]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text) return false;
  const guide = /(?:памятк\p{L}*|чек\s*[-–]?\s*лист\p{L}*|гайд\p{L}*|роҳнамо\p{L}*)/iu;
  const explicitNoGuide = /(?:(?:не\s+(?:надо|нужно|нужна|нужен|нужны|хочу|присыл\p{L}*|отправ\p{L}*)\s+(?:мне\s+)?(?:эту\s+)?(?:памятк\p{L}*|чек\s*[-–]?\s*лист\p{L}*|гайд\p{L}*|роҳнамо\p{L}*)|(?:лозим\s+нест|даркор\s+нест)\s+(?:ин\s+)?(?:памятк\p{L}*|чек\s*[-–]?\s*лист\p{L}*|гайд\p{L}*|роҳнамо\p{L}*))|(?:(?:памятк\p{L}*|чек\s*[-–]?\s*лист\p{L}*|гайд\p{L}*|роҳнамо\p{L}*)[^.!?？\n]{0,24}(?:не\s+(?:надо|нужно|нужна|нужен|нужны|присыл\p{L}*|отправ\p{L}*)|лозим\s+нест|даркор\s+нест)))/iu;
  if (explicitNoGuide.test(text)) return false;
  if (input.topic === "buyer") return true;

  const purchase = /(?:покупк\p{L}*|купить|покупател\p{L}*|харид\p{L}*|харидан|харидани)/iu;
  const housing = /(?:квартир\p{L}*|дом\p{L}*|хона\p{L}*|манзил\p{L}*)/iu;
  const asksForAsset = /(?:пришл\p{L}*|отправ\p{L}*|скин\p{L}*|дай(?:те)?|хочу|нужн\p{L}*|можно\s+(?:мне\s+)?получить|есть\s+ли|фирист\p{L}*|равон\s+(?:кунед|кун)|мехоҳ\p{L}*)/iu;
  const asksForRepeat = /(?:^|\s)можно\s+(?:(?:мне|нам)\s+)?(?:еще\s+раз\s+)?прислать(?:\s|$)/iu;
  const now = input.now ?? new Date(), awaiting = input.awaitingFollowSince;
  const activeFollow = awaiting instanceof Date && Number.isFinite(awaiting.getTime()) &&
    now.getTime() >= awaiting.getTime() && now.getTime() - awaiting.getTime() < AWAIT_FOLLOW_MS;
  // An accepted own-dialog follow instruction supplies topic continuity only.
  // The current person must still ask for this guide, and the current endpoint
  // must independently confirm follower eligibility before any file is issued.
  if (input.topic === "unknown" && (activeFollow || input.hasAcceptedGuide === true) && guide.test(text) &&
      (asksForAsset.test(text) || asksForRepeat.test(text))) return true;
  const specificBuyerGuide = guide.test(text) && purchase.test(text) && housing.test(text) && asksForAsset.test(text);
  const specificBuyerAdvice = /(?:что\s+(?:проверить|учесть|посмотреть)\s+(?:нужно\s+)?(?:перед|при)\s+покупк\p{L}*\s+(?:квартир\p{L}*|дом\p{L}*)|(?:ҳангоми|вакти)\s+харидани\s+(?:хона|манзил)\s+(?:чиро\s+)?(?:санҷ\p{L}*|диққат\s+диҳ\p{L}*))/iu.test(text);
  return specificBuyerGuide || specificBuyerAdvice;
}

export interface CustomerApprovedFileAuthority {
  endpointScopeId: string;
  accountId: string | null;
  transportKey: string;
  scopeRevision: string;
  peer: string;
  agentRevisionId: string;
  eventKey: string;
  scopeKey: string;
  turnKey: string;
}

export interface CustomerApprovedFileEligibility {
  canSendGuide: boolean;
  requested: boolean;
  alreadySent: boolean;
  awaitingFollowSince: Date | null;
  /** A server-verified value from the current IG endpoint. Omitted means unknown. */
  followerState?: boolean;
  now?: Date;
}

interface CampaignFileRow {
  id: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  filePath: string | null;
  fileName: string | null;
  fileSize: number | null;
  deliverIfUnsure: boolean;
}

export type CustomerApprovedFileSkipReason =
  | "invalid_request"
  | "stale_turn"
  | "unsupported_channel"
  | "guide_disabled"
  | "already_delivered"
  | "not_requested"
  | "awaiting_follow"
  | "follow_required"
  | "campaign_unavailable"
  | "invalid_campaign_file"
  | "file_unavailable"
  | "invalid_public_url";

export type CustomerApprovedFilePlan =
  | { status: "skip"; reason: CustomerApprovedFileSkipReason; needsFollow: boolean; deliverIfUnsure?: boolean }
  | CustomerApprovedFilePrepared;

export interface CustomerApprovedFileDependencies {
  /** Return the same server-selected current campaign file as the legacy guide. */
  findCurrentCampaign(): Promise<CampaignFileRow | null>;
  /** Read only a validated campaign path as a bounded, non-symlink regular file. */
  readCampaignPdf(campaignId: string, filePath: string): Promise<Buffer | null>;
  /** Atomically publish approved source bytes to their content-addressed public path. */
  publishImmutablePdf(bytes: Buffer, sha256: string): Promise<boolean>;
  /** Read only a canonical immutable copy with matching bytes/hash. */
  readImmutablePdf(assetPath: string, sha256: string, byteLength: number): Promise<Buffer | null>;
  publicBase(): string | undefined;
  publicUploadUrl(filePath: string): string | null;
}

/** Strict nested payload shape. This describes evidence, not send authority. */
export const customerApprovedFilePlanSchema = z.object({
  status: z.literal("prepared"),
  assetRef: z.literal(CUSTOMER_BUYER_GUIDE_CURRENT),
  sourceId: z.string().uuid(),
  sourceRevision: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u),
  filePath: z.string().regex(/^\/uploads\/lead-magnets\/[0-9a-f-]{36}-[0-9]+\.pdf$/iu),
  assetPath: z.string().regex(/^\/uploads\/msg-files\/customer-approved-[a-f0-9]{64}\.pdf$/u),
  publicUrl: z.string().url().refine((value) => value.startsWith("https://")),
  fileName: z.string().min(1).max(204).regex(/\.pdf$/iu).refine((value) => !/[\\/\u0000-\u001f\u007f]/u.test(value)),
  mimeType: z.literal("application/pdf"),
  byteLength: z.number().int().min(1).max(MAX_PDF_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  channel: z.enum(["INSTAGRAM", "WHATSAPP", "FACEBOOK"]),
  deliveryKind: z.enum(["file", "link"]),
  deliverIfUnsure: z.boolean(),
  followDecision: z.enum(["not_required", "confirmed", "unknown_allowed"]),
  identity: z.string().regex(/^[a-f0-9]{64}$/u),
  needsFollow: z.literal(false),
}).strict().superRefine((plan, context) => {
  if (plan.deliveryKind !== (plan.channel === "INSTAGRAM" ? "link" : "file")) {
    context.addIssue({ code: "custom", path: ["deliveryKind"], message: "Channel delivery kind mismatch" });
  }
  if ((plan.channel === "INSTAGRAM" && (plan.followDecision === "not_required" ||
      (plan.followDecision === "unknown_allowed" && !plan.deliverIfUnsure))) ||
      (plan.channel !== "INSTAGRAM" && plan.followDecision !== "not_required")) {
    context.addIssue({ code: "custom", path: ["followDecision"], message: "Follow decision mismatch" });
  }
});
export type CustomerApprovedFilePrepared = z.infer<typeof customerApprovedFilePlanSchema>;

const issuedPlans = new WeakMap<object, string>();
const issuedFollowPrompts = new WeakMap<object, string>();
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function authorityKey(authority: CustomerApprovedFileAuthority): string {
  return digest(canonical(authority));
}
function skip(reason: CustomerApprovedFileSkipReason, extra: { needsFollow?: boolean; deliverIfUnsure?: boolean } = {}): CustomerApprovedFilePlan {
  return Object.freeze({ status: "skip", reason, needsFollow: extra.needsFollow === true,
    ...(extra.deliverIfUnsure !== undefined ? { deliverIfUnsure: extra.deliverIfUnsure } : {}) });
}
function validAuthority(value: CustomerApprovedFileAuthority): boolean {
  if (!value || typeof value !== "object") return false;
  const small = (text: unknown, max: number) => typeof text === "string" && text.length > 0 && text.length <= max && !/[\u0000-\u001f\u007f]/u.test(text);
  return !!value && small(value.endpointScopeId, 128) && (value.accountId === null || small(value.accountId, 128)) &&
    small(value.transportKey, 1024) && /^\d{1,20}$/u.test(value.scopeRevision) && small(value.peer, 512) &&
    /^[a-f0-9]{64}$/u.test(value.agentRevisionId) && /^[a-f0-9]{64}$/u.test(value.eventKey) &&
    /^[a-f0-9]{64}$/u.test(value.scopeKey) && /^[a-f0-9]{64}$/u.test(value.turnKey);
}
function campaignPdfPath(campaignId: string, filePath: string): boolean {
  if (!/^[0-9a-f-]{36}$/iu.test(campaignId) || filePath.length > 256 || filePath.includes("..") || /[%?#\\\u0000-\u001f]/u.test(filePath)) return false;
  const escapedId = campaignId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^/uploads/lead-magnets/${escapedId}-[0-9]+\\.pdf$`, "iu").test(filePath);
}
function approvedPdfAssetPath(sha256: string): string {
  return `/uploads/msg-files/customer-approved-${sha256}.pdf`;
}
function canonicalApprovedPdfAssetPath(assetPath: string, sha256: string): boolean {
  return /^[a-f0-9]{64}$/u.test(sha256) && assetPath === approvedPdfAssetPath(sha256);
}
function safeDisplayName(value: string | null): string | null {
  if (!value || value.length > 200 || /[\\/\u0000-\u001f\u007f]/u.test(value)) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  return /\.pdf$/iu.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}
function publicHttpsUrl(filePath: string, baseInput: string | undefined, derived: string | null): string | null {
  if (!baseInput || !derived) return null;
  try {
    const base = new URL(baseInput), url = new URL(derived);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
        url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin !== base.origin) return null;
    const basePath = base.pathname.replace(/\/+$/u, "");
    if (url.pathname !== `${basePath}${filePath}` || derived !== `${baseInput.replace(/\/+$/u, "")}${filePath}`) return null;
    return derived;
  } catch { return null; }
}
function planIdentity(value: {
  assetRef: typeof CUSTOMER_BUYER_GUIDE_CURRENT; sourceId: string; sourceRevision: string; filePath: string; assetPath: string;
  publicUrl: string; fileName: string; byteLength: number; sha256: string;
  channel: "INSTAGRAM" | "WHATSAPP" | "FACEBOOK"; deliveryKind: "file" | "link";
  deliverIfUnsure: boolean; followDecision: "not_required" | "confirmed" | "unknown_allowed";
}, authority: CustomerApprovedFileAuthority): string {
  return digest(canonical({ ...value, mimeType: "application/pdf", authority }));
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readCampaignPdf(campaignId: string, filePath: string): Promise<Buffer | null> {
  if (!campaignPdfPath(campaignId, filePath)) return null;
  try {
    const root = await fs.realpath(uploadsDir);
    const candidate = path.join(root, "lead-magnets", path.posix.basename(filePath));
    const beforeReal = await fs.realpath(candidate);
    const beforePath = await fs.lstat(candidate);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || !inside(root, beforeReal) || beforeReal !== candidate) return null;
    const handle = await fs.open(beforeReal, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > MAX_PDF_BYTES) return null;
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== after.size || bytes.length > MAX_PDF_BYTES) return null;
      return bytes;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function readImmutableApprovedPdf(assetPath: string, expectedSha256: string, expectedSize: number): Promise<Buffer | null> {
  if (!canonicalApprovedPdfAssetPath(assetPath, expectedSha256) || !Number.isSafeInteger(expectedSize) ||
      expectedSize < 1 || expectedSize > MAX_PDF_BYTES) return null;
  try {
    const root = await fs.realpath(uploadsDir), candidate = path.join(root, "msg-files", path.posix.basename(assetPath));
    const real = await fs.realpath(candidate), stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || real !== candidate || !inside(root, real)) return null;
    const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== expectedSize || before.size > MAX_PDF_BYTES) return null;
      const bytes = await handle.readFile(), after = await handle.stat();
      if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== after.size ||
          bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || digest(bytes) !== expectedSha256) return null;
      return bytes;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function publishImmutableApprovedPdf(bytes: Buffer, expectedSha256: string): Promise<boolean> {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || digest(bytes) !== expectedSha256) return false;
  try {
    const root = await fs.realpath(uploadsDir), directory = path.join(root, "msg-files");
    await fs.mkdir(directory, { recursive: true });
    const realDirectory = await fs.realpath(directory);
    if (!inside(root, realDirectory) || realDirectory !== directory) return false;
    const assetPath = approvedPdfAssetPath(expectedSha256), fileName = path.posix.basename(assetPath), destination = path.join(realDirectory, fileName);
    const temporary = path.join(realDirectory, `.customer-approved-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
      try { await fs.link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; }
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return !!await readImmutableApprovedPdf(assetPath, expectedSha256, bytes.length);
  } catch { return false; }
}

const defaultDependencies: CustomerApprovedFileDependencies = {
  async findCurrentCampaign() {
    const rows = await prisma.leadMagnetCampaign.findMany({
      where: { NOT: { filePath: null } },
      select: { id: true, enabled: true, createdAt: true, updatedAt: true, filePath: true, fileName: true, fileSize: true, deliverIfUnsure: true },
      orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
      take: 1,
    });
    return rows[0] ?? null;
  },
  readCampaignPdf,
  publishImmutablePdf: publishImmutableApprovedPdf,
  readImmutablePdf: readImmutableApprovedPdf,
  publicBase: crmPublicBase,
  publicUploadUrl,
};

/**
 * Plan a send for the one owner-managed current buyer-guide PDF. This function
 * never sends, persists a marker, checks Instagram over the network, or accepts
 * a model URL/path/name. Invoke it again immediately before dispatch.
 */
export async function prepareCustomerApprovedFile(input: {
  assetRef: unknown;
  channel: string;
  authority: CustomerApprovedFileAuthority;
  eligibility: CustomerApprovedFileEligibility;
  stillCurrent(authority: CustomerApprovedFileAuthority): boolean | Promise<boolean>;
}, deps: CustomerApprovedFileDependencies = defaultDependencies): Promise<CustomerApprovedFilePlan> {
  try {
    if (input.assetRef !== CUSTOMER_BUYER_GUIDE_CURRENT || !validAuthority(input.authority) ||
        typeof input.stillCurrent !== "function" || !input.eligibility ||
        typeof input.eligibility.canSendGuide !== "boolean" || typeof input.eligibility.requested !== "boolean" ||
        typeof input.eligibility.alreadySent !== "boolean" ||
        !(input.eligibility.awaitingFollowSince === null || input.eligibility.awaitingFollowSince instanceof Date) ||
        !(input.eligibility.followerState === undefined || typeof input.eligibility.followerState === "boolean")) {
      return skip("invalid_request");
    }
    if (typeof input.channel !== "string" || !FILE_CHANNELS.has(input.channel)) return skip("unsupported_channel");
    if (!input.eligibility.canSendGuide) return skip("guide_disabled");
    if (input.eligibility.alreadySent) return skip("already_delivered");
    const now = input.eligibility.now ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return skip("invalid_request");
    const waiting = input.eligibility.awaitingFollowSince instanceof Date &&
      now.getTime() - input.eligibility.awaitingFollowSince.getTime() < AWAIT_FOLLOW_MS;
    if (!input.eligibility.requested && !waiting) return skip("not_requested");

    const before = await input.stillCurrent(input.authority);
    if (before !== true) return skip("stale_turn");
    const campaign = await deps.findCurrentCampaign();
    if (!campaign) return skip("campaign_unavailable");
    if (!campaign.filePath || !campaignPdfPath(campaign.id, campaign.filePath) ||
        !(campaign.createdAt instanceof Date) || !(campaign.updatedAt instanceof Date) ||
        !Number.isFinite(campaign.updatedAt.getTime()) || (campaign.fileSize !== null &&
        (!Number.isSafeInteger(campaign.fileSize) || campaign.fileSize < 1 || campaign.fileSize > MAX_PDF_BYTES))) return skip("invalid_campaign_file");
    const fileName = safeDisplayName(campaign.fileName ?? DEFAULT_GUIDE_FILE_NAME);
    if (!fileName) return skip("invalid_campaign_file");
    const bytes = await deps.readCampaignPdf(campaign.id, campaign.filePath);
    if (!bytes || (campaign.fileSize !== null && bytes.length !== campaign.fileSize) || bytes.length < 1 || bytes.length > MAX_PDF_BYTES ||
        bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return skip("file_unavailable");
    const sha256 = digest(bytes);
    const assetPath = approvedPdfAssetPath(sha256);
    if (!await deps.publishImmutablePdf(bytes, sha256)) return skip("file_unavailable");
    const immutableBytes = await deps.readImmutablePdf(assetPath, sha256, bytes.length);
    if (!immutableBytes || immutableBytes.length !== bytes.length || digest(immutableBytes) !== sha256) return skip("file_unavailable");
    const publicUrl = publicHttpsUrl(assetPath, deps.publicBase(), deps.publicUploadUrl(assetPath));
    if (!publicUrl) return skip("invalid_public_url");

    if (input.channel === "INSTAGRAM" && input.eligibility.followerState !== true &&
        !(input.eligibility.followerState === undefined && campaign.deliverIfUnsure)) {
      const needsFollow = input.eligibility.requested;
      if (needsFollow && await input.stillCurrent(input.authority) !== true) return skip("stale_turn");
      const result = skip(needsFollow ? "follow_required" : "awaiting_follow", { needsFollow, deliverIfUnsure: campaign.deliverIfUnsure });
      if (result.status === "skip" && result.reason === "follow_required" && result.needsFollow) {
        issuedFollowPrompts.set(result, authorityKey(input.authority));
      }
      return result;
    }

    const sourceRevision = campaign.updatedAt.toISOString();
    const followDecision: "not_required" | "confirmed" | "unknown_allowed" = input.channel !== "INSTAGRAM" ? "not_required"
      : input.eligibility.followerState === true ? "confirmed" : "unknown_allowed";
    const deliveryKind: "file" | "link" = input.channel === "INSTAGRAM" ? "link" : "file";
    const planBase = { assetRef: CUSTOMER_BUYER_GUIDE_CURRENT, sourceId: campaign.id, sourceRevision,
      filePath: campaign.filePath, assetPath, publicUrl, fileName, byteLength: bytes.length, sha256,
      channel: input.channel as "INSTAGRAM" | "WHATSAPP" | "FACEBOOK", deliveryKind,
      deliverIfUnsure: campaign.deliverIfUnsure, followDecision };
    const identity = planIdentity(planBase, input.authority);
    if (await input.stillCurrent(input.authority) !== true) return skip("stale_turn");
    const prepared: Extract<CustomerApprovedFilePlan, { status: "prepared" }> = Object.freeze({
      status: "prepared", assetRef: CUSTOMER_BUYER_GUIDE_CURRENT, sourceId: campaign.id, sourceRevision,
      filePath: campaign.filePath, assetPath, publicUrl, fileName, mimeType: "application/pdf", byteLength: bytes.length, sha256,
      channel: planBase.channel, deliveryKind, deliverIfUnsure: campaign.deliverIfUnsure, followDecision, identity, needsFollow: false,
    });
    issuedPlans.set(prepared, authorityKey(input.authority));
    return prepared;
  } catch {
    return skip("file_unavailable");
  }
}

/** Only the direct result of a current in-process preparation can seed a payload. */
export function isCurrentIssuedCustomerApprovedFile(value: unknown, authority: CustomerApprovedFileAuthority): boolean {
  if (!value || typeof value !== "object" || !validAuthority(authority)) return false;
  return issuedPlans.get(value) === authorityKey(authority);
}

/** Only a server-issued, current IG preflight can seed the bounded follow prompt. */
export function customerApprovedFileFollowPromptIssuedBy(value: unknown, authority: CustomerApprovedFileAuthority): boolean {
  if (!value || typeof value !== "object" || !validAuthority(authority)) return false;
  const result = value as Partial<Extract<CustomerApprovedFilePlan, { status: "skip" }>>;
  return result.status === "skip" && result.reason === "follow_required" && result.needsFollow === true &&
    issuedFollowPrompts.get(value) === authorityKey(authority);
}

/** Re-read the current source and public URL without repeating the follower check.
 * Callers must authenticate the persisted outbox witness before relying on this. */
export async function customerApprovedFileWitnessCurrent(input: {
  witness: unknown;
  channel: string;
  authority: CustomerApprovedFileAuthority;
  stillCurrent(authority: CustomerApprovedFileAuthority): boolean | Promise<boolean>;
}, deps: CustomerApprovedFileDependencies = defaultDependencies): Promise<boolean> {
  try {
    const parsedPlan = customerApprovedFilePlanSchema.safeParse(input.witness);
    if (!parsedPlan.success || !validAuthority(input.authority) || typeof input.stillCurrent !== "function" ||
        !FILE_CHANNELS.has(parsedPlan.data.channel) || parsedPlan.data.channel !== input.channel) return false;
    const plan = parsedPlan.data;
    if (await input.stillCurrent(input.authority) !== true) return false;
    const campaign = await deps.findCurrentCampaign();
    if (!campaign || !campaign.filePath || !campaignPdfPath(campaign.id, campaign.filePath) ||
        !(campaign.createdAt instanceof Date) || !(campaign.updatedAt instanceof Date) || !Number.isFinite(campaign.updatedAt.getTime()) ||
        (campaign.fileSize !== null && (!Number.isSafeInteger(campaign.fileSize) || campaign.fileSize < 1 || campaign.fileSize > MAX_PDF_BYTES))) return false;
    const fileName = safeDisplayName(campaign.fileName ?? DEFAULT_GUIDE_FILE_NAME);
    if (!fileName) return false;
    const bytes = await deps.readCampaignPdf(campaign.id, campaign.filePath);
    if (!bytes || (campaign.fileSize !== null && bytes.length !== campaign.fileSize) || bytes.length !== plan.byteLength ||
        bytes.length < 1 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return false;
    const sha256 = digest(bytes), assetPath = approvedPdfAssetPath(sha256);
    if (!canonicalApprovedPdfAssetPath(plan.assetPath, sha256)) return false;
    const immutableBytes = await deps.readImmutablePdf(assetPath, sha256, bytes.length);
    if (!immutableBytes || immutableBytes.length !== bytes.length || digest(immutableBytes) !== sha256) return false;
    const publicUrl = publicHttpsUrl(assetPath, deps.publicBase(), deps.publicUploadUrl(assetPath));
    if (!publicUrl || plan.sourceId !== campaign.id || plan.sourceRevision !== campaign.updatedAt.toISOString() ||
        plan.filePath !== campaign.filePath || plan.assetPath !== assetPath || plan.fileName !== fileName || plan.publicUrl !== publicUrl ||
        plan.sha256 !== sha256 || plan.deliverIfUnsure !== campaign.deliverIfUnsure) return false;
    const identity = planIdentity({ assetRef: CUSTOMER_BUYER_GUIDE_CURRENT, sourceId: campaign.id,
      sourceRevision: campaign.updatedAt.toISOString(), filePath: campaign.filePath, assetPath, publicUrl, fileName,
      byteLength: bytes.length, sha256, channel: plan.channel as "INSTAGRAM" | "WHATSAPP" | "FACEBOOK",
      deliveryKind: plan.deliveryKind as "file" | "link", deliverIfUnsure: campaign.deliverIfUnsure,
      followDecision: plan.followDecision as "not_required" | "confirmed" | "unknown_allowed" }, input.authority);
    return plan.identity === identity && await input.stillCurrent(input.authority) === true;
  } catch { return false; }
}
