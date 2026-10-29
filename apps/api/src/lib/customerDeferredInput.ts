import { prisma } from "../db.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { logSystemError } from "./systemError.js";
import { customerPrincipalAuthenticatedInput, type CustomerPrincipal } from "./customerPrincipal.js";
import { inspectAuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { decryptCustomerFinalOrigin } from "./customerOriginPayload.js";
import { decryptCustomerIngressEnvelope } from "./customerIngressPayload.js";
import { customerDmAttachmentInput } from "./customerDmAttachmentInput.js";
import { decodeCustomerAgentMediaObservation } from "./customerAgentMediaObservation.js";
import { customerMemoryFenceMatches, minimizeCustomerAgentMemoryText } from "./customerAgentVerifiedContext.js";
import { NEWER_INPUT_PENDING, NEWER_INPUT_RESUMED } from "./customerNewerInboxInput.js";

/** How far back a deferred question still belongs to the SAME customer turn. */
const CARRY_WINDOW_MS = 10 * 60_000;
const CARRY_MAX_TICKETS = 5;
/** The single re-run of an accepted newer input waits a little: what stopped it (storage, a racing state change) is usually transient. */
const RESUME_B_DELAY_MS = 15_000;
/** Upper bound of the carried block; the oldest pieces are dropped first. */
export const CARRIED_INPUT_MAX_CHARS = 2000;

/** Pure: chronological pieces -> one block that fits the bound. Whole pieces
 * only (a number or a sentence is never sliced); the NEWEST pieces survive. */
export function composeCarriedInput(pieces: readonly string[], maxChars: number = CARRIED_INPUT_MAX_CHARS): string {
  const kept: string[] = [];
  let used = 0;
  for (const piece of [...pieces].reverse()) {
    const text = piece.trim();
    if (!text) continue;
    const next = used + text.length + (kept.length ? 1 : 0);
    if (next > maxChars) break;
    kept.unshift(text); used = next;
  }
  return kept.join("\n");
}

/** Text of the earlier inputs of this customer that were put aside as
 * `newer_input_pending` and never answered (nothing planned after them), in
 * chronological order. F12 (23.10.2026): a deferred question used to vanish —
 * public_envelope has no memory at all, and even a protected turn only saw it as
 * history, not as part of what the customer is asking NOW. Read-only; neither
 * renews the old input's age nor grants anything. Historical content is minimized
 * exactly like remembered turns; media content crosses only as a kind marker
 * (plus the stored transcript when BOTH inputs are protected_namespace). */
export async function loadDeferredCustomerInput(principal: CustomerPrincipal): Promise<string> {
  try {
    const frame = customerPrincipalAuthenticatedInput(principal), current = frame && inspectAuthenticatedCustomerInput(frame);
    if (!current || current.provenance !== "meta_signature" || principal.visibility !== "private_dm") return "";
    const scope = { conversationId: principal.scope.conversationId, originalConversationId: principal.scope.conversationId,
      scopeKey: principal.scope.scopeKey, endpointScopeId: principal.scope.endpointScopeId, tombstonedAt: null };
    const currentOrder = BigInt(principal.admission.order);
    // Anything planned after a deferred input answered the conversation already.
    const barrier = await prisma.customerPropertyIngressTicket.findFirst({
      where: { ...scope, order: { lt: currentOrder }, processingState: "PLANNED" }, orderBy: { order: "desc" }, select: { order: true } });
    const rows = await prisma.customerPropertyIngressTicket.findMany({ where: { ...scope,
      order: { lt: currentOrder, ...(barrier ? { gt: barrier.order } : {}) }, processingState: "HELD", errorCode: { in: [NEWER_INPUT_PENDING, NEWER_INPUT_RESUMED] },
      plannedAt: null, payloadVersion: 1, originVersion: 1, outboxParts: { none: {} },
      receivedAt: { gte: new Date(current.issuedAt - CARRY_WINDOW_MS) } },
      orderBy: { order: "desc" }, take: CARRY_MAX_TICKETS, select: { eventKey: true, order: true, scopeKey: true, endpointScopeId: true,
        payloadCiphertext: true, payloadHash: true, originCiphertext: true, receivedAt: true, agentRevisionId: true,
        providerOperationId: true, mediaObservationVersion: true, mediaObservationCiphertext: true, mediaObservedAt: true } });
    const pieces: string[] = [];
    for (const row of [...rows].reverse()) {
      if (!row.payloadCiphertext || !row.payloadHash || !row.originCiphertext || !row.endpointScopeId) continue;
      try {
        const envelope = decryptCustomerIngressEnvelope({ version: 1, eventKey: row.eventKey, order: row.order.toString(),
          scopeKey: row.scopeKey, endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext);
        const origin = decryptCustomerFinalOrigin(row.originCiphertext), prior = origin.input;
        if (origin.eventKey !== row.eventKey || origin.order !== row.order.toString() || origin.scopeKey !== row.scopeKey ||
            origin.originalConversationId !== principal.scope.conversationId || origin.payloadHash !== row.payloadHash ||
            prior.provenance !== "meta_signature" || prior.channel !== current.channel || prior.peer !== current.peer ||
            prior.accountExternalId !== current.accountExternalId || prior.issuerAccountId !== current.issuerAccountId ||
            prior.issuerEndpointScopeId !== current.issuerEndpointScopeId || prior.issuedAt !== row.receivedAt.getTime() ||
            prior.inputText !== envelope.payload.inputText || prior.eventId !== envelope.payload.eventId ||
            envelope.payload.observations.providerEcho || envelope.payload.observations.referralOnly ||
            envelope.payload.observations.classifier?.bareTemplateEcho === true ||
            !customerMemoryFenceMatches(prior.acceptedFence, principal.authority.fence)) continue;
        const kinds = customerDmAttachmentInput(envelope.payload)?.kinds ?? [];
        let transcript = "";
        if (prior.assurance === "protected_namespace" && current.assurance === "protected_namespace" &&
            row.mediaObservationVersion === 1 && row.mediaObservationCiphertext && row.mediaObservedAt && row.agentRevisionId && row.providerOperationId) {
          transcript = decodeCustomerAgentMediaObservation(row.mediaObservationCiphertext, { version: 1, eventKey: row.eventKey,
            payloadHash: row.payloadHash, agentRevisionId: row.agentRevisionId, providerOperationId: row.providerOperationId,
            observedAt: row.mediaObservedAt.getTime() }).transcript;
        }
        const text = minimizeCustomerAgentMemoryText([prior.inputText.trim(), transcript.trim(),
          kinds.length ? `[вложение: ${kinds.join(", ")}]` : ""].filter(Boolean).join("\n"));
        if (text) pieces.push(text);
      } catch { /* A corrupt or unverifiable earlier input is simply not carried. */ }
    }
    return composeCarriedInput(pieces);
  } catch {
    return "";
  }
}

/** The NEWER input that put an older one aside has itself ended without an
 * answer (HELD/ignored, job finished): re-arm a consumer so the customer is not
 * left with no reply at all. Two cases, decided by whether the newer input B got
 * as far as FINAL acceptance (B's `originCiphertext`):
 *  - B never reached acceptance (early hold): the deferred input A is still the
 *    last accepted one, so A itself is re-armed (job key per input).
 *  - B was accepted: every older input is permanently stale (canonicalOriginCurrent
 *    requires the inquiry's last accepted event to be that very input, "a late
 *    original never adopts a newer accepted one"), so A can never run again. B is
 *    re-run instead, once, under its own resume key; the deferred rows are marked
 *    `newer_input_resumed` first so B's run still CARRIES their words but a second
 *    failure of B cannot re-arm anything (no loop, at most one extra model turn).
 * A resumed turn still runs every normal check — its own deadline, a newer
 * genuine input, the controller fence — and simply holds again if it fails. */
export async function resumeDeferredCustomerInbox(endedEventKey: string): Promise<string | null> {
  try {
    const [row] = await prisma.$queryRaw<Array<{ eventKey: string; accepted: boolean }>>`
      SELECT d."eventKey", (n."originCiphertext" IS NOT NULL) AS "accepted" FROM "CustomerPropertyIngressTicket" n
      JOIN "CustomerPropertyIngressTicket" d ON d."scopeKey"=n."scopeKey" AND d."endpointScopeId"=n."endpointScopeId"
      WHERE n."eventKey"=${endedEventKey} AND d."order"<n."order" AND d."processingState"='HELD' AND d."errorCode"=${NEWER_INPUT_PENDING}
        AND d."tombstonedAt" IS NULL AND d."plannedAt" IS NULL AND d."payloadVersion"=1 AND d."intakeAgentRevisionId" IS NOT NULL
        AND d."receivedAt" > now() - interval '15 minutes'
        AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey"=d."eventKey")
        AND NOT EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x WHERE x."scopeKey"=d."scopeKey"
          AND x."endpointScopeId"=d."endpointScopeId" AND x."order">d."order" AND x."processingState"='PLANNED')
      ORDER BY d."order" DESC LIMIT 1`;
    if (!row) return null;
    if (row.accepted) {
      // B is the only input that can still be answered, and only if it has not been answered or sent already.
      const [still] = await prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT (n."processingState" IS DISTINCT FROM 'PLANNED' AND n."managedOutputRecordedAt" IS NULL AND n."tombstonedAt" IS NULL
          AND n."payloadVersion"=1 AND n."intakeAgentRevisionId" IS NOT NULL AND n."receivedAt" > now() - interval '15 minutes'
          AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey"=n."eventKey")) AS "ok"
        FROM "CustomerPropertyIngressTicket" n WHERE n."eventKey"=${endedEventKey}`;
      if (!still?.ok) return null;
      await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" d SET "errorCode"=${NEWER_INPUT_RESUMED}
        FROM "CustomerPropertyIngressTicket" n
        WHERE n."eventKey"=${endedEventKey} AND d."scopeKey"=n."scopeKey" AND d."endpointScopeId"=n."endpointScopeId"
          AND d."order"<n."order" AND d."processingState"='HELD' AND d."errorCode"=${NEWER_INPUT_PENDING} AND d."plannedAt" IS NULL`;
      const requeued = await enqueueBackgroundJob({ type: "customer-inbox-consume", payload: { version: 1, eventKey: endedEventKey },
        maxAttempts: 5, dedupeKey: `customer-inbox-resume:${endedEventKey}`, runAt: new Date(Date.now() + RESUME_B_DELAY_MS) });
      return requeued.enqueued ? endedEventKey : null;
    }
    const queued = await enqueueBackgroundJob({ type: "customer-inbox-consume", payload: { version: 1, eventKey: row.eventKey },
      maxAttempts: 5, dedupeKey: `customer-inbox-consume:${row.eventKey}` });
    return queued.enqueued ? row.eventKey : null;
  } catch (error) {
    void logSystemError("background-jobs", `Не удалось возобновить отложенное входящее клиента: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "customer-inbox-resume-deferred" });
    return null;
  }
}

