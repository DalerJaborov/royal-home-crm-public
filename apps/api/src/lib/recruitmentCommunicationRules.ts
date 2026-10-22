/**
 * Чистые правила обращений к кандидатам (без БД и сети) — вынесены, чтобы их
 * проверять тестами без Postgres и не плодить круговых импортов.
 */

/** Ошибка, которую сервис отдаёт сотруднику как понятный 4xx (не 503). */
export class RecruitmentCommunicationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function held(message: string): never { throw new RecruitmentCommunicationError(409, message); }

/** Верхний предел текста СМС: длиннее — это уже 9+ сегментов. */
export const SMS_MAX_LENGTH = 600;

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""));
const GSM_EXTENDED = new Set("^{}\\[~]|€".split(""));

/** Сегменты СМС: кириллица/таджикские буквы — UCS-2 (70 знаков, в составной 67). */
export function smsSegments(text: string): number {
  if (!text) return 0;
  const chars = [...text];
  const gsm = chars.every(ch => GSM_BASIC.has(ch) || GSM_EXTENDED.has(ch));
  if (gsm) {
    const length = chars.reduce((sum, ch) => sum + (GSM_EXTENDED.has(ch) ? 2 : 1), 0);
    return length <= 160 ? 1 : Math.ceil(length / 153);
  }
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}

/** Бросает понятный отказ, если текст СМС слишком длинный. */
export function assertSmsLength(text: string): void {
  if (text.length > SMS_MAX_LENGTH) held(`СМС слишком длинное (${text.length} знаков, максимум ${SMS_MAX_LENGTH}) — сократите адрес или подготовку`);
}

/** Результат моста звонка (подмножество LiveVoiceClientCallResult). */
export interface BridgeCallResult { ok: boolean; busy?: boolean; notDialed?: boolean; error?: string; channelId?: string }

/**
 * Мост отказал. Если он сам подтверждает «до набора» (notDialed) — звонка точно
 * нет, кандидата блокировать нельзя: REJECTED. Любая неопределённость остаётся
 * UNKNOWN (повтор запрещён, чтобы не позвонить дважды).
 */
export function bridgeRefusalStatus(result: BridgeCallResult): "REJECTED" | "UNKNOWN" {
  return result.notDialed === true ? "REJECTED" : "UNKNOWN";
}

const UNKNOWN_SOFT_MS = 30 * 60_000;
const UNKNOWN_HARD_MS = 24 * 60 * 60_000;
export interface DeliveryLike { status: string; channel: string; providerReceipt: string | null; updatedAt?: Date | null }

/**
 * Блокирует ли строка новое обращение. UNKNOWN без признаков набора (нет
 * квитанции провайдера/канала) старше 30 минут больше не блокирует; любой
 * UNKNOWN старше суток — тоже, иначе кандидат застрял бы навсегда.
 * SQL-версия — unresolvedDeliverySql() в recruitmentCommunications.ts: держать в паре.
 */
export function isUnresolvedDelivery(row: DeliveryLike, now = new Date()): boolean {
  if (["QUEUED", "IN_FLIGHT"].includes(row.status) || row.channel === "ASSISTANT_CALL" && row.status === "ACCEPTED") return true;
  if (row.status !== "UNKNOWN") return false;
  const age = row.updatedAt ? now.getTime() - new Date(row.updatedAt).getTime() : 0;
  if (age >= UNKNOWN_HARD_MS) return false;
  return !(row.providerReceipt === null && age >= UNKNOWN_SOFT_MS);
}
export const UNKNOWN_SOFT_MINUTES = UNKNOWN_SOFT_MS / 60_000;
export const UNKNOWN_HARD_HOURS = UNKNOWN_HARD_MS / 3_600_000;

/** Есть ли до собеседования хотя бы одно окно для звонков (шаг 30 минут). */
export function hasCallWindowBefore(from: Date, to: Date, isWithin: (at: Date) => boolean): boolean {
  const step = 30 * 60_000, horizon = Math.min(to.getTime(), from.getTime() + 30 * 24 * 60 * 60_000);
  for (let at = from.getTime(); at < horizon; at += step) if (isWithin(new Date(at))) return true;
  return to.getTime() > from.getTime() + 30 * 24 * 60 * 60_000;
}
