import { parsePermissionOverrides, resolvePermissions, type PermissionId, type Role } from "@royal-home/shared";

/**
 * ЗВОНОК КЛИЕНТУ ИЗ КОРЗИНЫ — «РАЗБОР УДАЛЁННОГО» (владелец 16.11.2026).
 *
 * РОП (Ноза) сама звонит каждому удалённому клиенту, чтобы выяснить, почему он оказался в
 * Корзине и что с ним сделал агент. Раньше сервер отвечал 409 «сначала восстановите карточку».
 *
 * Правило одно, для REST (POST /clients/:id/call) и для всего, что его зовёт:
 *  - право `clients.callArchived` (отдельное, чтобы директор мог снять его, не закрывая Архив)
 *    И `archive.view` (экран, с которого звонят) И `clients.viewAll` (видеть чужого клиента);
 *  - звонит АТС, номер остаётся маской; карточка НЕ восстанавливается, владелец и статус не меняются;
 *  - звонок не работа агента: запись хронологии с отметкой `archiveReview`, ни Royal Score,
 *    ни счётчик звонков, ни штрафы, ни статусы, ни задачи карточки его не видят
 *    (finishCall в telephony/callTracker.ts; счётчики — через `notArchiveReview`).
 *
 * Робот (живой голос), сообщения и заявки по удалённому клиенту по-прежнему закрыты.
 */
export function canCallArchivedClient(actor: { can: (permission: PermissionId) => boolean }): boolean {
  return actor.can("clients.callArchived") && actor.can("archive.view") && actor.can("clients.viewAll");
}

/**
 * То же правило для сотрудника, найденного в базе (входящий звонок не знает запроса): работает, не заморожен,
 * и все три права на месте. Проверяется В МОМЕНТ звонка, а не по давней записи о звонке разбора.
 */
export function agentMayCallArchived(agent: {
  role: string;
  permissions: unknown;
  isActive: boolean;
  frozenAt: Date | null;
}): boolean {
  if (!agent.isActive || agent.frozenAt) return false;
  const granted = resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions));
  return canCallArchivedClient({ can: (permission) => granted.has(permission) });
}

/** Начало записи хронологии, заведённой этим звонком, и итоговой записи после него. */
export const ARCHIVE_REVIEW_NOTE_PREFIX = "Разбор удалённого клиента";
export const ARCHIVE_REVIEW_START_NOTE = "Звонок инициирован из CRM — разбор удалённого клиента";

/**
 * ПЕРЕЗВОН КЛИЕНТА ИЗ КОРЗИНЫ — тому, кто ему звонил для разбора (владелец 17.11.2026).
 * Сколько часов после ЗВОНКА РОПа клиент, перезвонив, попадает к нему, а не к оператору. Окно НЕ
 * продлевается записью самого перезвона (см. ARCHIVE_REVIEW_CALLBACK_NOTE).
 */
export const ARCHIVE_REVIEW_CALLBACK_WINDOW_HOURS = 72;
/**
 * Окно, в котором мост после перевода считается ответом звонившего (когда номер аппарата не назван — мобильный).
 * С 17.11.2026 перезвон звонит РОПу полное время перевода, а оператору не уходит вовсе: 0 («без ограничения»)
 * — сутки, то есть любой мост.
 */
export function archiveCallbackRingSeconds(routeRingSeconds: number): number {
  return routeRingSeconds > 0 ? routeRingSeconds : 24 * 3600;
}
/** Часть текста записи «клиент перезвонил»: по ней такие записи отличают от исходящих звонков разбора. */
export const ARCHIVE_REVIEW_CALLBACK_NOTE = "клиент перезвонил";

/**
 * Условие для запросов, которые считают РАБОТУ агента по звонкам: разбор из Корзины в неё не входит.
 * Подмешивать в `where` рядом с `type: "CALL"` и `agentId`.
 */
export const notArchiveReview = { archiveReview: false } as const;
