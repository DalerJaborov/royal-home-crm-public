// Immutable server routing metadata; callers retain actual ingress authority.
// Server routing metadata only. Real producers verify same raw HMAC/namespace
// before calling; no route/model gets this interface. Does not mint a principal.
import { createHash, randomUUID } from "node:crypto";
import { customerAgentEnrollmentSubjectSchema, customerAgentRolloutConfigSchema, customerAgentRolloutAssignmentSchema,
  type CustomerAgentEnrollmentSubject, type CustomerAgentRolloutAssignment } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import type { TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { customerPropertyScopeKey } from "./customerPropertyScope.js";
import { customerAgentRevisionReachable } from "./customerAgentRevisionAdvance.js";
import { CUSTOMER_AGENT_LEGACY_CUTOVER_REASON, customerAgentLegacyCutoverEnabled, readCustomerLegacyCutoverReadiness } from "./customerAgentLegacyCutover.js";

type Db = Pick<TxClient, "$queryRaw">;
type Assignment = CustomerAgentRolloutAssignment;
type Policy = { contractVersion: string; rolloutMode: string; activeAgentRevisionId: string | null; rolloutConfig: unknown };
export type CustomerAgentExecution = { lane: "LEGACY"; assignment: Assignment | null } |
  { lane: "CORE"; assignment: Assignment | null; revisionId: string | null } | { lane: "HELD"; reason: string };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function customerAgentEnrollmentSubjectKey(raw: CustomerAgentEnrollmentSubject): string {
  const value = customerAgentEnrollmentSubjectSchema.parse(raw);
  return sha(value.surface === "dm" ? [1, value.surface, value.endpoint.endpointScopeId, value.peer]
    : [1, value.surface, value.endpoint.endpointScopeId, value.target.publicationId, value.target.threadKind, value.target.threadId]);
}
const held = (reason: string): CustomerAgentExecution => ({ lane: "HELD", reason });
function fromAssignment(value: Assignment): CustomerAgentExecution {
  return value.lane === "LEGACY" ? { lane: "LEGACY", assignment: value }
    : value.candidateRevisionId ? { lane: "CORE", assignment: value, revisionId: value.candidateRevisionId }
    : held("core_assignment_invalid");
}
async function assignment(db: Db, surface: string, endpointScopeId: string, subjectKey: string): Promise<Assignment | null> {
  const rows = await db.$queryRaw<Assignment[]>`SELECT "id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId"
    FROM "CustomerAgentRolloutAssignment" WHERE "surface"=${surface} AND "endpointScopeId"=${endpointScopeId} AND "subjectKey"=${subjectKey}
    ORDER BY "generation" DESC LIMIT 1`; // Effective lane = latest append-only generation (legacy cutover 31.10).
  return rows.length ? customerAgentRolloutAssignmentSchema.parse(rows[0]) : null;
}
/** Read-only early legacy controller guard, including retries without the
 * original RAM request. A trusted scoped transport is still not a permission.
 * No enrollment/resampling/namespace healing happens here. */
export async function readCustomerDmSubjectExecution(db: Db, transport: {
  endpointScopeId: string; scopeRevision: string; channel: string; accountId: string | null; transportKey: string;
}, peer: string): Promise<CustomerAgentExecution | null> {
  const parsed = customerAgentEnrollmentSubjectSchema.safeParse({ surface: "dm", endpoint: {
    endpointScopeId: transport.endpointScopeId, scopeRevision: transport.scopeRevision, channel: transport.channel,
    accountId: transport.accountId, transportKey: transport.transportKey }, peer });
  if (!parsed.success || parsed.data.surface !== "dm") return held("subject_invalid");
  const stored = await assignment(db, "dm", transport.endpointScopeId, customerAgentEnrollmentSubjectKey(parsed.data));
  if (stored) return fromAssignment(stored);
  const scopeKey = customerPropertyScopeKey(transport.channel, peer, transport.accountId, transport.endpointScopeId);
  const rows = await db.$queryRaw<Array<{ intakeAgentRevisionId: string }>>`SELECT DISTINCT "intakeAgentRevisionId"
    FROM "CustomerPropertyIngressTicket" WHERE "endpointScopeId"=${transport.endpointScopeId} AND "scopeKey"=${scopeKey}
    AND "intakeAgentRevisionId" IS NOT NULL LIMIT 2`;
  return rows.length === 1 ? { lane: "CORE", assignment: null, revisionId: rows[0].intakeAgentRevisionId }
    : rows.length > 1 ? held("historical_brains_conflict") : null;
}
/** Immutable original sources win BEFORE any current OFF/config decision.
 * Return CORE means owned by that original brain, never permission to execute;
 * its real original age/policy/authority/kill guards still decide applicability. */
export async function readCustomerDmSourceExecution(db: Db, eventKey: string, scopeKey: string,
  subject: Extract<CustomerAgentEnrollmentSubject, { surface: "dm" }>, contentHash?: string): Promise<CustomerAgentExecution | null> {
  const rows = await db.$queryRaw<Array<{ intakeAgentRevisionId: string | null; rolloutAssignmentId: string | null;
    endpointScopeId: string | null; tombstonedAt: Date | null; routingSourceVersion: number | null;
    routingSourceHash: string | null; routingScopeRevision: bigint | null; routingProvenance: string | null }>>`
    SELECT "intakeAgentRevisionId","rolloutAssignmentId","endpointScopeId","tombstonedAt",
      "routingSourceVersion","routingSourceHash","routingScopeRevision","routingProvenance" FROM "CustomerPropertyIngressTicket"
    WHERE "eventKey"=${eventKey} AND "scopeKey"=${scopeKey}`;
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0].tombstonedAt) return held("source_tombstoned_or_ambiguous");
  const row = rows[0];
  if (row.routingSourceVersion != null && (row.routingSourceVersion !== 1 ||
    row.routingScopeRevision?.toString() !== subject.endpoint.scopeRevision ||
    (contentHash !== undefined && row.routingSourceHash !== contentHash))) return held("original_source_changed");
  if (row.routingProvenance === "NATIVE_HISTORY") return held("original_native_source_already_observed");
  if (row.rolloutAssignmentId) {
    const [raw] = await db.$queryRaw<Assignment[]>`SELECT "id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId"
      FROM "CustomerAgentRolloutAssignment" WHERE "id"=${row.rolloutAssignmentId}`;
    const parsed = customerAgentRolloutAssignmentSchema.safeParse(raw);
    if (!parsed.success || parsed.data.surface !== "dm" || parsed.data.endpointScopeId !== row.endpointScopeId ||
      parsed.data.subjectKey !== customerAgentEnrollmentSubjectKey(subject) ||
      (parsed.data.lane === "CORE" ? !row.intakeAgentRevisionId || !await customerAgentRevisionReachable(db, parsed.data, row.intakeAgentRevisionId) : row.intakeAgentRevisionId !== null)) return held("source_assignment_changed");
    return parsed.data.lane === "CORE" ? { lane: "CORE", assignment: parsed.data, revisionId: row.intakeAgentRevisionId } : fromAssignment(parsed.data);
  }
  return row.intakeAgentRevisionId ? { lane: "CORE", assignment: null, revisionId: row.intakeAgentRevisionId }
    : { lane: "LEGACY", assignment: null }; // Historical NULL is never upgraded.
}

