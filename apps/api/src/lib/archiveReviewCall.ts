import type { PermissionId } from "@royal-home/shared";

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

/** Начало записи хронологии, заведённой этим звонком, и итоговой записи после него. */
export const ARCHIVE_REVIEW_NOTE_PREFIX = "Разбор удалённого клиента";
export const ARCHIVE_REVIEW_START_NOTE = "Звонок инициирован из CRM — разбор удалённого клиента";

/**
 * Условие для запросов, которые считают РАБОТУ агента по звонкам: разбор из Корзины в неё не входит.
 * Подмешивать в `where` рядом с `type: "CALL"` и `agentId`.
 */
export const notArchiveReview = { archiveReview: false } as const;
