import { prepareVerifiedCustomerDmRouting, inspectCustomerDmRouting } from "./customerAgentIngressRouting.js";
import { prisma } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { authenticatedCustomerRequestEvidence, captureCustomerPendingVerification, recoverCustomerPendingEnvelope, verifyMetaCustomerReferralTarget } from "./customerIngressAuthority.js";
import { normalizeAuthenticatedCustomerIngress } from "./customerIngressNormalize.js";
import { customerIngressPayloadHash, encryptCustomerIngressPayload, decryptCustomerIngressPayload } from "./customerIngressPayload.js";
import { ensureCustomerEndpoint } from "./customerConversationScope.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { decodeCustomerAgentRevision } from "./customerAgentRevision.js";

type Request = object & { rawBody?: Buffer; get(name: string): string | undefined };
type Stored = { eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string | null; payloadVersion: number | null;
  payloadCiphertext: string | null; payloadHash: string | null; conversationId: string | null; originalConversationId: string | null; tombstonedAt: Date | null };
export type PersistedCustomerIngressBatch =
  | { status: "persisted"; tickets: Array<{ eventKey: string; order: string; fresh: boolean }>; unsupported: number }
  | { status: "bypass"; reason: "policy_off" | "unsupported" }
  | { status: "denied" | "unavailable"; reason: string };

/** Same-request raw normalization + required existing job in one short local
 * transaction. PENDING is not FINAL-IN; this function NEVER creates Bot rows. */
