import { prisma } from "../db.js";
import type { CustomerAttemptRow } from "./customerDeliveryContracts.js";
import { isMessagingWindowClosedError } from "./messagingWindow.js";
import { findAgentsWithPermission } from "./recipients.js";
import { sendPushToAgents } from "../push.js";
import { logSystemError } from "./systemError.js";

/** Marker on the ACCEPTED attempt: the provider later reported the 24-hour window closed (131047). Set once, so a person is told once. */
export const CUSTOMER_DELIVERY_WINDOW_CLOSED = "window_closed";

/**
 * WHATSAPP 24-HOUR WINDOW CLOSED FOR A CORE REPLY (131047, 18.11.2026; core-architecture review 4б: the core delivery had no branch for
 * it). WhatsApp accepts the send (HTTP 200, a message id) and reports «Re-engagement message» later, in the `failed` status webhook.
 * The legacy path already shows the agent «the window is closed» (lib/conversationDelivery.ts); the core showed nothing.
 *  - never a resend: the window opens only when the CUSTOMER writes, and an ACCEPTED part is never sent again anyway;
 *  - a person is shown the client once per part: the attempt gets the marker under a row lock, only the first status notifies;
 *  - not a closed window (131026 «undeliverable», #551, any other failure) → false, the webhook's general log stays as it is.
 * Returns true when this call marked the part and told a person.
 */
export async function noteCustomerDeliveryWindowClosed(input: { mid: string; errorCode?: number | string | null; error?: string | null }): Promise<boolean> {
  if (!input.mid || input.mid.length > 512) return false;
  if (!isMessagingWindowClosedError(`${input.errorCode ?? ""} ${input.error ?? ""}`)) return false;
  const marked = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string; partId: string; errorCode: string | null; conversationId: string | null; channel: string }>>`
      SELECT a."id", a."partId", a."errorCode", p."conversationId", p."channel" FROM "CustomerDeliveryAttempt" a
      JOIN "CustomerOutboxPart" p ON p."id"=a."partId" AND p."endpointScopeId"=a."endpointScopeId"
      WHERE a."providerMid"=${input.mid} AND a."outcome"='ACCEPTED' FOR UPDATE OF a`;
    if (rows.length !== 1 || rows[0].errorCode === CUSTOMER_DELIVERY_WINDOW_CLOSED) return null;
    await tx.$executeRaw`UPDATE "CustomerDeliveryAttempt" SET "errorCode"=${CUSTOMER_DELIVERY_WINDOW_CLOSED} WHERE "id"=${rows[0].id}`;
    return rows[0];
  });
  if (!marked) return false;
  try {
    const recipients = await findAgentsWithPermission("messages.view");
    await sendPushToAgents(recipients, {
      title: "Клиент не получил ответ бота",
      body: "WhatsApp не доставил ответ: клиент не писал больше суток (окно 24 часа закрыто). Позвоните клиенту или дождитесь его сообщения.",
      url: marked.conversationId ? `/messages?open=${marked.conversationId}` : "/messages",
      tag: `core-window-closed-${marked.partId}`,
    });
  } catch (error) {
    await logSystemError("meta", `Ответ бота не дошёл (окно 24 часа закрыто), уведомить сотрудников не удалось: ${error instanceof Error ? error.message : String(error)}`.slice(0, 480),
      { dedupKey: `core-window-closed-push:${marked.partId}` }).catch(() => {});
  }
  return true;
}

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
