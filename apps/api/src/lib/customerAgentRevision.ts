import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { customerAgentRevisionSchema, type CustomerAgentRevision, type CustomerFence } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { isCustomerPrincipal, type CustomerPrincipal } from "./customerPrincipal.js";
import { assertCustomerInboxPlannableTx } from "./customerIngressInbox.js";
import { loadAcceptedCustomerState, assertCustomerFence } from "./customerState.js";
import { providerDayDeadline } from "../ai/providerContract.js";

/** Immutable revision storage: manifestJson excludes id; id is its canonical content hash.
 * Registration/activation routes and monetary approval are NOT provided here. */
const manifestSchema = customerAgentRevisionSchema.omit({ id: true });
export type CustomerAgentManifest = z.infer<typeof manifestSchema>;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const operationIdSchema = z.string().uuid();
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Non-JSON revision value");
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Pure content identity, not registration, approval or activation. */
export function customerAgentManifestId(raw: unknown): string {
  return createHash("sha256").update(canonicalJson(manifestSchema.parse(raw))).digest("hex");
}
/** Rejects hash mismatch, unknown fields and an id embedded in manifestJson. */
export function decodeCustomerAgentRevision(row: { id: string; manifestJson: unknown }): Readonly<CustomerAgentRevision> {
  const id = digestSchema.parse(row.id), manifest = manifestSchema.parse(row.manifestJson);
  if (customerAgentManifestId(manifest) !== id) throw new TypeError("Immutable agent manifest hash mismatch");
  return freeze(customerAgentRevisionSchema.parse({ ...manifest, id }));
}
/** End-of-day is computed from ORIGINAL receivedAt in Asia/Dushanbe; no retry
 * gets a new day or a new15-minute origin lifetime. Does not approve a budget. */
export function customerAgentTurnDeadline(receivedAtMs: number, deadlineMs: number): number {
  if (!Number.isSafeInteger(receivedAtMs) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 900_000) {
    throw new TypeError("Original received time and bounded revision deadline required");
  }
  return providerDayDeadline(Math.min(receivedAtMs + deadlineMs, receivedAtMs + 900_000), new Date(receivedAtMs));
}

interface TicketRow {
  eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string | null;
  conversationId: string | null; originalConversationId: string | null; tombstonedAt: Date | null;
  receivedAt: Date | null; inputRecordedAt: Date | null; processingState: string | null;
  intakeAgentRevisionId: string | null; agentRevisionId: string | null; providerOperationId: string | null; providerDeadlineAt: Date | null;
}
declare const pinBrand: unique symbol;
export type CustomerAgentTurnPin = Readonly<{
  eventKey: string; order: string; agentRevisionId: string; providerOperationId: string;
  receivedAt: number; providerDeadlineAt: number; revision: Readonly<CustomerAgentRevision>;
}> & { readonly [pinBrand]: true };
const issued = new WeakMap<object, { principal: CustomerPrincipal; stored: Omit<CustomerAgentTurnPin, typeof pinBrand> }>();
export type CustomerAgentPinResult =
  | { status: "pinned"; fresh: boolean; pin: CustomerAgentTurnPin }
  | { status: "already_planned" }
  | { status: "held"; reason: "invalid_context" | "original_context_changed" | "ticket_unavailable" | "revision_unavailable" |
      "pins_inconsistent" | "expired" | "operation_mismatch" | "operation_closed" | "pin_changed" };

function sameController(a: Readonly<CustomerFence>, b: Readonly<CustomerFence>): boolean {
  return a.inquiryId === b.inquiryId && a.nativeId === b.nativeId &&
    a.endpoint.endpointScopeId === b.endpoint.endpointScopeId && a.endpoint.channel === b.endpoint.channel &&
    a.endpoint.accountId === b.endpoint.accountId && a.endpoint.peerId === b.endpoint.peerId && a.endpoint.threadId === b.endpoint.threadId &&
    a.ownerToken === b.ownerToken && a.ownershipEpoch === b.ownershipEpoch && a.bindingRevision === b.bindingRevision &&
    a.scopeRevision === b.scopeRevision && a.policyRevision === b.policyRevision;
}
/** Same current canonical input and ORIGINAL controller only. Server semantic
 * state/intent changes on this same IN may be read, never a different actor/IN.
 * This returns no write/outbound grant and does not refresh principal itself. */
