import { enrollCustomerAgentSubjectTx, readCustomerPublicSourceExecution, type CustomerAgentExecution } from "./customerAgentEnrollment.js";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { decryptSecretSafe } from "../crypto.js";
import { prisma, type TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { publicSourceRefSchema, publicSourceProofSchema, publicSettingsSnapshotSchema, publicCommentTargetSchema,
  type PublicCommentChannel, type PublicInstallation, type PublicSettingsSnapshot, type PublicSourceRef,
  type PublicSourceProof, type PublicReadContext, type PublicResult, type ServerPublicCommentSnapshot } from "@royal-home/shared";
import { decodePublicOrigin, preparePublicOriginTx } from "./customerPublicOrigin.js";
import { publicCommentSourceDigest, samePublicInstallation } from "./publicCommentSourceIdentity.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { readCustomerPublicationCatalog } from "./customerPublicationCatalog.js";

export type PublicCommentDb = Pick<TxClient, "$queryRaw" | "$executeRaw" | "property" | "propertyPhotoPost">;
export interface PublicInstallationStamp { installation: PublicInstallation; policyRevision: string; legacyOnly?: true }
type JsonRecord = Record<string, unknown>;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface PublicSourceRow {
  id: string; channel: PublicCommentChannel; targetResource: string | null; publicationId: string; commentId: string;
  parentId: string | null; authorId: string; text: string; status: string; sourceRevision: string;
  originVersion: number | null; originCiphertext: string | null; originCapturedAt: Date | null;
}
interface Configuration { accountId: string | null; fingerprint: string; settings: PublicSettingsSnapshot; tokenCiphertext: string | null; legacyOnly?: true }
interface ScopeRow { id: string; scopeRevision: string; messengerAccountId: string | null;
  publicCredentialFingerprint: string | null; publicResourceId: string | null; kind: string; channel: PublicCommentChannel; transportKey: string }

/** One coherent credential/settings/policy snapshot; values never leave this module or enter logs/model context. */
async function configuration(db: PublicCommentDb, channel: PublicCommentChannel, resource: string, allowLegacyEnvironment = false): Promise<Configuration | null> {
  const [raw] = await db.$queryRaw<Array<{ settings: unknown; accounts: unknown; policy: unknown; policyRevision: string }>>`
    SELECT to_jsonb(s) AS settings, to_jsonb(p) AS policy, p."policyRevision"::text AS "policyRevision",
      (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) FROM "MessengerAccount" a WHERE a."channel"=${channel}
        AND (a."externalId"=${resource} OR a."messagingId"=${resource} OR ${resource}=ANY(a."extraExternalIds"))) AS accounts
    FROM "Settings" s CROSS JOIN "CustomerRuntimePolicy" p WHERE s."id"='singleton' AND p."id"='singleton'`;
  if (!raw) return null;
  const s = record(raw.settings), p = record(raw.policy), accounts = Array.isArray(raw.accounts) ? raw.accounts.map(record) : [];
  const settings = publicSettingsSnapshotSchema.safeParse({ policyRevision: raw.policyRevision,
    contractVersion: p.contractVersion, rolloutMode: p.rolloutMode, publicRead: record(p.capabilities).publicRead === true,
    botEnabled: s.botEnabled === true, botCanAnswerComments: s.botCanAnswerComments === true,
    botInstagramEnabled: s.botInstagramEnabled === true, botFacebookEnabled: s.botFacebookEnabled === true,
    botTelegramEnabled: s.botTelegramEnabled === true, metaEnabled: s.metaEnabled === true });
  if (!settings.success) return null;
  if (channel === "INSTAGRAM" || channel === "FACEBOOK") {
    // Exact legacy configured resource only; no default account/peer inference.
    // This opt-in is used exclusively by the verified RAW routing producer.
    const pageResource = string(s.metaPageId) || (allowLegacyEnvironment ? string(process.env.META_PAGE_ID) : null);
    const pageToken = decryptSecretSafe(string(s.metaPageToken)) || (allowLegacyEnvironment ? string(process.env.META_PAGE_TOKEN) : null);
    const installedFallback = channel === "FACEBOOK" && pageResource === resource && !!pageToken;
    if (accounts.length > 1 || accounts.length === 1 && installedFallback) return null;
    const account = accounts[0];
    if (account) {
      if (!string(account.id) || !string(account.token)) return null;
      const signing = string(account.appSecret) || string(s.metaAppSecret) || (channel === "INSTAGRAM" ? string(s.metaIgAppSecret) : null);
      // Persisted public recovery requires durable configured keys. Env-only legacy remains outside this grant.
      const durableKeys = [decryptSecretSafe(string(s.metaAppSecret)),
        channel === "INSTAGRAM" ? decryptSecretSafe(string(s.metaIgAppSecret)) : null].filter((value): value is string => !!value);
      const effectiveKeys = [decryptSecretSafe(string(s.metaAppSecret)) || (allowLegacyEnvironment ? string(process.env.META_APP_SECRET) : null),
        channel === "INSTAGRAM" ? decryptSecretSafe(string(s.metaIgAppSecret)) || (allowLegacyEnvironment ? string(process.env.META_IG_APP_SECRET) : null) : null]
        .filter((value): value is string => !!value);
      const environmentSigning = effectiveKeys.length ? hash(effectiveKeys) : null;
      if (!signing && !environmentSigning) return null;
      // An additional unpersisted relevant key conservatively prevents a core
      // origin. Explicit own-key targets never use these global fallbacks.
      const legacyOnly = !signing || allowLegacyEnvironment && !string(account.appSecret) &&
        effectiveKeys.some(value => !durableKeys.includes(value));
      const effectiveSettings = { ...settings.data,
        ...(channel === "INSTAGRAM" ? { botInstagramEnabled: settings.data.botInstagramEnabled && account.enabled === true }
          : { botFacebookEnabled: settings.data.botFacebookEnabled && account.enabled === true }) };
      return { accountId: string(account.id), settings: effectiveSettings, tokenCiphertext: string(account.token), ...(legacyOnly ? { legacyOnly: true as const } : {}), fingerprint: hash([channel, resource, account.id,
        account.externalId, account.messagingId, account.extraExternalIds, account.enabled, account.token,
        account.appSecret, s.metaAppSecret, channel === "INSTAGRAM" ? s.metaIgAppSecret : null, ...(legacyOnly ? ["legacy_environment", hash(environmentSigning)] : [])]) };
    }
    const signing = decryptSecretSafe(string(s.metaAppSecret)) || (allowLegacyEnvironment ? string(process.env.META_APP_SECRET) : null);
    if (!installedFallback || !signing) return null;
    const legacyOnly = !decryptSecretSafe(string(s.metaPageToken)) || !string(s.metaPageId) || !decryptSecretSafe(string(s.metaAppSecret));
    return { accountId: null, settings: settings.data, tokenCiphertext: legacyOnly ? null : string(s.metaPageToken),
      ...(legacyOnly ? { legacyOnly: true as const } : {}), fingerprint: legacyOnly
        ? hash([channel, resource, "legacy_environment", hash(pageToken), hash(signing)])
        : hash([channel, resource, s.metaPageId, s.metaPageToken, s.metaAppSecret]) };
  }
  if (channel === "YOUTUBE") {
    if (!string(s.youtubeClientId) || !string(s.youtubeClientSecret) || !string(s.youtubeRefreshToken)) return null;
    return { accountId: null, settings: settings.data, tokenCiphertext: null, fingerprint: hash([channel, resource, s.youtubeClientId, s.youtubeClientSecret, s.youtubeRefreshToken]) };
  }
  // Env-only TG token has no durable installation/deploy epoch. Keep managed recovery closed until its real producer adapter exists.
  return null;
}
function installation(scope: ScopeRow): PublicInstallation {
  return { id: scope.id, revision: scope.scopeRevision, channel: scope.channel, accountId: scope.messengerAccountId,
    resourceId: scope.publicResourceId ?? "", transportKey: scope.transportKey };
}
async function scopeFor(db: PublicCommentDb, channel: PublicCommentChannel, resource: string): Promise<ScopeRow | null> {
  const [scope] = await db.$queryRaw<ScopeRow[]>`SELECT "id","scopeRevision"::text AS "scopeRevision","messengerAccountId",
    "publicCredentialFingerprint","publicResourceId","kind","channel","transportKey" FROM "CustomerEndpointScope"
    WHERE "realmKey"='customer-public' AND "channel"=${channel} AND "transportKey"=${`public:${channel}:${resource}`}`;
  return scope ?? null;
}
/** Namespace creation alone grants nothing. Call ONLY from actual verified producer before atomic capture.
 * Default source loads never call this; they do not heal a changed credential or adopt a new namespace. */
export async function ensurePublicCommentInstallation(channel: PublicCommentChannel, resource: string): Promise<PublicInstallationStamp | null> {
  return ensurePublicCommentInstallationForProducer(channel, resource, false);
}
/** Namespace metadata only. Env-dependent snapshots can elect LEGACY only;
 * default issuer/read/token paths never opt in or recover authority from env. */
async function ensurePublicCommentInstallationForProducer(channel: PublicCommentChannel, resource: string, allowLegacyEnvironment: boolean): Promise<PublicInstallationStamp | null> {
  if (!resource || resource.length > 512) return null;
  return prisma.$transaction(async tx => {
    const before = await configuration(tx, channel, resource, allowLegacyEnvironment); if (!before) return null;
    const key = `public:${channel}:${resource}`;
    await tx.$executeRaw`INSERT INTO "CustomerEndpointScope" ("id","realmKey","channel","transportKey","kind","messengerAccountId",
      "scopeRevision","publicCredentialFingerprint","publicResourceId","createdAt","updatedAt")
      VALUES (${randomUUID()},'customer-public',${channel},${key},'PUBLIC',${before.accountId},0,${before.fingerprint},${resource},now(),now())
      ON CONFLICT ("realmKey","channel","transportKey") DO NOTHING`;
    const [current] = await tx.$queryRaw<ScopeRow[]>`SELECT "id","scopeRevision"::text AS "scopeRevision","messengerAccountId",
      "publicCredentialFingerprint","publicResourceId","kind","channel","transportKey" FROM "CustomerEndpointScope"
      WHERE "realmKey"='customer-public' AND "channel"=${channel} AND "transportKey"=${key} FOR UPDATE`;
    if (!current || current.kind !== "PUBLIC" || current.publicResourceId !== resource || current.messengerAccountId !== before.accountId) return null;
    const after = await configuration(tx, channel, resource, allowLegacyEnvironment);
    if (!after || after.fingerprint !== before.fingerprint || after.settings.policyRevision !== before.settings.policyRevision) return null;
    if (current.publicCredentialFingerprint !== before.fingerprint) {
      const [updated] = await tx.$queryRaw<ScopeRow[]>`UPDATE "CustomerEndpointScope" SET "publicCredentialFingerprint"=${before.fingerprint},
        "scopeRevision"="scopeRevision"+1,"updatedAt"=now() WHERE "id"=${current.id}
        RETURNING "id","scopeRevision"::text AS "scopeRevision","messengerAccountId","publicCredentialFingerprint","publicResourceId","kind","channel","transportKey"`;
      if (!updated) return null; return { installation: installation(updated), policyRevision: after.settings.policyRevision, ...(after.legacyOnly ? { legacyOnly: true as const } : {}) };
    }
    return { installation: installation(current), policyRevision: after.settings.policyRevision, ...(after.legacyOnly ? { legacyOnly: true as const } : {}) };
  });
}
export async function readPublicSourceRow(ref: PublicSourceRef, db: PublicCommentDb = prisma, lock = false): Promise<PublicSourceRow | null> {
  if (!publicSourceRefSchema.safeParse(ref).success || lock && !isActiveTransactionClient(db)) return null;
  const suffix = lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
  const rows = ref.table === "meta" ? await db.$queryRaw<PublicSourceRow[]>(Prisma.sql`
    SELECT "id","channel","accountExternalId" AS "targetResource","mediaId" AS "publicationId","commentId","parentId","authorId","text","status",
      "publicSourceRevision"::text AS "sourceRevision","publicOriginVersion" AS "originVersion","publicOriginCiphertext" AS "originCiphertext",
      "publicOriginCapturedAt" AS "originCapturedAt" FROM "InstagramComment" WHERE "id"=${ref.id} ${suffix}`)
    : await db.$queryRaw<PublicSourceRow[]>(Prisma.sql`
    SELECT "id",'TELEGRAM' AS "channel","groupChatId" AS "targetResource","postMessageId" AS "publicationId","messageId" AS "commentId",
      NULL::text AS "parentId","authorId","text","status","publicSourceRevision"::text AS "sourceRevision",
      "publicOriginVersion" AS "originVersion","publicOriginCiphertext" AS "originCiphertext","publicOriginCapturedAt" AS "originCapturedAt"
    FROM "TelegramGroupComment" WHERE "id"=${ref.id} ${suffix}`);
  return rows[0] ?? null;
}

export function publicCommentOrigin(source: PublicSourceRow) {
  return decodePublicOrigin({ version: source.originVersion, ciphertext: source.originCiphertext, capturedAt: source.originCapturedAt });
}
export async function loadPublicCommentSource(ref: PublicSourceRef, db: PublicCommentDb = prisma): Promise<ServerPublicCommentSnapshot | null> {
  const source = await readPublicSourceRow(ref, db); if (!source) return null;
  let proof: PublicSourceProof | null = null;
  let originTarget: ReturnType<typeof decodePublicOrigin>["target"] | null = null;
  if (source.originVersion !== null && source.originCiphertext) {
    try { const origin = publicCommentOrigin(source); proof = publicSourceProofSchema.parse(origin.proof); originTarget = origin.target; }
    catch { return null; }
  }
  const resource = source.targetResource;
  if (!resource) return null;
  const config = await configuration(db, source.channel, resource); if (!config) return null;
  const scope = await scopeFor(db, source.channel, resource);
  const valid = scope && scope.kind === "PUBLIC" && scope.publicResourceId === resource && scope.messengerAccountId === config.accountId &&
    scope.publicCredentialFingerprint === config.fingerprint;
  // Reread source after configuration; no old-row/new-epoch combination is accepted.
  const current = await readPublicSourceRow(ref, db);
  if (!current || current.sourceRevision !== source.sourceRevision || current.originCiphertext !== source.originCiphertext ||
      current.text !== source.text || current.targetResource !== resource || current.publicationId !== source.publicationId ||
      current.commentId !== source.commentId || current.parentId !== source.parentId || current.authorId !== source.authorId) return null;
  const target = originTarget ?? { channel: source.channel, accountExternalId: resource, publicationId: source.publicationId,
    commentId: source.commentId, parentId: source.parentId, threadId: source.channel === "TELEGRAM" ? source.publicationId : source.parentId ?? source.commentId,
    threadKind: source.channel === "TELEGRAM" ? "discussion_post" as const : "comment_anchor" as const };
  if (target.channel !== source.channel || target.accountExternalId !== resource || target.publicationId !== source.publicationId ||
      target.commentId !== source.commentId || source.channel !== "TELEGRAM" && target.parentId !== source.parentId) return null;
  return { source: ref, sourceRevision: source.sourceRevision, status: current.status, text: source.text, target,
    proof, currentInstallation: valid ? installation(scope) : null, settings: config.settings };
}
/** Source → exact scope SHARE → policy SHARE, then callers may lock P12 part/attempt.
 * Account/Settings invalidators must use the same source-before-scope order (root DDL gate). */
export async function lockPublicCommentSourceTx(tx: TxClient, ref: PublicSourceRef): Promise<ServerPublicCommentSnapshot | null> {
  const source = await readPublicSourceRow(ref, tx, true); if (!source?.targetResource) return null;
  const key = `public:${source.channel}:${source.targetResource}`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerEndpointScope" WHERE "realmKey"='customer-public' AND "channel"=${source.channel} AND "transportKey"=${key} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE`;
  return loadPublicCommentSource(ref, tx);
}
export async function readPublicCommentPropertyFacts(context: PublicReadContext) {
  // Exact publication mapping only, no caption guessing, Profile history or self-healing writes.
  if (context.target.channel === "TELEGRAM") return null;
  if (context.target.channel === "YOUTUBE") {
    // Preserve the existing read-only YouTube path. This does not enroll a
    // managed sender or extend any public delivery capability.
    const ids = new Set<string>();
    const direct = await prisma.property.findMany({ where: { deletedAt: null,
      publishedPostIds: { path: [context.target.channel], equals: context.target.publicationId } }, select: { id: true }, take: 2 });
    for (const row of direct) ids.add(row.id);
    const photos = await prisma.propertyPhotoPost.findMany({ where: { channel: context.target.channel, status: "PUBLISHED",
      mediaId: context.target.publicationId }, select: { propertyId: true }, take: 2 });
    for (const row of photos) ids.add(row.propertyId);
    return ids.size === 1 ? readCustomerPropertyFacts([...ids][0], context.target.channel) : null;
  }
  const catalog = await readCustomerPublicationCatalog({ channel: context.target.channel,
    resourceId: context.target.accountExternalId, publicationId: context.target.publicationId });
  return catalog?.ids.length === 1 ? readCustomerPropertyFacts(catalog.ids[0], context.target.channel) : null;
}
interface VerifiedMetaCaptureInput {
  origin: "meta_verified_comment"; originalReceivedAt: number; enabled: boolean;
  expected: readonly PublicInstallationStamp[]; items: readonly unknown[];
}
class PublicCaptureHeld extends Error { constructor(readonly reason: "origin_missing" | "origin_changed" | "installation_changed" | "policy_off") { super(reason); } }
function metaCaptureRow(raw: unknown) {
  const row = record(raw), channel = row.channel;
  if ((channel !== "INSTAGRAM" && channel !== "FACEBOOK") || typeof row.text !== "string" || !row.text ||
      typeof row.authorId !== "string" || !row.authorId || row.authorId.length > 512 ||
      row.authorName !== undefined && typeof row.authorName !== "string") throw new PublicCaptureHeld("origin_changed");
  const target = { channel, accountExternalId: row.accountExternalId, publicationId: row.mediaId, commentId: row.commentId,
    parentId: row.parentId ?? null, threadId: row.parentId ?? row.commentId, threadKind: "comment_anchor" };
  const parsed = publicCommentTargetSchema.parse(target);
  return { target: parsed, authorId: row.authorId, authorName: typeof row.authorName === "string" ? row.authorName.slice(0, 512) : null,
    text: row.text.slice(0, 2000) };
}
/** Producer-only; root P12 source capture, queue row and original immutable pin share one commit.
 * Existing unverified legacy rows are never backfilled by a redelivery. */
export async function commitVerifiedMetaPublicCapture(input: VerifiedMetaCaptureInput): Promise<PublicResult<readonly PublicSourceRef[]>> {
  try {
    if (input.origin !== "meta_verified_comment" || !Number.isSafeInteger(input.originalReceivedAt) || input.originalReceivedAt > Date.now() ||
        Date.now() - input.originalReceivedAt > 15 * 60_000 || input.items.length > 200) throw new PublicCaptureHeld("origin_changed");
    const items = input.items.map(metaCaptureRow).sort((a, b) => a.target.commentId.localeCompare(b.target.commentId));
    // Metadata enrollment releases all locks before the original Source-first TX.
    const selections = new Map<string, CustomerAgentExecution>();
    for (const item of items) {
      const stamp = input.expected.find(value => value.installation.channel === item.target.channel && value.installation.resourceId === item.target.accountExternalId);
      if (!stamp) throw new PublicCaptureHeld("installation_changed");
      const e = stamp.installation;
      const subject = { surface: "public_comment" as const, endpoint: { endpointScopeId: e.id, scopeRevision: e.revision,
        channel: e.channel, accountId: e.accountId, transportKey: e.transportKey }, target: item.target };
      const prior = await prisma.instagramComment.findUnique({ where: { commentId: item.target.commentId }, select: { id: true } });
      const original = prior ? await readCustomerPublicSourceExecution(prisma, { table: "meta", id: prior.id }, subject) : null;
      if (stamp.legacyOnly && original?.lane === "CORE") throw new PublicCaptureHeld("origin_changed");
      const enrolled = original && original.lane !== "LEGACY" ? original
        : await prisma.$transaction(tx => enrollCustomerAgentSubjectTx(tx, subject, stamp.legacyOnly ? { legacyOnly: true } : {}));
      if (stamp.legacyOnly && enrolled.lane === "CORE") throw new PublicCaptureHeld("origin_changed");
      if (enrolled.lane === "HELD" || original?.lane === "LEGACY" && enrolled.lane !== "LEGACY") throw new PublicCaptureHeld("origin_changed");
      selections.set(item.target.commentId, original ?? enrolled);
    }
    return await prisma.$transaction(async tx => {
      const keys = items.map(item => item.target.commentId);
      // Existing sources have deterministic TEXT order before any installation/policy lock.
      if (keys.length) await tx.$queryRaw`SELECT "id" FROM "InstagramComment" WHERE "commentId"=ANY(${keys}::text[]) ORDER BY "id" FOR UPDATE`;
      const refs: PublicSourceRef[] = [];
      const prepared: Array<{ item: ReturnType<typeof metaCaptureRow>; source: PublicSourceRow; ref: PublicSourceRef; fresh: boolean }> = [];
      for (const item of items) {
        const intake = await configuration(tx, item.target.channel, item.target.accountExternalId, true);
        if (!intake) throw new PublicCaptureHeld("installation_changed");
        const s = intake.settings;
        const recordEnabled = input.enabled && s.botEnabled && s.botCanAnswerComments && s.metaEnabled &&
          (item.target.channel === "INSTAGRAM" ? s.botInstagramEnabled : s.botFacebookEnabled);
        const execution = selections.get(item.target.commentId);
        if (!execution || execution.lane === "HELD") throw new PublicCaptureHeld("origin_changed");
        const assignmentId = execution.assignment?.id ?? null;
        const proposedId = randomUUID();
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`INSERT INTO "InstagramComment"
          ("id","channel","commentId","mediaId","accountExternalId","parentId","authorId","authorName","text","status","note","replyDueAt","createdAt","updatedAt","publicRolloutAssignmentId")
          VALUES (${proposedId},${item.target.channel},${item.target.commentId},${item.target.publicationId},${item.target.accountExternalId},
            ${item.target.parentId},${item.authorId},${item.authorName},${item.text},
            ${recordEnabled ? "PENDING" : "SKIPPED"},${recordEnabled ? null : "bot_off"},now(),now(),now(),${assignmentId})
          ON CONFLICT ("commentId") DO NOTHING RETURNING "id"`;
        const [identity] = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "InstagramComment" WHERE "commentId"=${item.target.commentId}`;
        if (!identity) throw new PublicCaptureHeld("origin_changed");
        const ref: PublicSourceRef = { table: "meta", id: identity.id };
        const source = await readPublicSourceRow(ref, tx, true);
        if (!source || source.channel !== item.target.channel || source.targetResource !== item.target.accountExternalId ||
            source.publicationId !== item.target.publicationId || source.commentId !== item.target.commentId ||
            source.parentId !== item.target.parentId || source.authorId !== item.authorId || source.text !== item.text) throw new PublicCaptureHeld("origin_changed");
        prepared.push({ item, source, ref, fresh: inserted.some(row => row.id === source.id) });
      }
      // Acquire the whole installation set in deterministic order before any origin/policy read.
      const scopeIds = [...new Set(input.expected.map(stamp => stamp.installation.id))].sort();
      if (scopeIds.length) await tx.$queryRaw`SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=ANY(${scopeIds}::text[]) ORDER BY "id" FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE`;
      for (const { item, source, ref, fresh } of prepared) {
        const execution = selections.get(item.target.commentId);
        if (!execution || execution.lane === "HELD") throw new PublicCaptureHeld("origin_changed");
        if (source.originCiphertext) { refs.push(ref); continue; }
        if (execution.lane === "CORE" && !fresh) throw new PublicCaptureHeld("origin_missing");
        const expected = input.expected.find(stamp => stamp.installation.channel === source.channel && stamp.installation.resourceId === source.targetResource);
        if (!expected) throw new PublicCaptureHeld("installation_changed");
        // Namespace was initialized before this tx; claim/capture never creates/rebinds it.
        if (execution.lane === "LEGACY") {
          const compatible = await configuration(tx, source.channel, item.target.accountExternalId, true);
          const scope = await scopeFor(tx, source.channel, item.target.accountExternalId);
          if (!compatible || !scope || scope.kind !== "PUBLIC" || scope.messengerAccountId !== compatible.accountId ||
              scope.publicCredentialFingerprint !== compatible.fingerprint ||
              !samePublicInstallation(expected.installation, installation(scope)) ||
              expected.policyRevision !== compatible.settings.policyRevision || !!expected.legacyOnly !== !!compatible.legacyOnly) {
            throw new PublicCaptureHeld("installation_changed");
          }
          refs.push(ref); continue; // FK-only queue, no AEAD origin/principal/grant.
        }
        if (expected.legacyOnly) throw new PublicCaptureHeld("origin_changed");
        const state = await loadPublicCommentSource(ref, tx);
        if (!state?.currentInstallation || !samePublicInstallation(expected.installation, state.currentInstallation) ||
            state.settings.policyRevision !== expected.policyRevision) throw new PublicCaptureHeld("installation_changed");
        const enabledNow = state.settings.botEnabled && state.settings.botCanAnswerComments && state.settings.metaEnabled &&
          (source.channel === "INSTAGRAM" ? state.settings.botInstagramEnabled : state.settings.botFacebookEnabled);
        if (state.settings.contractVersion !== "scoped" || state.settings.rolloutMode === "OFF" ||
            source.status !== (input.enabled && enabledNow ? "PENDING" : "SKIPPED")) throw new PublicCaptureHeld("policy_off");
        const proof: PublicSourceProof = { version: 1, origin: "meta_verified_comment", installation: expected.installation,
          source: ref, sourceRevision: source.sourceRevision, policyRevision: expected.policyRevision,
          digest: publicCommentSourceDigest({ source: ref, target: item.target, text: source.text }) };
        const origin = await preparePublicOriginTx(tx, { proof, target: item.target, originalReceivedAt: input.originalReceivedAt, expectedRevisionId: execution.revisionId ?? undefined });
        const changed = await tx.$executeRaw`UPDATE "InstagramComment" SET "publicOriginVersion"=${origin.version},
          "publicOriginCiphertext"=${origin.ciphertext},"publicOriginCapturedAt"=${origin.capturedAt}
          WHERE "id"=${source.id} AND "publicOriginCiphertext" IS NULL AND "publicSourceRevision"=${BigInt(source.sourceRevision)}`;
        if (changed !== 1) throw new PublicCaptureHeld("origin_changed");
        refs.push(ref);
      }
      return { status: "current" as const, value: refs };
    });
  } catch (error) {
    if (error instanceof PublicCaptureHeld) return { status: "held", reason: error.reason };
    // DB/AEAD/schema failure is never successful intake; caller chooses pre-ACK 503.
    throw error;
  }
}
/** Bound by the actual HMAC producer. No fake callback or permissive default store. */
export const defaultMetaPublicCapturePort = Object.freeze({ readInstallation: ensurePublicCommentInstallation,
  commitQueueAndCapture: commitVerifiedMetaPublicCapture });
/** Bound ONLY by the same-body target-HMAC producer; not an issuer/POST port. */
export const legacyCompatibleMetaPublicCapturePort = Object.freeze({
  readInstallation: (channel: "INSTAGRAM" | "FACEBOOK", resource: string) => ensurePublicCommentInstallationForProducer(channel, resource, true),
  commitQueueAndCapture: commitVerifiedMetaPublicCapture,
});

/** Internal credential lookup only; not authority. P12 beforePhysicalPost rechecks ORIGINAL installation. */
export async function readPublicCommentMetaToken(expected: PublicInstallation): Promise<string | null> {
  if (expected.channel !== "INSTAGRAM" && expected.channel !== "FACEBOOK") return null;
  const config = await configuration(prisma, expected.channel, expected.resourceId), scope = await scopeFor(prisma, expected.channel, expected.resourceId);
  if (!config || !scope || scope.kind !== "PUBLIC" || scope.publicCredentialFingerprint !== config.fingerprint ||
      !samePublicInstallation(expected, installation(scope)) || !config.tokenCiphertext) return null;
  return decryptSecretSafe(config.tokenCiphertext);
}
