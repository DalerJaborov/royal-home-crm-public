-- «Сайт и поиск»: подключение Google Search Console кнопкой в CRM.
ALTER TABLE "Settings" ADD COLUMN "searchConsoleRefreshToken" TEXT;
ALTER TABLE "Settings" ADD COLUMN "searchConsoleSiteUrl" TEXT;
ALTER TABLE "Settings" ADD COLUMN "searchConsoleConnectedAt" TIMESTAMP(3);
