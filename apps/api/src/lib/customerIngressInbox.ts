import { z } from "zod";
import type { CustomerFence } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { isActiveTransactionClient } from "./transactionScope.js";
import { customerPrincipalAuthenticatedInput, isCustomerPrincipal } from "./customerPrincipal.js";
import { authenticatedInputMatchesFence, inspectAuthenticatedCustomerInput, readVerifiedCustomerFinalOrigin } from "./customerIngressAuthority.js";
import { loadAcceptedCustomerState, lockCustomerStateSnapshot } from "./customerState.js";

type PlanWitness = { eventKey: string; order: string; originalFence: CustomerFence };
const checked = new WeakMap<object, Map<string, PlanWitness>>();
const planSchema = z.object({ eventKey: z.string().regex(/^[a-f0-9]{64}$/), order: z.string().regex(/^[1-9]\d{0,18}$/),
  turnKey: z.string().min(1).max(512), headEventKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Lock order matches canonical classification: native→scope→policy→Inquiry,
 * then Ticket. This is not a controller or a grant factory. */
export async function assertCustomerInboxPlannableTx(tx: TxClient, principal: unknown): Promise<PlanWitness | null> {
  if (!isActiveTransactionClient(tx) || !isCustomerPrincipal(principal)) return null;
  const input = customerPrincipalAuthenticatedInput(principal), evidence = inspectAuthenticatedCustomerInput(input);
  if (!input || !evidence?.acceptedFence) return null;
  const locked = await lockCustomerStateSnapshot(tx, { inquiryId: principal.authority.fence.inquiryId });
  if (!locked || !authenticatedInputMatchesFence(input, locked.fence)) return null;
  const current = await loadAcceptedCustomerState(principal.admission, tx);
  if (!current || current.fence.inquiryId !== locked.fence.inquiryId) return null;
  const origin = await readVerifiedCustomerFinalOrigin(tx, principal.admission.eventKey, true);
  if (!origin || origin.order !== principal.admission.order || origin.originalConversationId !== principal.scope.conversationId) return null;
  const [row] = await tx.$queryRaw<Array<{ inputRecordedAt: Date | null; processingState: string | null }>>`
    SELECT "inputRecordedAt","processingState" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${origin.eventKey}`;
  if (!row?.inputRecordedAt || !["RECEIVED", "CLAIMED", "HELD", "PLANNED"].includes(row.processingState ?? "")) return null;
  const witness = { eventKey: origin.eventKey, order: origin.order, originalFence: origin.input.acceptedFence };
  const witnesses = checked.get(tx) ?? new Map<string, PlanWitness>(); witnesses.set(witness.eventKey, witness); checked.set(tx, witnesses);
  return structuredClone(witness);
}
/** Parts + required jobs must already be inserted by P12 in THIS transaction.
 * A same-plan retry is idempotent; a different turn/head can never replace it. */
export async function markCustomerInboxPlannedTx(tx: TxClient, raw: z.infer<typeof planSchema>): Promise<void> {
  const input = planSchema.parse(raw), witness = checked.get(tx)?.get(input.eventKey);
  if (!isActiveTransactionClient(tx) || !witness || witness.order !== input.order || input.headEventKey !== input.eventKey) {
    throw new Error("Checked inbox transaction required");
  }
  const [row] = await tx.$queryRaw<Array<{ processingState: string | null; turnKey: string | null; headEventKey: string | null }>>`
    SELECT "processingState","turnKey","headEventKey" FROM "CustomerPropertyIngressTicket" WHERE "eventKey"=${input.eventKey}`;
  if (row?.processingState === "PLANNED") {
    if (row.turnKey !== input.turnKey || row.headEventKey !== input.headEventKey) throw new Error("Existing inbox plan differs");
    return;
  }
  const changed = await tx.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='PLANNED',"plannedAt"=clock_timestamp(),
    "turnKey"=${input.turnKey},"headEventKey"=${input.headEventKey},"errorCode"=NULL,"leaseOwner"=NULL,"leaseUntil"=NULL
    WHERE "eventKey"=${input.eventKey} AND "order"=${BigInt(input.order)} AND "tombstonedAt" IS NULL
      AND "inputRecordedAt" IS NOT NULL AND "originVersion"=1 AND "originCiphertext" IS NOT NULL
      AND "processingState" IN ('RECEIVED','CLAIMED','HELD')`;
  if (changed !== 1) throw new Error("Inbox planning CAS failed");
}