export async function persistVerifiedCustomerIngressBatch(request: Request): Promise<PersistedCustomerIngressBatch> {
  try {
    const routing = await prepareVerifiedCustomerDmRouting(request);
    if (routing.status === "held") return { status: routing.reason === "routing_target_not_verified" ? "denied" : "unavailable", reason: routing.reason };
    const owned = routing.status === "current" ? routing.witnesses.map(w => inspectCustomerDmRouting(w)!) : null;
    if (owned?.some(row => row.execution.lane === "HELD")) return { status: "unavailable", reason: "routing_held" };
    if (owned && owned.every(row => row.execution.lane === "LEGACY")) return { status: "bypass", reason: "unsupported" };
    const policy = await prisma.customerRuntimePolicy.findUnique({ where: { id: "singleton" }, select: { contractVersion: true, rolloutMode: true } });
    if (policy?.contractVersion !== "scoped" || policy.rolloutMode === "OFF") {
      if (!owned) return { status: "bypass", reason: "policy_off" };
      // Already durable original CORE redelivery can be ACKed after kill,
      // without re-enqueue, decrypting a new grant or legacy fallback.
      const retained: Array<{ eventKey: string; order: string; fresh: boolean }> = [];
      for (const selected of owned.filter(row => row.execution.lane === "CORE")) {
        if (!selected.eventKey || !selected.input.eventId) return { status: "unavailable", reason: "owned_core_stopped" };
        const row = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: selected.eventKey } });
        const originalInput = normalizeAuthenticatedCustomerIngress(request).entries.find(entry => entry.eventId === selected.input.eventId &&
          entry.channel === selected.input.channel && entry.peer === selected.input.peer && entry.accountExternalId === selected.input.accountExternalId);
        if (!row || !originalInput || row.scopeKey !== selected.scopeKey || row.endpointScopeId !== selected.transport.endpointScopeId ||
          row.payloadVersion !== 1 || !row.payloadCiphertext || row.payloadHash !== customerIngressPayloadHash(originalInput) || !row.intakeAgentRevisionId) {
          return { status: "unavailable", reason: "owned_core_stopped" };
        }
        retained.push({ eventKey: row.eventKey, order: row.order.toString(), fresh: false });
      }
      return { status: "persisted", tickets: retained, unsupported: routing.status === "current" ? routing.unsupported : 0 };
    }
    const requestEvidence = authenticatedCustomerRequestEvidence(request);
    if (!requestEvidence) return { status: "denied", reason: "request_not_authenticated" };
    const normalized = normalizeAuthenticatedCustomerIngress(request);
    const entries = owned ? normalized.entries.filter(entry => owned.some(row => row.execution.lane === "CORE" && row.input.channel === entry.channel &&
      row.input.peer === entry.peer && row.input.accountExternalId === entry.accountExternalId && row.input.eventKind === entry.eventKind && row.input.eventId === entry.eventId)) : normalized.entries;
    const unsupported = normalized.unsupported;
    if (!entries.length) return { status: "bypass", reason: "unsupported" };
    for (const entry of entries) {
      if (entry.channel !== "WEBSITE" && !await verifyMetaCustomerReferralTarget(request, {
        channel: entry.channel, peer: entry.peer, accountExternalId: entry.accountExternalId,
      })) return { status: "denied", reason: "target_not_verified" };
    }
    return await prisma.$transaction(async tx => {
      if (!isActiveTransactionClient(tx)) throw new Error("Inbox requires active transaction");
      const orders: bigint[] = [];
      for (const _entry of entries) {
        const [sequence] = await tx.$queryRaw<Array<{ order: bigint }>>`SELECT nextval('"CustomerPropertyIngressTicket_order_seq"') AS "order"`;
        if (!sequence) throw new Error("Inbox admission sequence unavailable");
        orders.push(sequence.order);
      }
      // Namespace work precedes the common policy lock (credential rotation
      // holds scope before policy). No native is created by this pending path.
      const endpoints = [];
      for (const entry of entries) endpoints.push(await ensureCustomerEndpoint(tx, {
        channel: entry.channel, subscriberId: entry.peer, accountExternalId: entry.accountExternalId,
      }));
      for (const scopeId of [...new Set(endpoints.map(endpoint => endpoint.endpointScopeId))].sort()) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CustomerEndpointScope" WHERE "id"=${scopeId} FOR SHARE`;
        if (rows.length !== 1) throw new Error("Inbox namespace unavailable");
      }
      const [current] = await tx.$queryRaw<Array<{ contractVersion: string; rolloutMode: string; activeAgentRevisionId: string | null }>>`
        SELECT "contractVersion","rolloutMode","activeAgentRevisionId" FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE`;
      if (current?.contractVersion !== "scoped" || current.rolloutMode === "OFF") {
        if (owned) throw new Error("Selected core was stopped before source commit");
        return { status: "bypass" as const, reason: "policy_off" as const };
      }
      // Brain selection is an immutable intake fact, NOT a customer grant.
      // A worker must not upgrade an older legacy-owned turn when an operator
      // activates a new revision while that turn is already being answered.
      let activeRevision: ReturnType<typeof decodeCustomerAgentRevision> | null = null;
      if (current.rolloutMode === "ACTIVE" && current.activeAgentRevisionId) {
        const [row] = await tx.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`
          SELECT "id","manifestJson" FROM "CustomerAgentRevision" WHERE "id"=${current.activeAgentRevisionId}`;
        if (!row) throw new Error("Configured customer revision unavailable");
        activeRevision = decodeCustomerAgentRevision(row);
      }
      const tickets: Array<{ eventKey: string; order: string; fresh: boolean }> = [];
      for (const [index, entry] of entries.entries()) {
        const endpoint = endpoints[index];
        const scopeKey = customerPropertyScopeKey(entry.channel, entry.peer, endpoint.accountId, endpoint.endpointScopeId);
        const eventKey = customerPropertyEventKey(scopeKey, entry.eventKind, entry.eventId);
        const selection = owned?.find(row => row.eventKey === eventKey);
        if (owned && (!selection || selection.execution.lane !== "CORE" || selection.execution.revisionId !== activeRevision?.id ||
          selection.transport.endpointScopeId !== endpoint.endpointScopeId || selection.transport.scopeRevision !== endpoint.scopeRevision)) {
          throw new Error("Original intake assignment changed before source commit");
        }
        const assignmentId = selection?.execution.lane === "CORE" ? selection.execution.assignment?.id ?? null : null;
        const originalRevisionId = selection?.execution.lane === "CORE" ? selection.execution.revisionId : activeRevision?.id ?? null;
        const hash = customerIngressPayloadHash(entry);
        const order = orders[index];
        const proof = await captureCustomerPendingVerification(request, entry, endpoint, tx);
        if (!proof) throw new Error("Inbox pending verification unavailable");
        const ciphertext = encryptCustomerIngressPayload({ version: 1, eventKey, order: order.toString(), scopeKey,
          endpointScopeId: endpoint.endpointScopeId, payloadHash: hash }, entry, proof);
        const receivedAt = requestEvidence.issuedAt;
        await tx.$executeRaw`INSERT INTO "CustomerPropertyIngressTicket"
          ("eventKey","order","scopeKey","endpointScopeId","eventKind","payloadVersion","payloadCiphertext","payloadHash","receivedAt","providerOccurredAt","processingState",
            "intakeAgentRevisionId","rolloutAssignmentId","routingSourceVersion","routingSourceHash","routingScopeRevision","routingProvenance")
          VALUES (${eventKey},${order},${scopeKey},${endpoint.endpointScopeId},${entry.eventKind},1,${ciphertext},${hash},
            ${new Date(receivedAt)},${entry.providerOccurredAt ? new Date(entry.providerOccurredAt) : null},'RECEIVED',
            ${originalRevisionId},${assignmentId},${selection ? 1 : null},${selection ? hash : null},
            ${selection ? BigInt(endpoint.scopeRevision) : null},${selection ? "META_ENVELOPE" : null})
          ON CONFLICT ("eventKey") DO NOTHING`;
        const [stored] = await tx.$queryRaw<Stored[]>`SELECT "eventKey","order","scopeKey","endpointScopeId","payloadVersion","payloadCiphertext","payloadHash",
          "conversationId","originalConversationId","tombstonedAt" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${eventKey} FOR UPDATE`;
        if (!stored || stored.scopeKey !== scopeKey || stored.endpointScopeId !== endpoint.endpointScopeId) throw new Error("Inbox scope mismatch");
        const fresh = stored.order === order;
        if (stored.tombstonedAt || (stored.originalConversationId && !stored.conversationId)) {
          tickets.push({ eventKey, order: stored.order.toString(), fresh: false }); continue;
        }
        // A historical payload-less row is not upgraded by replaying caller data.
        if (stored.payloadVersion !== 1 || !stored.payloadCiphertext || stored.payloadHash !== hash) throw new Error("Inbox immutable payload mismatch");
        if (fresh) await tx.backgroundJob.create({ data: { type: "customer-inbox-consume", payload: { version: 1, eventKey },
          maxAttempts: 5, dedupeKey: `customer-inbox-consume:${eventKey}` } });
        tickets.push({ eventKey, order: stored.order.toString(), fresh });
      }
      return { status: "persisted" as const, tickets, unsupported };
    }, { maxWait: 5000, timeout: 10000 });
  } catch (error) {
    // No raw payloads, URLs or verifier details in errors returned to a caller.
    return { status: "unavailable", reason: error instanceof SyntaxError ? "invalid_raw_payload" : "inbox_persistence_unavailable" };
  }
}

