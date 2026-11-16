# 16.11.2026 — Сторож «Telegram не доставляет» понимает long polling

- Что изменилось: режим получения сообщений Telegram определяется в одном месте — `telegramUpdatesMode()` в `telegram/updatesMode.ts` (задан `TELEGRAM_WEBHOOK_SECRET` — вебхук, нет — long polling). По нему решают поллер, `index.ts` и сторож `lib/telegramDeliveryWatch.ts`. При polling пустой адрес вебхука больше не тревога; установленный вебхук при polling — тревога (`webhook-blocks-polling`: Telegram тогда не отдаёт getUpdates). Очередь апдейтов проверяется в обоих режимах.
- Почему: после выката #198 (16.11 02:35 UTC) сторож каждые 6 часов писал руководству «у бота Telegram не установлен вебхук», хотя прод работает на long polling (лог: «Бот запущен (long polling)») — ложная тревога.
- Чем проверено: `tests/bot-always-v2-watch.test.ts` — оба режима и переключение по `TELEGRAM_WEBHOOK_SECRET`; `tsc --noEmit` API чисто.
- Что осталось: ничего; рубильник `telegramDeliveryWatchEnabled` остаётся включённым.
- 16.11: в «агент уточнит» (follow_up) вернулась подсказка Telegram Direct «из CRM в эту переписку ответить нельзя» — потерялась при своде #201 с #198.
