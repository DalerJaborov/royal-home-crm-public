/**
 * КАК CRM ПОЛУЧАЕТ СООБЩЕНИЯ TELEGRAM — ОДНО МЕСТО (16.11.2026). Задан TELEGRAM_WEBHOOK_SECRET —
 * вебхук (routes/webhooks.ts), нет — long polling (telegram/poller.ts). По этому же признаку
 * поллер и index.ts решают, кто принимает апдейты, а сторож доставки (lib/telegramDeliveryWatch.ts) —
 * чего ждать от getWebhookInfo: при polling пустой адрес вебхука — норма, а не авария.
 * Отдельный модуль без зависимостей: тесты, подменяющие telegram/api.ts, его не задевают.
 */
export function telegramUpdatesMode(): "webhook" | "polling" {
  return process.env.TELEGRAM_WEBHOOK_SECRET ? "webhook" : "polling";
}