/** Only intake-pinned events enter the new core. An old pending/legacy-owned
 * input never acquires a different brain merely because settings changed. */
export async function consumeCustomerInboxTicket(eventKey: string): Promise<
  { status: "held" | "unchanged"; reason: string } | { status: "planned"; partIds: string[] }
> {
  if (!/^[a-f0-9]{64}$/.test(eventKey)) return { status: "held", reason: "invalid_event_key" };
  const selected = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey }, select: { intakeAgentRevisionId: true, payloadVersion: true } });
  // Historical property admissions are not durable P11 envelopes. Updating
  // their processing state would violate the payload/state SQL constraint.
  if (selected && selected.payloadVersion !== 1) return { status: "held", reason: "historical_payload_unavailable" };
  if (selected?.intakeAgentRevisionId) {
    const { runCustomerDmAgentTurn } = await import("./customerDmAgentTurn.js");
    const result = await runCustomerDmAgentTurn(eventKey);
    if (result.status === "held") await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket"
      SET "processingState"='HELD',"errorCode"=${result.reason} WHERE "eventKey"=${eventKey}
      AND "processingState" IN ('RECEIVED','HELD') AND "leaseOwner" IS NULL`;
    return result;
  }
  const recovered = await recoverCustomerPendingEnvelope(eventKey);
  return prisma.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Stored[]>`SELECT "eventKey","order","scopeKey","endpointScopeId","payloadVersion","payloadCiphertext","payloadHash",
      "conversationId","originalConversationId","tombstonedAt" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${eventKey} FOR UPDATE`;
    let reason = recovered.status === "pending" ? "planner_unavailable" : recovered.reason;
    if (!row || row.tombstonedAt || (row.originalConversationId && !row.conversationId)) reason = "native_tombstoned_or_missing";
    else if (row.payloadVersion !== 1 || !row.payloadCiphertext || !row.payloadHash || !row.endpointScopeId) reason = "historical_payload_unavailable";
    else {
      try { decryptCustomerIngressPayload({ version: 1, eventKey, order: row.order.toString(), scopeKey: row.scopeKey,
        endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext); }
      catch { reason = "payload_binding_invalid"; }
    }
    const changed = row ? await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='HELD',"errorCode"=${reason},
      "leaseOwner"=NULL,"leaseUntil"=NULL WHERE "eventKey"=${eventKey} AND ("processingState" IS NULL OR "processingState" IN ('RECEIVED','HELD','FAILED'))`
      : 0;
    return { status: changed === 1 ? "held" as const : "unchanged" as const, reason: changed === 1 ? reason : "state_not_claimed" };
  });
}
