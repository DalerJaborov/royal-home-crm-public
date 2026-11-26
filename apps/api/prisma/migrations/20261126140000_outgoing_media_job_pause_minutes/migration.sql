-- Срок паузы бота, выбранный сотрудником при отправке фото/видео (26.11.2026). Пусто — умолчание сервера.
ALTER TABLE "OutgoingMediaJob" ADD COLUMN "pauseMinutes" INTEGER;
