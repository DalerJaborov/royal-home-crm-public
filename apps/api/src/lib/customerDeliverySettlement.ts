import { prisma } from "../db.js";
import type { CustomerAttemptRow } from "./customerDeliveryContracts.js";

/** Exact attempt receipt survives an expired job/domain lease. It never creates
 * a new attempt, retargets a part or renews old canonical authority. */
export async function recordCustomerDeliveryAttemptOutcome(attemptId: string,
  outcome: "ACCEPTED" | "UNKNOWN" | "REJECTED" | "NOT_SENT", mid: string | null = null, errorCode: string | null = null): Promise<void> {
  try { await prisma.$transaction(async tx => {
    const [attempt] = await tx.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${attemptId} FOR UPDATE`;
    if (!attempt) throw new Error("Delivery attempt missing");
    if (attempt.outcome === "ACCEPTED") {
      if (outcome === "ACCEPTED" && attempt.providerMid !== mid) throw new Error("Delivery MID conflict");
      return;
    }
    if (outcome === "ACCEPTED" && (!mid || mid.length > 512)) throw new Error("Provider acceptance requires bounded MID");
    let effectiveOutcome = outcome, associatedMid = mid, effectiveError = errorCode;
    if (mid) {
      const [collision] = await tx.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "CustomerDeliveryAttempt"
        WHERE "endpointScopeId"=${attempt.endpointScopeId} AND "providerMid"=${mid} AND "id"<>${attempt.id}) AS exists`;
      if (collision?.exists) { effectiveOutcome = "UNKNOWN"; associatedMid = null; effectiveError = "mid_conflict"; }
    }
    await tx.$executeRaw`UPDATE "CustomerDeliveryAttempt" SET "outcome"=${effectiveOutcome},"providerMid"=${associatedMid},"reportedMid"=${mid},"finishedAt"=now(),
      "errorCode"=${effectiveError?.slice(0, 80) ?? null} WHERE "id"=${attempt.id}`;
    const partStatus = effectiveOutcome === "ACCEPTED" ? "ACCEPTED" : effectiveOutcome === "UNKNOWN" ? "UNKNOWN" : effectiveOutcome === "NOT_SENT" ? "NOT_SENT" : "SUPPRESSED";
    await tx.$executeRaw`UPDATE "CustomerOutboxPart" SET "status"=${partStatus},"acceptedAt"=CASE WHEN ${effectiveOutcome}='ACCEPTED' THEN now() ELSE "acceptedAt" END,
      "leaseUntil"=NULL,"leaseOwner"=NULL,"updatedAt"=now() WHERE "id"=${attempt.partId} AND "claimRevision"=${attempt.claimRevision}
      AND "status" IN ('IN_FLIGHT','UNKNOWN','NOT_SENT','SUPPRESSED')`;
  }); } catch (error) {
    // A concurrent exact-MID association can win after the lookup. PostgreSQL
    // aborts that transaction; retain the observation in a NEW transaction.
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : null;
    const meta = error && typeof error === "object" ? Reflect.get(error, "meta") : null;
    const unique = code === "P2002" || code === "P2010" && meta && typeof meta === "object" && Reflect.get(meta, "code") === "23505";
    if (!mid || !unique) throw error;
    await prisma.$transaction(async tx => {
      const [attempt] = await tx.$queryRaw<CustomerAttemptRow[]>`SELECT * FROM "CustomerDeliveryAttempt" WHERE "id"=${attemptId} FOR UPDATE`;
      if (!attempt) throw new Error("Delivery attempt missing after MID conflict");
      if (attempt.outcome === "ACCEPTED") return;
      await tx.$executeRaw`UPDATE "CustomerDeliveryAttempt" SET "outcome"='UNKNOWN',"reportedMid"=${mid},"providerMid"=NULL,
        "finishedAt"=now(),"errorCode"='mid_conflict' WHERE "id"=${attempt.id}`;
      await tx.$executeRaw`UPDATE "CustomerOutboxPart" SET "status"='UNKNOWN',"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=now()
        WHERE "id"=${attempt.partId} AND "claimRevision"=${attempt.claimRevision} AND "status"<>'ACCEPTED'`;
    });
  }
}