/** Existing source queue ID, including TG CUID/TEXT. No public author→DM link.
 * Unknown/missing source is HELD; original managed origin/prior Part cannot
 * become legacy because current policy went OFF or a status was reset. */
export async function readCustomerPublicSourceExecution(db: Db, ref: { table: "meta" | "telegram"; id: string },
  subject?: Extract<CustomerAgentEnrollmentSubject, { surface: "public_comment" }>): Promise<CustomerAgentExecution> {
  if (!ref.id || ref.id.length > 512) return held("source_reference_invalid");
  const table = ref.table === "meta" ? Prisma.sql`"InstagramComment"` : Prisma.sql`"TelegramGroupComment"`;
  const rows = await db.$queryRaw<Array<{ publicRolloutAssignmentId: string | null; publicOriginCiphertext: string | null;
    publicOriginVersion: number | null; staffPart: boolean; botPart: boolean }>>(Prisma.sql`
    SELECT c."publicRolloutAssignmentId",c."publicOriginCiphertext",c."publicOriginVersion",
      EXISTS(SELECT 1 FROM "CustomerOutboxPart" p WHERE
        ${ref.table === "meta" ? Prisma.sql`p."publicMetaCommentId"` : Prisma.sql`p."publicTelegramCommentId"`}=c."id"
        AND p."sourceKind"='STAFF_PUBLIC_COMMENT_REPLY') AS "staffPart",
      EXISTS(SELECT 1 FROM "CustomerOutboxPart" p WHERE
        ${ref.table === "meta" ? Prisma.sql`p."publicMetaCommentId"` : Prisma.sql`p."publicTelegramCommentId"`}=c."id"
        AND p."sourceKind"='PUBLIC_COMMENT_REPLY') AS "botPart"
    FROM ${table} c WHERE c."id"=${ref.id}`);
  if (rows.length !== 1) return held("source_missing");
  const row = rows[0], owned = row.publicOriginVersion !== null || row.publicOriginCiphertext !== null || row.botPart;
  if (row.staffPart) return held("staff_public_source_owned");
  if (row.publicRolloutAssignmentId) {
    const [raw] = await db.$queryRaw<Assignment[]>`SELECT "id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId"
      FROM "CustomerAgentRolloutAssignment" WHERE "id"=${row.publicRolloutAssignmentId}`;
    const parsed = customerAgentRolloutAssignmentSchema.safeParse(raw);
    let actualSubject = subject;
    if (!actualSubject && ref.table === "meta" && parsed.success) {
      const [source] = await db.$queryRaw<Array<{ channel: string; accountExternalId: string | null; mediaId: string; commentId: string; parentId: string | null }>>`
        SELECT "channel","accountExternalId","mediaId","commentId","parentId" FROM "InstagramComment" WHERE "id"=${ref.id}`;
      const [scope] = await db.$queryRaw<Array<{ channel: string; scopeRevision: bigint; messengerAccountId: string | null; transportKey: string }>>`
        SELECT "channel","scopeRevision","messengerAccountId","transportKey" FROM "CustomerEndpointScope" WHERE "id"=${parsed.data.endpointScopeId}`;
      const shaped = source && scope ? customerAgentEnrollmentSubjectSchema.safeParse({ surface: "public_comment",
        endpoint: { endpointScopeId: parsed.data.endpointScopeId, scopeRevision: scope.scopeRevision.toString(), channel: scope.channel,
          accountId: scope.messengerAccountId, transportKey: scope.transportKey }, target: { channel: source.channel,
          accountExternalId: source.accountExternalId, publicationId: source.mediaId, commentId: source.commentId,
          parentId: source.parentId, threadId: source.parentId ?? source.commentId, threadKind: "comment_anchor" } }) : null;
      if (shaped?.success && shaped.data.surface === "public_comment") actualSubject = shaped.data;
    }
    if (!parsed.success || parsed.data.surface !== "public_comment" || !actualSubject ||
        parsed.data.endpointScopeId !== actualSubject.endpoint.endpointScopeId || parsed.data.subjectKey !== customerAgentEnrollmentSubjectKey(actualSubject)) return held("source_assignment_changed");
    if (parsed.data.lane === "LEGACY") return owned ? held("legacy_source_managed_conflict") : fromAssignment(parsed.data);
    return owned ? fromAssignment(parsed.data) : held("core_public_origin_missing");
  }
  return owned ? { lane: "CORE", assignment: null, revisionId: null } : { lane: "LEGACY", assignment: null };
}

