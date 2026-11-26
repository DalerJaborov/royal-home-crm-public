// Recovery of core turns abandoned by a dead worker (prod 26.11.2026).
//
// A claim's lease ends exactly at the original provider deadline
// (customerAgentClaim.ts: "leaseUntil" = pin.providerDeadlineAt). After it, the
// turn cannot write anything: every write re-checks the lease in the database
// (customerAgentClaimCurrentTx) and the pin refuses a new claim. A worker killed
// mid-turn (auto-deploy restart) therefore leaves a ticket CLAIMED that nobody
// will ever finish or release: releaseHeldClaim() only releases its OWN
// in-memory claim. Until 26.11 such a ticket blocked every revision advance
// forever, and its customer was silent with no signal to a person (a re-run
// ended as the intended silence "turn_already_owned").
//
// What this does: a CLAIMED ticket past lease AND provider deadline (+5 min,
// the same predicate as the idle door customer_agent_claim_orphaned) goes to
// HELD with its own error code — the shape releaseHeldClaim writes, CAS on the
// read claimRevision/leaseOwner — and the person learns through the one
// «бот не ответил клиенту» door. Never re-runs the model, never resends.
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { reportUnansweredCustomerTurn } from "./customerTurnSilence.js";

export const CLAIM_ORPHANED_REASON = "claim_orphaned_after_deadline";
const BATCH = 50;

/** Returns the event keys released by THIS call (each is reported exactly once). Never throws. */
export async function releaseOrphanedCustomerAgentClaims(): Promise<string[]> {
  const released: string[] = [];
  try {
    const candidates = await prisma.$queryRaw<Array<{ eventKey: string; claimRevision: bigint; leaseOwner: string }>>`
      SELECT t."eventKey",t."claimRevision",t."leaseOwner" FROM "CustomerPropertyIngressTicket" t
      WHERE t."processingState"='CLAIMED' AND t."leaseOwner" IS NOT NULL
        AND customer_agent_claim_orphaned(t."processingState",t."leaseUntil",t."providerDeadlineAt",t."providerOperationId")
      ORDER BY t."leaseUntil" LIMIT ${BATCH}`;
    for (const row of candidates) {
      // CAS: the very claim we read, still orphaned at write time. A live owner
      // (impossible past the deadline) or a finished plan makes this a no-op.
      const changed = await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='HELD',
        "errorCode"=${CLAIM_ORPHANED_REASON},"leaseOwner"=NULL,"leaseUntil"=NULL
        WHERE "eventKey"=${row.eventKey} AND "processingState"='CLAIMED' AND "leaseOwner"=${row.leaseOwner}
          AND "claimRevision"=${row.claimRevision}
          AND customer_agent_claim_orphaned("processingState","leaseUntil","providerDeadlineAt","providerOperationId")`;
      if (changed === 1) released.push(row.eventKey);
    }
  } catch (error) {
    void logSystemError("ai", `Не удалось снять брошенные ходы бота: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-agent-orphan-claims-failed", quietPult: true });
  }
  if (released.length) {
    void logSystemError("ai", `Ход бота оборвался (процесс перезапущен посреди ответа), ответ клиенту не ушёл: снято ${released.length}. ` +
      "Сотрудникам ушёл сигнал «бот не ответил клиенту»; повторно модель не вызывается.",
      { dedupKey: "customer-agent-orphan-claims-released", quietPult: true });
    for (const eventKey of released) await reportUnansweredCustomerTurn(eventKey, CLAIM_ORPHANED_REASON);
  }
  return released;
}
