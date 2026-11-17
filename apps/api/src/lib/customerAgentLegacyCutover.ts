// Перевод клиентов полосы LEGACY на ядро (решение владельца 31.10.2026).
//
// Здесь допуск и выключатель. Сама смена полосы — новая строка назначения
// поколения 1 (миграция 20261031120000, функция cutoverLegacySubjectTx в
// customerAgentEnrollment.ts): прежняя строка LEGACY неизменна, эффективная
// полоса — последнее поколение. Разбор — docs/journal/2026-10-31-legacy-cutover-readiness.md.
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
  | "delivery_unsettled"
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
 * по этому диалогу, доставка не прояснена (READY/IN_FLIGHT/UNKNOWN — решение
 * владельца 31.10: неопределённая отправка держит перевод), входящий билет ещё
 * не обработан (RECEIVED/CLAIMED). Ничего из этого допуск не меняет и не
 * воскрешает: HOLD/UNKNOWN остаются как есть.
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
      EXISTS(SELECT 1 FROM "CustomerOutboxPart" WHERE ("originalNativeId"=${native.id} OR "conversationId"=${native.id})
        AND "status" IN ('READY','IN_FLIGHT','UNKNOWN')) AS delivery`;
    if (work?.job) return { ready: false, reason: "legacy_job_pending" };
    if (work?.delivery) return { ready: false, reason: "delivery_unsettled" };
  }
  const [ingress] = await db.$queryRaw<Array<{ pending: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket"
    WHERE "endpointScopeId"=${subject.endpointScopeId} AND "scopeKey"=${subject.scopeKey} AND "tombstonedAt" IS NULL
      AND "processingState" IN ('RECEIVED','CLAIMED')) AS pending`;
  if (ingress?.pending) return { ready: false, reason: "ingress_pending" };
  return { ready: true, nativeId: native?.id ?? null };
}

/** Причины, по которым ветка комментариев остаётся у старого движка. */
export type CustomerPublicLegacyCutoverBlocker =
  | "thread_unbounded"
  | "thread_managed_conflict"
  | "spam_silenced"
  | "human_owner"
  | "legacy_batch_pending"
  | "delivery_unsettled";

export type CustomerPublicLegacyCutoverReadiness =
  | { ready: true }
  | { ready: false; reason: CustomerPublicLegacyCutoverBlocker };

/**
 * Допуск ветки комментариев (шаг 3 удаления старого бота, 31.10.2026) —
 * аналог допуска лички. Ветка = все строки InstagramComment той же публикации
 * с commentId или parentId, равным якорю ветки (так же её видит запись в полосу).
 *
 * Спам: в ветке есть скрытый/удалённый комментарий (бот или человек).
 * Ручной режим: в ветке передача сотруднику (ESCALATED), ручной ответ
 * сотрудника (note manual_reply) или ответ сотрудника через общую доставку.
 * Незавершённая работа: старый движок ещё не разобрал строку (PENDING/WORKING)
 * или доставка по ветке не прояснена (READY/IN_FLIGHT/UNKNOWN).
 * Больше 200 строк — не переводим (тот же предел, что у записи в полосу).
 */
export async function readCustomerPublicLegacyCutoverReadiness(db: Db, thread: {
  channel: string; accountExternalId: string; publicationId: string; threadId: string;
}): Promise<CustomerPublicLegacyCutoverReadiness> {
  const rows = await db.$queryRaw<Array<{ id: string; status: string; note: string | null; managed: boolean }>>`
    SELECT c."id",c."status",c."note",(c."publicOriginCiphertext" IS NOT NULL) AS managed FROM "InstagramComment" c
    WHERE c."channel"=${thread.channel} AND c."accountExternalId"=${thread.accountExternalId} AND c."mediaId"=${thread.publicationId}
      AND (c."commentId"=${thread.threadId} OR c."parentId"=${thread.threadId}) LIMIT 201`;
  if (rows.length > 200) return { ready: false, reason: "thread_unbounded" };
  if (rows.some(row => row.managed)) return { ready: false, reason: "thread_managed_conflict" };
  if (rows.some(row => row.status === "HIDDEN" || row.status === "DELETED")) return { ready: false, reason: "spam_silenced" };
  if (rows.some(row => row.status === "ESCALATED" || row.note === "manual_reply")) return { ready: false, reason: "human_owner" };
  if (rows.some(row => row.status === "PENDING" || row.status === "WORKING")) return { ready: false, reason: "legacy_batch_pending" };
  const ids = rows.map(row => row.id);
  if (!ids.length) return { ready: true };
  const [parts] = await db.$queryRaw<Array<{ staff: boolean; unsettled: boolean }>>`SELECT
    EXISTS(SELECT 1 FROM "CustomerOutboxPart" WHERE "publicMetaCommentId"=ANY(${ids}::text[])
      AND "sourceKind"='STAFF_PUBLIC_COMMENT_REPLY') AS staff,
    EXISTS(SELECT 1 FROM "CustomerOutboxPart" WHERE "publicMetaCommentId"=ANY(${ids}::text[])
      AND "status" IN ('READY','IN_FLIGHT','UNKNOWN')) AS unsettled`;
  if (parts?.staff) return { ready: false, reason: "human_owner" };
  if (parts?.unsettled) return { ready: false, reason: "delivery_unsettled" };
  return { ready: true };
}

/** Строка назначения переведена (у неё есть преемник поколения+1). Только чтение. */
export async function customerAgentAssignmentSuperseded(db: Db, assignmentId: string): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ superseded: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment"
    WHERE "supersedesAssignmentId"=${assignmentId}) AS superseded`;
  return row?.superseded === true;
}

/** Строка назначения — результат перевода LEGACY → CORE (поколение > 0 с причиной перевода). */
export async function customerAgentLaneCutoverOf(db: Db, assignmentId: string): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ moved: boolean }>>`SELECT EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment"
    WHERE "id"=${assignmentId} AND "generation">0 AND "lane"='CORE'
      AND "transitionReason"=${CUSTOMER_AGENT_LEGACY_CUTOVER_REASON}) AS moved`;
  return row?.moved === true;
}
