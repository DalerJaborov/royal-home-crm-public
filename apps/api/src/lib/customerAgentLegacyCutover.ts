// Перевод клиентов полосы LEGACY на ядро (решение владельца 31.10.2026).
//
// ЗДЕСЬ ТОЛЬКО ДОПУСК, без записи полосы. Сама смена полосы требует миграции:
// строка CustomerAgentRolloutAssignment неизменяема (триггер
// customer_rollout_assignment_immutable) и единственна на субъекта (unique
// surface+endpointScopeId+subjectKey), а приём лида и мост новой заявки
// (customerActionJournal, customerNewLeadBridge) требуют у билета ссылку на
// назначение с lane='CORE'. Нужная миграция описана в
// docs/journal/2026-10-31-legacy-cutover-readiness.md.
//
// Допуск отвечает на один вопрос: можно ли СЛЕДУЮЩЕЕ новое входящее этого
// субъекта отдать ядру, не перехватив диалог у человека и не оборвав
// незавершённую работу старого движка. Только чтение, в транзакции вызывающего.
import type { TxClient } from "../db.js";

type Db = Pick<TxClient, "$queryRaw">;

/** Причины, по которым субъект остаётся в LEGACY. Порядок проверки — сверху вниз. */
export type CustomerLegacyCutoverBlocker =
  | "native_scope_collision"
  | "inquiry_closed"
  | "human_owner"
  | "manual_pause"
  | "agent_claimed"
  | "spam_silenced"
  | "legacy_batch_pending"
  | "legacy_job_pending"
  | "delivery_in_flight"
  | "ingress_pending";

export type CustomerLegacyCutoverReadiness =
  | { ready: true; nativeId: string | null }
  | { ready: false; reason: CustomerLegacyCutoverBlocker };

export const CUSTOMER_AGENT_LEGACY_CUTOVER_REASON = "legacy_cutover_owner_31_10";

/** Выключатель перевода. По умолчанию выключен; на проде включает владелец. */
export function customerAgentLegacyCutoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CUSTOMER_AGENT_LEGACY_CUTOVER?.trim().toLowerCase() === "on";
}

/**
 * Ручной режим: пауза бота (оператор взял диалог, сдача фонового повтора),
 * диалог закреплён за агентом по объекту, бот замолчал по спаму, владелец
 * диалога в учёте — человек, диалог закрыт.
 * Незавершённая работа: пачка дебаунса не отвечена, ждёт фоновое задание
 * по этому диалогу, доставка в полёте (READY/IN_FLIGHT), входящий билет
 * ещё не обработан (RECEIVED/CLAIMED). Доставки UNKNOWN и билеты HELD не
 * блокируют и НЕ трогаются: их не воскрешает ни этот допуск, ни перевод.
 */
export async function readCustomerLegacyCutoverReadiness(db: Db, subject: {
  channel: string; peer: string; endpointScopeId: string; scopeKey: string;
}, now: Date = new Date()): Promise<CustomerLegacyCutoverReadiness> {
  const natives = await db.$queryRaw<Array<{ id: string; endpointScopeId: string | null; pausedUntil: Date | null;
    propertyChatAgentId: string | null; spamFlaggedAt: Date | null; pendingSince: Date | null; pendingCount: number }>>`
    SELECT c."id",c."endpointScopeId",c."pausedUntil",c."propertyChatAgentId",c."spamFlaggedAt",c."pendingSince",
      (jsonb_array_length(COALESCE(c."pendingMessages",'[]'::jsonb))+jsonb_array_length(COALESCE(c."pendingAttachments",'[]'::jsonb)))::int AS "pendingCount"
    FROM "BotConversation" c
    WHERE c."channel"=${subject.channel} AND c."subscriberId"=${subject.peer}`;
  if (natives.length > 1 || natives.some(row => row.endpointScopeId !== subject.endpointScopeId)) {
    return { ready: false, reason: "native_scope_collision" };
  }
  const [inquiry] = await db.$queryRaw<Array<{ closed: boolean; human: boolean }>>`SELECT
    EXISTS(SELECT 1 FROM "CustomerInquiry" WHERE "endpointScopeId"=${subject.endpointScopeId} AND "peerId"=${subject.peer}
      AND ("conversationId" IS NULL OR "closedAt" IS NOT NULL)) AS closed,
    EXISTS(SELECT 1 FROM "CustomerInquiry" WHERE "endpointScopeId"=${subject.endpointScopeId} AND "peerId"=${subject.peer}
      AND "ownerMode"='HUMAN') AS human`;
  if (inquiry?.closed) return { ready: false, reason: "inquiry_closed" };
  if (inquiry?.human) return { ready: false, reason: "human_owner" };
  const native = natives[0];
  if (native) {
    if (native.pausedUntil && native.pausedUntil.getTime() > now.getTime()) return { ready: false, reason: "manual_pause" };
    if (native.propertyChatAgentId) return { ready: false, reason: "agent_claimed" };
    if (native.spamFlaggedAt) return { ready: false, reason: "spam_silenced" };
    if (native.pendingSince || native.pendingCount > 0) return { ready: false, reason: "legacy_batch_pending" };
    const [work] = await db.$queryRaw<Array<{ job: boolean; delivery: boolean }>>`SELECT
      EXISTS(SELECT 1 FROM "BackgroundJob" WHERE "status" IN ('PENDING','RUNNING')
        AND "payload"->>'conversationId'=${native.id}) AS job,
      EXISTS(SELECT 1 FROM "CustomerOutboxPart" WHERE "originalNativeId"=${native.id}
        AND "status" IN ('READY','IN_FLIGHT')) AS delivery`;
    if (work?.job) return { ready: false, reason: "legacy_job_pending" };
    if (work?.delivery) return { ready: false, reason: "delivery_in_flight" };
  }
  const [ingress] = await db.$queryRaw<Array<{ pending: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket"
    WHERE "endpointScopeId"=${subject.endpointScopeId} AND "scopeKey"=${subject.scopeKey} AND "tombstonedAt" IS NULL
      AND "processingState" IN ('RECEIVED','CLAIMED')) AS pending`;
  if (ingress?.pending) return { ready: false, reason: "ingress_pending" };
  return { ready: true, nativeId: native?.id ?? null };
}
