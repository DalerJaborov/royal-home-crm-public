// СТОРОЖ «TELEGRAM НЕ ДОСТАВЛЯЕТ В CRM» (15.11.2026, В4 владельца, ревью #198: сверка
// «не дошло до CRM» нужна и для Telegram).
//
// Список входящих бота у Telegram не прочитать: обновления отдаются один раз — вебхуком
// (CRM работает на нём, routes/webhooks.ts) или getUpdates, который при вебхуке не
// работает. Зато Telegram сам говорит, как идёт доставка: getWebhookInfo
// (core.telegram.org/bots/api#getwebhookinfo) — адрес вебхука, `pending_update_count`
// («Number of updates awaiting delivery») и `last_error_date`/`last_error_message`
// («Unix time for the most recent error that happened when trying to deliver an update
// via webhook»). Раз в 10 минут, только чтение:
//  - вебхук не установлен — сообщения бота до CRM не доходят вовсе;
//  - свежая ошибка доставки (за 30 минут) — Telegram не смог отдать сообщение CRM;
//  - очередь копится два тика подряд — CRM не принимает сообщения.
// Тревога руководству в «Здоровье системы» (не пуш сотрудникам: кому отвечать, неизвестно),
// не чаще раза в 6 часов на причину. Рубильник Settings.telegramDeliveryWatchEnabled.
import { prisma } from "../db.js";
import { getWebhookInfo, isTelegramEnabled, type TelegramWebhookInfo } from "../telegram/api.js";
import { logSystemError } from "./systemError.js";

export const TELEGRAM_ERROR_FRESH_MS = 30 * 60_000;
export const TELEGRAM_PENDING_ALARM = 5;
const ALARM_WINDOW_MS = 6 * 60 * 60_000;

/** Очередь в прошлый тик: тревога только если она держится два тика подряд (разовый всплеск — норма). */
let previousPending = 0;

export function resetTelegramDeliveryWatchForTests(): void {
  previousPending = 0;
}

/** Что не так с доставкой. Чистая функция: null — всё в порядке. */
export function telegramDeliveryProblem(info: TelegramWebhookInfo, now: Date, pendingBefore: number): { key: string; text: string } | null {
  if (!info.url) return { key: "no-webhook", text: "у бота Telegram не установлен вебхук — сообщения клиентов в Telegram до CRM не доходят" };
  const errorAt = info.last_error_date ? info.last_error_date * 1000 : 0;
  if (errorAt && now.getTime() - errorAt <= TELEGRAM_ERROR_FRESH_MS) {
    const why = (info.last_error_message ?? "без описания").slice(0, 200);
    return { key: "delivery-error", text: `Telegram не смог доставить сообщение в CRM (${why})` };
  }
  const pending = info.pending_update_count ?? 0;
  if (pending >= TELEGRAM_PENDING_ALARM && pendingBefore >= TELEGRAM_PENDING_ALARM) {
    return { key: "queue", text: `в очереди Telegram ${pending} сообщений, которые CRM не приняла` };
  }
  return null;
}

export interface TelegramDeliveryWatchResult {
  skipped: "off" | "not_configured" | "read_failed" | null;
  alarmed: boolean;
}

export async function runTelegramDeliveryWatch(now: Date = new Date(),
  read: () => Promise<TelegramWebhookInfo> = getWebhookInfo): Promise<TelegramDeliveryWatchResult> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDeliveryWatchEnabled: true } });
  if (!(s?.telegramDeliveryWatchEnabled ?? true)) return { skipped: "off", alarmed: false };
  if (!isTelegramEnabled()) return { skipped: "not_configured", alarmed: false };
  let info: TelegramWebhookInfo;
  try {
    info = await read();
  } catch {
    // Сбой самого запроса — не тревога о доставке: о недоступности Telegram и ключе бота говорят свои сторожа (api.ts).
    return { skipped: "read_failed", alarmed: false };
  }
  const problem = telegramDeliveryProblem(info, now, previousPending);
  previousPending = info.pending_update_count ?? 0;
  if (!problem) return { skipped: null, alarmed: false };
  void logSystemError("telegram", `Telegram → CRM: ${problem.text}. Клиенты могут писать боту, а CRM их не видит.`,
    { dedupKey: `telegram-delivery:${problem.key}`, dedupWindowMs: ALARM_WINDOW_MS });
  return { skipped: null, alarmed: true };
}
