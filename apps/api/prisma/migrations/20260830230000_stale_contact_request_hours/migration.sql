-- Detector "номер запрошен — заглохло" (mission-control phase 2, п.1а жалобы 31.08.2026):
-- порог часов, после которых диалог без привязанного клиента и с последним
-- сообщением бота-запросом номера попадает в «первую линию» дашборда.
ALTER TABLE "Settings" ADD COLUMN "staleContactRequestHours" INTEGER NOT NULL DEFAULT 18;
