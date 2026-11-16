/**
 * «БЕЗ КОНТАКТА» — ОДНО ПРАВИЛО НА ВСЮ CRM (владелец 16.11.2026).
 *
 * Отчёт для РОП и директора: у каких клиентов в работе больше суток не было
 * НАСТОЯЩЕГО контакта. Раньше таких счётчиков было пять, и каждый считал по-своему
 * (по `lastContactAt`, который двигает любая заметка агента и который при создании
 * карточки равен «сейчас»; по `firstContactAt`; «горячие» по скорингу). Теперь
 * правило одно, и сервер, и экран берут его отсюда.
 *
 * КОНТАКТ — это только:
 *   • звонок, где клиент реально взял трубку и состоялся разговор
 *     (Interaction CALL: callAttempt = TALKED или записана длительность разговора);
 *   • сообщение клиента в любом чате — агенту или боту (Client.lastClientMessageAt).
 * Заметки, задачи, ручные записи агента и исходящие сообщения контактом НЕ являются.
 *
 * НОВАЯ КАРТОЧКА без единого контакта считается «без контакта» с момента создания:
 * точка отсчёта — createdAt, а не lastContactAt (тот при создании равен «сейчас»).
 */

/** Сколько суток без настоящего контакта — уже «без контакта». */
export const NO_CONTACT_AFTER_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Граница: контакт раньше этого момента уже не считается свежим. */
export function noContactCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - NO_CONTACT_AFTER_DAYS * DAY_MS);
}

type When = Date | string | null | undefined;

export interface ClientContactFacts {
  /** Когда карточка заведена — точка отсчёта, если контакта не было вовсе. */
  createdAt: Date | string;
  /** Последнее сообщение САМОГО клиента в любом чате (агенту или боту). */
  lastClientMessageAt?: When;
  /** Последний звонок, где клиент реально разговаривал (TALKED / длительность > 0). */
  lastTalkedCallAt?: When;
}

const ms = (d: When): number | null => (d ? new Date(d).getTime() : null);

/** Момент последнего настоящего контакта; null — контакта не было ни разу. */
export function lastRealContactTime(f: ClientContactFacts): Date | null {
  const t = Math.max(ms(f.lastClientMessageAt) ?? -Infinity, ms(f.lastTalkedCallAt) ?? -Infinity);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Клиент «без контакта»: настоящего контакта (или, без него, создания карточки) не было дольше порога. */
export function isWithoutContact(f: ClientContactFacts, now: Date = new Date()): boolean {
  const since = lastRealContactTime(f) ?? new Date(f.createdAt);
  return since.getTime() < noContactCutoff(now).getTime();
}
