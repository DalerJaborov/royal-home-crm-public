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
 * ПОРОГ — ЯВНО (16.11.2026, решение после ревью):
 *   • карточка, с которой НЕ БЫЛО ни одного настоящего контакта, — «без контакта»
 *     СРАЗУ, с момента создания: ждать сутки, чтобы увидеть новую заявку, до
 *     которой никто не дозвонился, незачем;
 *   • карточка, с которой контакт был, — «без контакта», когда с ПОСЛЕДНЕГО
 *     настоящего контакта прошло больше {@link NO_CONTACT_AFTER_DAYS} суток.
 * `lastContactAt` не читается вовсе (его двигают заметки, а при создании он «сейчас»).
 */

/** Сколько суток после последнего настоящего контакта — уже «без контакта». */
export const NO_CONTACT_AFTER_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Граница: контакт раньше этого момента уже не считается свежим. `days` — для
 *  других порогов того же правила (рассылка «вернуть клиента», пауза бота). */
export function noContactCutoff(now: Date = new Date(), days: number = NO_CONTACT_AFTER_DAYS): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

type When = Date | string | null | undefined;

export interface ClientContactFacts {
  /** Когда карточка заведена (для экрана: «контакта не было, карточка N дней»). */
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

/**
 * Клиент «без контакта»: настоящего контакта не было ни разу (сразу) или последний
 * был раньше порога `days` суток.
 */
export function isWithoutContact(f: ClientContactFacts, now: Date = new Date(), days: number = NO_CONTACT_AFTER_DAYS): boolean {
  const last = lastRealContactTime(f);
  if (!last) return true;
  return last.getTime() < noContactCutoff(now, days).getTime();
}
