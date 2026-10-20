/** Server-only capture factory. Root P12 atomic port must be supplied before runtime activation. */
import { parseIncomingComments } from "../messengers/comments.js";
import type { IncomingComment } from "../messengers/commentsQueue.js";
import { verifyMetaCustomerReferralTarget, authenticatedCustomerRequestEvidence, type CustomerMetaIssuerStore } from "./customerIngressAuthority.js";
import { samePublicInstallation } from "./publicCommentSourceIdentity.js";
import { publicInstallationSchema } from "./publicCommentTypes.js";
import type { PublicInstallation, PublicResult, PublicSourceRef } from "./publicCommentTypes.js";
type MetaChannel = "INSTAGRAM" | "FACEBOOK";
type Stamp = Readonly<{ installation: PublicInstallation; policyRevision: string }>;
type Request = object & { rawBody?: Buffer; aborted?: boolean; get(name: string): string | undefined };
export interface MetaPublicCapturePort {
  /** Actual exact Account/Settings + NORMAL Scope + policy read, no create/heal/default account. */
  readInstallation(channel: MetaChannel, externalId: string): Promise<Stamp | null>;
  /** Root P12 implementation MUST lock/re-read original installation/policy and persist
   * filtered queue rows + source digest/revision/origin capture atomically. Throw rolls back ALL.
   * No reset/reissue of existing delivery attempts (especially ACCEPTED/UNKNOWN). */
  commitQueueAndCapture(input: Readonly<{ expected: readonly Stamp[]; enabled: boolean;
    origin: "meta_verified_comment"; originalReceivedAt: number; items: readonly Readonly<IncomingComment>[] }>): Promise<PublicResult<readonly PublicSourceRef[]>>;
}
const key = (c: IncomingComment) => JSON.stringify([c.channel, c.accountExternalId, c.mediaId, c.commentId,
  c.parentId ?? null, c.authorId, c.authorName ?? null, c.text]);
const sameStamp = (a: Stamp, b: Stamp) => a.policyRevision === b.policyRevision && samePublicInstallation(a.installation, b.installation);
/** Bind this factory ONCE in server composition. Do not expose the port/commit via HTTP/model tools. */
export function createMetaPublicCapture(port: MetaPublicCapturePort, verifierStore?: CustomerMetaIssuerStore) {
  return async function open(request: Request): Promise<PublicResult<Readonly<{
    items: readonly Readonly<IncomingComment>[];
    commitFiltered(items: readonly IncomingComment[], enabled: boolean): Promise<PublicResult<readonly PublicSourceRef[]>>;
  }>>> {
    const requestEvidence = authenticatedCustomerRequestEvidence(request);
    if (!requestEvidence || requestEvidence.provenance !== "meta_signature" || !request.rawBody || request.aborted) return { status: "held", reason: "origin_missing" };
    const original = Buffer.from(request.rawBody), signature = request.get("x-hub-signature-256");
    let rows: IncomingComment[];
    try { rows = parseIncomingComments(JSON.parse(original.toString("utf8"))); }
    catch { return { status: "held", reason: "origin_changed" }; }
    // The real route's body limit remains authoritative; bounded local batch prevents unbounded capture work.
    if (!rows.length || rows.length > 200) return { status: "held", reason: "origin_missing" };
    const stamps = new Map<string, Stamp>();
    try {
      for (const row of rows) {
        if ((row.channel !== "INSTAGRAM" && row.channel !== "FACEBOOK") || !row.accountExternalId || !row.mediaId || !row.commentId) {
          return { status: "held", reason: "origin_missing" };
        }
        const stampKey = JSON.stringify([row.channel, row.accountExternalId]);
        if (stamps.has(stampKey)) continue;
        // Only an actual target-HMAC preflight may initialize a first PUBLIC namespace.
        if (!await verifyMetaCustomerReferralTarget(request, { channel: row.channel, peer: row.authorId,
          accountExternalId: row.accountExternalId }, verifierStore)) return { status: "held", reason: "origin_missing" };
        const before = await port.readInstallation(row.channel, row.accountExternalId);
        if (!before || !publicInstallationSchema.safeParse(before.installation).success ||
            before.installation.channel !== row.channel || before.installation.resourceId !== row.accountExternalId) {
          return { status: "held", reason: "installation_missing" };
        }
        // Actual same middleware-branded request, exact target configured key, SAME raw body.
        // This existing verifier gives PUBLIC routing assurance only; never reuse as DM/contact/action proof.
        if (!await verifyMetaCustomerReferralTarget(request, { channel: row.channel, peer: row.authorId,
          accountExternalId: row.accountExternalId }, verifierStore)) return { status: "held", reason: "origin_missing" };
        const after = await port.readInstallation(row.channel, row.accountExternalId);
        if (!after || !sameStamp(before, after)) return { status: "held", reason: "installation_changed" };
        stamps.set(stampKey, structuredClone(before));
      }
    } catch { return { status: "held", reason: "snapshot_unavailable" }; }
    if (!request.rawBody?.equals(original) || request.get("x-hub-signature-256") !== signature || request.aborted) {
      return { status: "held", reason: "origin_changed" };
    }
    const accepted = new Map(rows.map(row => [key(row), Object.freeze({ ...row })]));
    let used = false;
    const commitFiltered = async (selected: readonly IncomingComment[], enabled: boolean): Promise<PublicResult<readonly PublicSourceRef[]>> => {
      if (used || request.aborted) return { status: "held", reason: "capture_expired" };
      used = true; // Claim before first await; no repeated/parallel use of a producer capture.
      const unique = new Map<string, Readonly<IncomingComment>>();
      for (const row of selected) {
        const captured = accepted.get(key(row));
        if (!captured) return { status: "held", reason: "origin_changed" };
        unique.set(key(captured), captured);
      }
      try { return await port.commitQueueAndCapture({ expected: [...stamps.values()].map(s => structuredClone(s)),
        origin: "meta_verified_comment", originalReceivedAt: requestEvidence.issuedAt, enabled, items: [...unique.values()] }); }
      catch { return { status: "held", reason: "snapshot_unavailable" }; }
    };
    return { status: "current", value: Object.freeze({ items: Object.freeze([...accepted.values()]), commitFiltered }) };
  };
}