async function lockOriginalTicket(tx: TxClient, principal: CustomerPrincipal): Promise<TicketRow | null> {
  // Existing helper locks native→scope→policy→Inquiry→Ticket and checks actual
  // FINAL decrypt/credential/original age + inputRecordedAt/canonical key/order.
  const witness = await assertCustomerInboxPlannableTx(tx, principal);
  if (!witness || witness.eventKey !== principal.admission.eventKey || witness.order !== principal.admission.order ||
      !sameController(principal.authority.fence, witness.originalFence)) return null;
  const current = await loadAcceptedCustomerState(principal.admission, tx);
  if (!current || !sameController(principal.authority.fence, current.fence) ||
      (await assertCustomerFence(tx, current.fence, "public_read")).status !== "current") return null;
  const [row] = await tx.$queryRaw<TicketRow[]>`SELECT "eventKey","order","scopeKey","endpointScopeId","conversationId","originalConversationId",
    "tombstonedAt","receivedAt","inputRecordedAt","processingState","intakeAgentRevisionId","agentRevisionId","providerOperationId","providerDeadlineAt"
    FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${principal.admission.eventKey} FOR UPDATE`;
  if (!row || row.tombstonedAt || !row.inputRecordedAt || !row.receivedAt ||
      row.eventKey !== principal.admission.eventKey || row.order.toString() !== principal.admission.order ||
      row.scopeKey !== principal.admission.scopeKey || row.endpointScopeId !== principal.scope.endpointScopeId ||
      row.conversationId !== principal.scope.conversationId || row.originalConversationId !== principal.scope.conversationId) return null;
  return row;
}
async function readRevision(tx: TxClient, id: string): Promise<Readonly<CustomerAgentRevision> | null> {
  if (!digestSchema.safeParse(id).success) return null;
  const [row] = await tx.$queryRaw<Array<{ id: string; manifestJson: unknown }>>`
    SELECT "id","manifestJson" FROM "CustomerAgentRevision" WHERE "id"=${id}`;
  if (!row) return null;
  try { return decodeCustomerAgentRevision(row); } catch { return null; }
}
function issuePin(principal: CustomerPrincipal, row: TicketRow, revision: Readonly<CustomerAgentRevision>): CustomerAgentTurnPin {
  const stored = freeze({ eventKey: row.eventKey, order: row.order.toString(), agentRevisionId: revision.id,
    providerOperationId: row.providerOperationId!, receivedAt: row.receivedAt!.getTime(),
    providerDeadlineAt: row.providerDeadlineAt!.getTime(), revision });
  const pin = stored as CustomerAgentTurnPin;
  issued.set(pin, { principal, stored });
  return pin;
}
async function existingPin(tx: TxClient, principal: CustomerPrincipal, row: TicketRow): Promise<CustomerAgentPinResult> {
  if (!row.agentRevisionId || !row.providerOperationId || !row.providerDeadlineAt || !operationIdSchema.safeParse(row.providerOperationId).success) {
    return { status: "held", reason: "pins_inconsistent" };
  }
  // Never read activeAgentRevisionId here. New activation cannot replace A pin.
  const revision = await readRevision(tx, row.agentRevisionId);
  if (!revision || !row.receivedAt) return { status: "held", reason: "revision_unavailable" };
  const receivedAt = row.receivedAt.getTime(), deadlineAt = customerAgentTurnDeadline(receivedAt, revision.limits.deadlineMs);
  if (row.providerDeadlineAt.getTime() !== deadlineAt) return { status: "held", reason: "pins_inconsistent" };
  if (receivedAt > Date.now() || Date.now() >= deadlineAt) return { status: "held", reason: "expired" };
  // The operation row legitimately does not exist until first reservation.
  // Plain SELECT introduces no operation-row lock after canonical locks.
  const [operation] = await tx.$queryRaw<Array<{ deadlineAt: Date; policyHash: string; status: string }>>`
    SELECT "deadlineAt","policyHash","status" FROM "AiProviderOperation" WHERE "id"=${row.providerOperationId}`;
  if (operation && (operation.deadlineAt.getTime() !== deadlineAt || operation.policyHash !== revision.providerPolicyHash)) {
    return { status: "held", reason: "operation_mismatch" };
  }
  if (operation && operation.status !== "OPEN") return { status: "held", reason: "operation_closed" };
  return { status: "pinned", fresh: false, pin: issuePin(principal, row, revision) };
}