/** Own short metadata TX. NEVER invoke while already holding public Source,
 * native/Inquiry/Part locks. Source commit revalidates this stored row later.
 * Input is a captured server transport reference, not caller enrollment intent. */
export async function enrollCustomerAgentSubjectTx(tx: TxClient, raw: CustomerAgentEnrollmentSubject,
  options: { legacyOnly?: true; legacyCutover?: true } = {}): Promise<CustomerAgentExecution> {
  if (!isActiveTransactionClient(tx)) return held("active_transaction_required");
  const parsed = customerAgentEnrollmentSubjectSchema.safeParse(raw);
  if (!parsed.success) return held("subject_invalid");
  const s = parsed.data, e = s.endpoint, key = customerAgentEnrollmentSubjectKey(s);
  if (s.surface === "dm" && !["INSTAGRAM", "FACEBOOK", "WHATSAPP"].includes(e.channel) ||
      s.surface === "public_comment" && (!["INSTAGRAM", "FACEBOOK"].includes(e.channel) || s.target.channel !== e.channel)) return held("surface_enrollment_unavailable");
  const [scope] = await tx.$queryRaw<Array<{ kind: string; realmKey: string; channel: string; messengerAccountId: string | null;
    transportKey: string; scopeRevision: bigint; publicResourceId: string | null }>>`
    SELECT "kind","realmKey","channel","messengerAccountId","transportKey","scopeRevision","publicResourceId"
    FROM "CustomerEndpointScope" WHERE "id"=${e.endpointScopeId} FOR SHARE`;
  if (!scope || scope.kind !== (s.surface === "dm" ? "NORMAL" : "PUBLIC") ||
      scope.realmKey !== (s.surface === "dm" ? "royal-home" : "customer-public") || scope.channel !== e.channel ||
      scope.messengerAccountId !== e.accountId || scope.transportKey !== e.transportKey || scope.scopeRevision.toString() !== e.scopeRevision ||
      (s.surface === "public_comment" && scope.publicResourceId !== s.target.accountExternalId)) return held("captured_scope_changed");
  const [policy] = await tx.$queryRaw<Policy[]>`SELECT "contractVersion","rolloutMode","activeAgentRevisionId","rolloutConfig"
    FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE`;
  if (!policy || !["compat", "scoped"].includes(policy.contractVersion) || !["OFF", "SHADOW", "ACTIVE"].includes(policy.rolloutMode)) return held("policy_missing_or_invalid");
  const previous = await assignment(tx, s.surface, e.endpointScopeId, key);
  if (previous?.lane === "LEGACY") {
    // Owner 31.10: the NEXT genuinely new DM input of an idle legacy subject
    // moves it to the core. History rows and old sources keep generation 0.
    if (options.legacyCutover === true && s.surface === "dm" && customerAgentLegacyCutoverEnabled()) {
      const moved = await cutoverLegacySubjectTx(tx, s, key, previous, policy);
      if (moved) return moved;
    }
    return fromAssignment(previous);
  }
  if (previous && (policy.contractVersion !== "scoped" || policy.rolloutMode !== "ACTIVE")) return held("owned_subject_stopped");
  const config = customerAgentRolloutConfigSchema.safeParse(policy.rolloutConfig);
  const unconfigured = policy.rolloutConfig === null && (policy.contractVersion === "compat" || policy.rolloutMode === "OFF");
  if (!config.success && !unconfigured) return held("rollout_config_required");
  if (policy.rolloutMode === "SHADOW") return held("shadow_not_implemented");
  if (config.success && policy.activeAgentRevisionId !== config.data.candidateRevisionId) return held("candidate_policy_mismatch");
  if (previous) return config.success && await customerAgentRevisionReachable(tx, previous, config.data.candidateRevisionId, config.data.cohortId) &&
    config.data.allowed.some(row => row.surface === s.surface && row.channel === e.channel && row.endpointScopeId === e.endpointScopeId)
    ? { lane: "CORE", assignment: previous, revisionId: config.data.candidateRevisionId } : held("pinned_campaign_unavailable");
  if (config.success) {
    const [different] = await tx.$queryRaw<Array<{ mismatch: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment"
      WHERE "cohortId"=${config.data.cohortId} AND "candidateRevisionId"<>${config.data.candidateRevisionId}) AS mismatch`;
    if (different?.mismatch) return held("cohort_candidate_changed");
    const [revision] = await tx.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`SELECT "id","manifestJson" FROM "CustomerAgentRevision"
      WHERE "id"=${config.data.candidateRevisionId}`;
    if (!revision) return held("registered_candidate_missing");
    decodeCustomerAgentRevision(revision); // Actual immutable manifest, no provider call.
  }

  let baseline = false;
  if (s.surface === "dm") {
    const native = await tx.$queryRaw<Array<{ id: string; endpointScopeId: string | null }>>`SELECT "id","endpointScopeId"
      FROM "BotConversation" WHERE "channel"=${e.channel} AND "subscriberId"=${s.peer}`;
    if (native.length > 1 || native.some(row => row.endpointScopeId !== e.endpointScopeId)) return held("legacy_native_scope_collision");
    const originalScopeKey = customerPropertyScopeKey(e.channel, s.peer, e.accountId, e.endpointScopeId);
    const [history] = await tx.$queryRaw<Array<{ closed: boolean; core: boolean; legacy: boolean }>>`SELECT
      EXISTS(SELECT 1 FROM "CustomerInquiry" WHERE "endpointScopeId"=${e.endpointScopeId} AND "peerId"=${s.peer}
        AND ("conversationId" IS NULL OR "closedAt" IS NOT NULL)) AS closed,
      EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" t WHERE t."endpointScopeId"=${e.endpointScopeId}
        AND t."scopeKey"=${originalScopeKey} AND t."intakeAgentRevisionId" IS NOT NULL) AS core,
      EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" t WHERE t."endpointScopeId"=${e.endpointScopeId}
        AND t."scopeKey"=${originalScopeKey} AND t."intakeAgentRevisionId" IS NULL) AS legacy`;
    if (history?.closed || history?.core) return held("historical_subject_owned_or_closed");
    // An old RAW legacy source can precede native creation. It still prevents
    // fresh B from entering CORE while legacy A is suspended before that row.
    baseline = native.length === 1 || history?.legacy === true;
  } else {
    const rows = await tx.$queryRaw<Array<{ managed: boolean }>>`SELECT ("publicOriginCiphertext" IS NOT NULL OR EXISTS(
      SELECT 1 FROM "CustomerOutboxPart" p WHERE p."publicMetaCommentId"="InstagramComment"."id")) AS managed
      FROM "InstagramComment" WHERE "channel"=${e.channel} AND "accountExternalId"=${s.target.accountExternalId}
        AND "mediaId"=${s.target.publicationId} AND ("commentId"=${s.target.threadId} OR "parentId"=${s.target.threadId}) LIMIT 201`;
    if (rows.length > 200 || rows.some(row => row.managed)) return held("historical_public_subject_owned_or_unbounded");
    baseline = rows.length > 0;
  }
  const bucketBps = config.success ? Number.parseInt(sha([1, config.data.cohortId, key]).slice(0, 8), 16) % 10_000 : null;
  const eligible = options.legacyOnly !== true && config.success && policy.contractVersion === "scoped" && policy.rolloutMode === "ACTIVE" && !baseline &&
    config.data.allowed.some(row => row.surface === s.surface && row.channel === e.channel && row.endpointScopeId === e.endpointScopeId);
  const lane = config.success && eligible && bucketBps !== null && bucketBps < config.data.percentBasisPoints ? "CORE" : "LEGACY";
  await tx.$executeRaw(Prisma.sql`INSERT INTO "CustomerAgentRolloutAssignment"
    ("id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId","createdAt","generation")
    VALUES (${randomUUID()},${config.success ? config.data.cohortId : null},${s.surface},${e.endpointScopeId},${key},${bucketBps},${lane},${config.success ? config.data.candidateRevisionId : null},now(),0)
    ON CONFLICT ("surface","endpointScopeId","subjectKey","generation") DO NOTHING`);
  const winner = await assignment(tx, s.surface, e.endpointScopeId, key);
  return winner ? fromAssignment(winner) : held("assignment_commit_missing");
}

/** Append-only LEGACY → CORE transition of one DM subject (owner 31.10.2026).
 * Runs inside the routing transaction that already holds the scope/policy
 * share locks. Returns null when the subject must stay LEGACY: current
 * campaign does not cover it, manual mode, or unfinished legacy work. */
async function cutoverLegacySubjectTx(tx: TxClient, s: Extract<CustomerAgentEnrollmentSubject, { surface: "dm" }>, key: string,
  previous: Assignment, policy: Policy): Promise<CustomerAgentExecution | null> {
  if (policy.contractVersion !== "scoped" || policy.rolloutMode !== "ACTIVE") return null;
  const config = customerAgentRolloutConfigSchema.safeParse(policy.rolloutConfig);
  if (!config.success || policy.activeAgentRevisionId !== config.data.candidateRevisionId) return null;
  const e = s.endpoint, c = config.data;
  if (!c.allowed.some(row => row.surface === "dm" && row.channel === e.channel && row.endpointScopeId === e.endpointScopeId)) return null;
  const bucketBps = Number.parseInt(sha([1, c.cohortId, key]).slice(0, 8), 16) % 10_000;
  if (bucketBps >= c.percentBasisPoints) return null;
  const [different] = await tx.$queryRaw<Array<{ mismatch: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment"
    WHERE "cohortId"=${c.cohortId} AND "candidateRevisionId"<>${c.candidateRevisionId}) AS mismatch`;
  if (different?.mismatch) return null;
  const [revision] = await tx.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`SELECT "id","manifestJson" FROM "CustomerAgentRevision"
    WHERE "id"=${c.candidateRevisionId}`;
  if (!revision) return null;
  decodeCustomerAgentRevision(revision);
  const readiness = await readCustomerLegacyCutoverReadiness(tx, { channel: e.channel, peer: s.peer, endpointScopeId: e.endpointScopeId,
    scopeKey: customerPropertyScopeKey(e.channel, s.peer, e.accountId, e.endpointScopeId) });
  if (!readiness.ready) return null;
  const id = randomUUID();
  const inserted = await tx.$executeRaw(Prisma.sql`INSERT INTO "CustomerAgentRolloutAssignment"
    ("id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId","createdAt",
      "generation","supersedesAssignmentId","transitionReason")
    SELECT ${id},${c.cohortId},'dm',${e.endpointScopeId},${key},${bucketBps},'CORE',${c.candidateRevisionId},now(),
      1,${previous.id},${CUSTOMER_AGENT_LEGACY_CUTOVER_REASON}
    WHERE NOT EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment" WHERE "supersedesAssignmentId"=${previous.id})
    ON CONFLICT ("surface","endpointScopeId","subjectKey","generation") DO NOTHING`);
  if (inserted === 1) {
    // Same transaction as the lane row: no fire-and-forget audit for routing.
    // No customer identifiers in meta, only server routing references.
    await tx.auditLog.create({ data: { action: "CUSTOMER_AGENT_LANE_CUTOVER", entityType: "CustomerAgentRolloutAssignment",
      entityId: id, agentId: null, agentName: "Система", meta: { fromAssignmentId: previous.id, fromLane: "LEGACY", toLane: "CORE",
        reason: CUSTOMER_AGENT_LEGACY_CUTOVER_REASON, endpointScopeId: e.endpointScopeId, channel: e.channel,
        cohortId: c.cohortId, candidateRevisionId: c.candidateRevisionId } } });
  }
  const winner = await assignment(tx, "dm", e.endpointScopeId, key);
  return winner?.lane === "CORE" ? fromAssignment(winner) : null;
}
