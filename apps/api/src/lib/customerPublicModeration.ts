import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerPublicCommentSnapshot } from "@royal-home/shared";
import { prisma } from "../db.js";
import { encryptSecret } from "../crypto.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import { callGraph, sendPrivateReply } from "../messengers/meta.js";
import { GRAPH_VERSION, instagramApiUrl } from "../messengers/metaGraph.js";
import { graphModerationOutcome, moderationErrorOutcome } from "../messengers/commentModerationOutcome.js";
import { inspectPublicCommentPrincipal, revalidatePublicCommentPrincipal, type PublicCommentPrincipal } from "./publicCommentSourceIssuer.js";
import { lockPublicCommentSourceTx, publicCommentOrigin, readPublicSourceRow, readPublicCommentMetaToken } from "./customerPublicCommentStore.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";
import { loadVerifiedCustomerAgentRevision } from "./customerAgentRegistration.js";
import { customerPublicModerationPlan, customerSellerPrivateReply } from "./customerPublicModerationPolicy.js";
import { dushanbeWallClock } from "./dushanbeTime.js";

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const DAY = 24 * 60 * 60_000;
type Outcome = "ACCEPTED" | "REFUSED" | "GONE" | "UNKNOWN" | "SUPPRESSED";
function same(current: ServerPublicCommentSnapshot | null, original: ServerPublicCommentSnapshot): boolean {
  const s = current?.settings;
  return !!current && current.status === "WORKING" && current.sourceRevision === original.sourceRevision &&
    isDeepStrictEqual(current.target, original.target) && current.text === original.text &&
    isDeepStrictEqual(current.proof, original.proof) && isDeepStrictEqual(current.currentInstallation, original.currentInstallation) &&
    isDeepStrictEqual(s, original.settings) && s?.contractVersion === "scoped" && s.rolloutMode === "ACTIVE" &&
    s.publicRead && s.botEnabled && s.botCanAnswerComments && s.metaEnabled &&
    (current.target.channel === "INSTAGRAM" ? s.botInstagramEnabled : s.botFacebookEnabled);
}

/** Source-specific POST authority: genuine principal + current compiled revision,
 * deterministic existing rule + durable one-shot claim + physical freshness.
 * No legacy turn, customer identity, CRM mutation, staff escalation or model grant. */
