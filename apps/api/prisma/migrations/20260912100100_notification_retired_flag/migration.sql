-- Точная пометка «Передан» в ленте уведомлений (Пачка 19, 12.09.2026).
--
-- До этой миграции фронт красил «Передан» эвристикой (kind==="lead" && read
-- && url на карточку клиента, apps/web/src/lib/notificationTransferHint.ts) —
-- лид, который агент честно принял и прочитал сам, тоже подходил под условие.
-- closeNotifications (lib/notifications.ts) теперь ставит retiredAt/retiredReason
-- явно, когда гасит строку из-за смены владельца/статуса клиента, а не когда
-- агент сам открыл ленту — обычное "прочитал" оставляет retiredAt пустым.
ALTER TABLE "Notification" ADD COLUMN "retiredAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "retiredReason" TEXT;
