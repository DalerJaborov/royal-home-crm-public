// Recovery of core turns that can never act again (prod 26.11.2026).
//
// CLAIMED: a claim's lease ends exactly at the original provider deadline
// (customerAgentClaim.ts: "leaseUntil" = pin.providerDeadlineAt). After it, the
// turn cannot write anything: every write re-checks the lease in the database
// (customerAgentClaimCurrentTx) and the pin refuses a new claim. A worker killed
// mid-turn (auto-deploy restart) therefore leaves a ticket CLAIMED that nobody
// will ever finish or release: releaseHeldClaim() only releases its OWN
// in-memory claim. Until 26.11 such a ticket blocked every revision advance
// forever, and its customer was silent with no signal to a person (a re-run
// ended as the intended silence "turn_already_owned").
//
// RECEIVED: past receipt + the revision deadline the pin answers "expired", so a
// RECEIVED ticket whose inbox job is gone (no PENDING job, no fresh RUNNING lock)
// will never be answered either. A job that gave up moves its own ticket to HELD
// (jobs/customerInboxConsume.ts) and reports it; this sweep catches the rest.
//
// What this does: such a ticket goes to HELD with its own error code — the shape
// releaseHeldClaim writes, CAS on the read state/claimRevision/leaseOwner and the
// same SQL predicate as the idle door (customer_agent_ticket_orphaned) — and the
// person learns through the one «бот не ответил клиенту» door, in the background
// (never holding the revision refresh). Never re-runs the model, never resends.
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { reportUnansweredCustomerTurn } from "./customerTurnSilence.js";
import { CLAIM_ORPHANED_REASON, RECEIVED_ORPHANED_REASON } from "./customerTicketOrphanReasons.js";

export { CLAIM_ORPHANED_REASON, RECEIVED_ORPHANED_REASON };
const BATCH = 50;

export type ReleasedCustomerTicket = { eventKey: string; reason: string };

/** Returns the tickets released by THIS call (each is reported exactly once, without awaiting the reports). Never throws. */
export async function releaseOrphanedCustomerAgentClaims(): Promise<ReleasedCustomerTicket[]> {
  const released: ReleasedCustomerTicket[] = [];
  try {
    const candidates = await prisma.$queryRaw<Array<{ eventKey: string; processingState: string; claimRevision: bigint; leaseOwner: string | null }>>`
      SELECT t."eventKey",t."processingState",t."claimRevision",t."leaseOwner" FROM "CustomerPropertyIngressTicket" t
      WHERE t."processingState" IN ('CLAIMED','RECEIVED') AND t."intakeAgentRevisionId" IS NOT NULL AND t."tombstonedAt" IS NULL
        AND customer_agent_ticket_orphaned(t."eventKey",t."processingState",t."receivedAt",t."leaseUntil",t."providerDeadlineAt",t."providerOperationId")
      ORDER BY t."receivedAt" LIMIT ${BATCH}`;
    for (const row of candidates) {
      const reason = row.processingState === "CLAIMED" ? CLAIM_ORPHANED_REASON : RECEIVED_ORPHANED_REASON;
      // CAS: the very state/claim we read, still orphaned at write time. A live
      // owner, a fresh job or a finished plan makes this a no-op.
      const changed = await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='HELD',
        "errorCode"=${reason},"leaseOwner"=NULL,"leaseUntil"=NULL
        WHERE "eventKey"=${row.eventKey} AND "processingState"=${row.processingState}
          AND "leaseOwner" IS NOT DISTINCT FROM ${row.leaseOwner} AND "claimRevision"=${row.claimRevision}
          AND customer_agent_ticket_orphaned("eventKey","processingState","receivedAt","leaseUntil","providerDeadlineAt","providerOperationId")`;
      if (changed === 1) released.push({ eventKey: row.eventKey, reason });
    }
  } catch (error) {
    void logSystemError("ai", `Не удалось снять брошенные ходы бота: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-agent-orphan-claims-failed", quietPult: true });
  }
  if (released.length) {
    void logSystemError("ai", `Ход бота оборвался (процесс перезапущен посреди ответа или задание очереди потеряно), ответ клиенту не ушёл: снято ${released.length}. ` +
      "Сотрудникам ушёл сигнал «бот не ответил клиенту»; повторно модель не вызывается.",
      { dedupKey: "customer-agent-orphan-claims-released", quietPult: true });
    // Not awaited: the staff signals must never delay the revision refresh that follows (reportUnansweredCustomerTurn never throws).
    void (async () => { for (const ticket of released) await reportUnansweredCustomerTurn(ticket.eventKey, ticket.reason); })();
  }
  return released;
}
