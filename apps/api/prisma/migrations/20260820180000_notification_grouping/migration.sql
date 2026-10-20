-- Схлопывание повторных уведомлений от одного повода в одну строку с
-- счётчиком (владелец 20.08.2026) — тот же tag, что уже схлопывает push-баннер
-- на устройстве, теперь применяется и к самой ленте. Обе колонки с безопасным
-- умолчанием: старые строки остаются "count=1, tag=null" и продолжают
-- показываться как раньше, пока не встретят повторное событие с тем же tag.
ALTER TABLE "Notification" ADD COLUMN "tag" TEXT;
ALTER TABLE "Notification" ADD COLUMN "count" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "Notification_agentId_tag_idx" ON "Notification"("agentId", "tag");