export async function executeCustomerPublicModeration(principal: PublicCommentPrincipal): Promise<"hidden" | "deleted" | "skipped" | "held"> {
  const original = inspectPublicCommentPrincipal(principal);
  if (!original || original.source.table !== "meta" || !original.currentInstallation ||
      !["INSTAGRAM", "FACEBOOK"].includes(original.target.channel)) return "held";
  const plan = customerPublicModerationPlan(original.text);
  if (!plan || !same(original, original) || (await revalidatePublicCommentPrincipal(principal)).status !== "current") return "held";
  const source = await readPublicSourceRow(original.source);
  if (!source) return "held";
  const origin = publicCommentOrigin(source), now = Date.now();
  if (now < origin.originalReceivedAt || now >= origin.agentPin.providerDeadlineAt || now - origin.originalReceivedAt > 15 * 60_000) return "held";
  const stored = await prisma.customerAgentRevision.findUnique({ where: { id: origin.agentPin.agentRevisionId } });
  if (!stored || (await loadVerifiedCustomerAgentRevision(decodeCustomerAgentRevision(stored))).status !== "current") return "held";
  const channel = original.target.channel as "INSTAGRAM" | "FACEBOOK";
  const sourceHash = sha({ source: original.source, revision: original.sourceRevision, text: original.text, target: original.target,
    installation: original.currentInstallation, proof: original.proof, settings: original.settings });
  const authorKey = sha([original.currentInstallation.id, source.authorId]);
  const dayKey = dushanbeWallClock(new Date()).toISOString().slice(0, 10);
  let result: Outcome = "SUPPRESSED", privateReplyId: string | null = null, privateReplyText: string | null = null;
  const notes: string[] = [];
  for (const kind of plan.steps) {
    // Private reply targets the original comment BEFORE deletion. A thread/window
    // restriction is an explicit non-send; it never becomes a fake receipt.
    if (kind === "private_reply" && (original.target.parentId || now - origin.originalReceivedAt >= 7 * DAY)) {
      notes.push("private_reply_ineligible"); continue;
    }
    const text = kind === "private_reply" ? customerSellerPrivateReply(detectClientLanguage(original.text) === "tg" ? "tg" : "ru") : "";
    const id = randomUUID();
    const reserved = await prisma.$transaction(async tx => {
      const current = await lockPublicCommentSourceTx(tx, original.source);
      if (!same(current, original)) return false;
      const [reply] = await tx.$queryRaw<Array<{ exists: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerOutboxPart"
        WHERE "sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY') AND "sourceKey"=${`meta:${original.source.id}`}) AS exists`;
      if (reply?.exists) return false;
      if (kind === "private_reply") {
        // Serialize different comments by the same genuine scoped author.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${authorKey},0))`;
        const [recent] = await tx.$queryRaw<Array<{ exists: boolean }>>`SELECT
          EXISTS(SELECT 1 FROM "CustomerPublicEffect" WHERE "endpointScopeId"=${original.currentInstallation!.id}
            AND "authorKey"=${authorKey} AND "kind"='private_reply' AND "createdAt">now()-interval '24 hours') OR
          EXISTS(SELECT 1 FROM "InstagramComment" WHERE "channel"=${channel} AND "accountExternalId"=${original.target.accountExternalId}
            AND "authorId"=${source.authorId} AND "dmSentAt">now()-interval '24 hours') AS exists`;
        if (recent?.exists) return "dm_limit" as const;
      }
      const created = await tx.$queryRaw<Array<{ id: string }>>`INSERT INTO "CustomerPublicEffect"
        ("id","sourceId","sourceRevision","sourceHash","endpointScopeId","policyRevision","agentRevisionId","authorKey","dayKey","kind","category","payloadEncrypted","payloadHash")
        VALUES (${id},${original.source.id},${BigInt(original.sourceRevision)},${sourceHash},${original.currentInstallation!.id},
          ${BigInt(original.settings.policyRevision)},${stored.id},${authorKey},${dayKey},${kind},${plan.category},
          ${text ? encryptSecret(text) : null},${sha({ kind, text })}) ON CONFLICT DO NOTHING RETURNING "id"`;
      return created.length === 1;
    });
    if (reserved === "dm_limit") { notes.push("private_reply_limited"); continue; }
    if (!reserved) return "held"; // includes prior IN_FLIGHT/UNKNOWN, never repeat it
    let claimedPhysical = false, physical = false;
    const beforePhysical = async () => {
      if (claimedPhysical) throw new Error("public_effect_already_attempted");
      claimedPhysical = true;
      if (Date.now() >= origin.agentPin.providerDeadlineAt || (await revalidatePublicCommentPrincipal(principal)).status !== "current") throw new Error("public_effect_source_changed");
      const [claim] = await prisma.$queryRaw<Array<{ status: string; sourceHash: string }>>`SELECT "status","sourceHash" FROM "CustomerPublicEffect" WHERE "id"=${id}`;
      if (claim?.status !== "IN_FLIGHT" || claim.sourceHash !== sourceHash) throw new Error("public_effect_claim_changed");
      physical = true;
    };
    let providerId: string | null = null, recipientKey: string | null = null, reason = "unconfirmed_attempt";
    try {
      const token = await readPublicCommentMetaToken(original.currentInstallation);
      if (!token) throw new Error("public_effect_credential_changed");
      if (kind === "private_reply") {
        providerId = await sendPrivateReply(original.target.commentId, text, [], token, channel, beforePhysical, observation => {
          if (observation.recipientId) recipientKey = sha([original.currentInstallation!.id, observation.recipientId]);
        });
        result = providerId ? "ACCEPTED" : "UNKNOWN"; reason = providerId ? "provider_id" : "missing_provider_id";
      } else {
        const path = `/${GRAPH_VERSION}/${encodeURIComponent(original.target.commentId)}`;
        const url = channel === "FACEBOOK" ? `https://graph.facebook.com${path}` : instagramApiUrl(path);
        const body = kind === "hide" ? channel === "FACEBOOK" ? { is_hidden: true } : { hide: true } : undefined;
        const raw = await callGraph(url, token, body, kind === "delete" ? "DELETE" : "POST", beforePhysical);
        const observed = graphModerationOutcome(channel, kind, raw);
        result = observed.outcome.toUpperCase() as Outcome; reason = observed.reason;
      }
    } catch (error) {
      const failure = moderationErrorOutcome(channel, kind === "hide" ? "hide" : "delete", error);
      result = !physical ? "SUPPRESSED" : failure.outcome === "refused" ? "REFUSED" : "UNKNOWN";
      reason = !physical ? "physical_attempt_not_admitted" : failure.reason;
    }
    // Always persist the actual outcome, even when source/policy changed during I/O.
    const count = await prisma.$executeRaw`UPDATE "CustomerPublicEffect" SET "status"=${result},"providerId"=${providerId},"recipientKey"=${result === "ACCEPTED" ? recipientKey : null},
      "outcomeReason"=${reason},"finishedAt"=now() WHERE "id"=${id} AND "status"='IN_FLIGHT'`;
    if (count !== 1) return "held";
    notes.push(`${kind}:${result.toLowerCase()}`);
    if (result !== "ACCEPTED") break;
    if (kind === "private_reply") { privateReplyId = providerId; privateReplyText = text; }
  }
  return prisma.$transaction(async tx => {
    const current = await lockPublicCommentSourceTx(tx, original.source);
    if (!same(current, original)) return "held";
    const deleted = notes.includes("delete:accepted"), hidden = notes.includes("hide:accepted");
    const status = deleted ? "DELETED" : hidden ? "HIDDEN" : "SKIPPED";
    const changed = await tx.$executeRaw`UPDATE "InstagramComment" SET "status"=${status},"note"=${`managed_core:${plan.category};${notes.join(";")}`.slice(0,200)},
      "hiddenAt"=CASE WHEN ${hidden} THEN now() ELSE "hiddenAt" END,
      "dmSentAt"=CASE WHEN ${privateReplyId !== null} THEN now() ELSE "dmSentAt" END,
      "dmText"=CASE WHEN ${privateReplyId !== null} THEN ${privateReplyText} ELSE "dmText" END,"updatedAt"=now()
      WHERE "id"=${original.source.id} AND "publicSourceRevision"=${BigInt(original.sourceRevision)} AND "status"='WORKING'`;
    return changed === 1 ? deleted ? "deleted" : hidden ? "hidden" : "skipped" : "held";
  });
}