/** Caller supplies the real scoped transaction; DB exceptions must propagate
 * to roll it back. No internal catch may commit a partially written pin. */
export async function pinCustomerAgentTurnTx(tx: TxClient, principal: unknown): Promise<CustomerAgentPinResult> {
  if (!isActiveTransactionClient(tx) || !isCustomerPrincipal(principal)) return { status: "held", reason: "invalid_context" };
  const row = await lockOriginalTicket(tx, principal);
  if (!row) return { status: "held", reason: "original_context_changed" };
  if (row.processingState === "PLANNED") return { status: "already_planned" };
  if (row.agentRevisionId !== null || row.providerOperationId !== null || row.providerDeadlineAt !== null) return existingPin(tx, principal, row);
  // Selection was captured under the RAW producer's policy lock. A later
  // activation cannot retarget an older input or adopt a legacy NULL choice.
  const revision = row.intakeAgentRevisionId ? await readRevision(tx, row.intakeAgentRevisionId) : null;
  if (!revision) return { status: "held", reason: "revision_unavailable" };
  const receivedAt = row.receivedAt!.getTime(), deadlineAt = customerAgentTurnDeadline(receivedAt, revision.limits.deadlineMs);
  if (receivedAt > Date.now() || Date.now() >= deadlineAt) return { status: "held", reason: "expired" };
  const operationId = randomUUID();
  const changed = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "agentRevisionId"=${revision.id},
    "providerOperationId"=${operationId},"providerDeadlineAt"=${new Date(deadlineAt)}
    WHERE "eventKey"=${row.eventKey} AND "order"=${row.order} AND "conversationId"=${principal.scope.conversationId}
      AND "originalConversationId"=${principal.scope.conversationId} AND "tombstonedAt" IS NULL AND "inputRecordedAt" IS NOT NULL
      AND "agentRevisionId" IS NULL AND "providerOperationId" IS NULL AND "providerDeadlineAt" IS NULL
      AND "processingState" IN ('RECEIVED','CLAIMED','HELD')`;
  if (changed !== 1) return { status: "held", reason: "pin_changed" };
  return { status: "pinned", fresh: true, pin: issuePin(principal,
    { ...row, agentRevisionId: revision.id, providerOperationId: operationId, providerDeadlineAt: new Date(deadlineAt) }, revision) };
}

/** Refresh only the same issued opaque pin with the SAME original principal.
 * After a fresh process uses genuine P11 recovery, pinCustomerAgentTurnTx reads
 * the immutable stored pin; copied JSON cannot call this renewal helper. */
export async function refreshCustomerAgentTurnPinTx(tx: TxClient, principal: unknown, pin: unknown): Promise<CustomerAgentPinResult> {
  const registered = pin && typeof pin === "object" ? issued.get(pin) : null;
  if (!isActiveTransactionClient(tx) || !isCustomerPrincipal(principal) || !registered || registered.principal !== principal) {
    return { status: "held", reason: "invalid_context" };
  }
  const row = await lockOriginalTicket(tx, principal);
  if (!row) return { status: "held", reason: "original_context_changed" };
  if (row.processingState === "PLANNED") return { status: "already_planned" };
  const expected = registered.stored;
  if (row.eventKey !== expected.eventKey || row.order.toString() !== expected.order || row.agentRevisionId !== expected.agentRevisionId ||
      row.providerOperationId !== expected.providerOperationId || row.receivedAt?.getTime() !== expected.receivedAt ||
      row.providerDeadlineAt?.getTime() !== expected.providerDeadlineAt) return { status: "held", reason: "pin_changed" };
  return existingPin(tx, principal, row);
}
