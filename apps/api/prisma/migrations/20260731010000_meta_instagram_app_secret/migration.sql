-- Секрет приложения Instagram. У входа через Instagram отдельное приложение со
-- своим секретом, и вебхуки Instagram подписаны им, а не секретом приложения
-- Facebook — с одним секретом входящие из Instagram не проходили проверку подписи.

ALTER TABLE "Settings" ADD COLUMN "metaIgAppSecret" TEXT;
