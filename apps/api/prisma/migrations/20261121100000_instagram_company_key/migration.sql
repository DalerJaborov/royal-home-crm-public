-- Instagram через постоянный ключ Meta (владелец 21.11.2026: «Да, переводи»). Только новые колонки, данные не трогаем.
-- Рубильник реестра «Автоматика ИИ и напоминания»: ВКЛ, но путь через Страницу берётся только у аккаунта,
-- прошедшего проверку (ключ компании, права, Страница с этим же Instagram); иначе остаётся личный маркер.
ALTER TABLE "Settings" ADD COLUMN "instagramCompanyKeyEnabled" BOOLEAN NOT NULL DEFAULT true;
-- Meta закрыла доступ к аккаунту (проверка безопасности Instagram, блокировка): одна запись и одна тревога на случай,
-- проверки здоровья такой аккаунт не дёргают. Снимается само при первом успешном вызове или новом маркере.
ALTER TABLE "MessengerAccount" ADD COLUMN "accessLostAt" TIMESTAMP(3);
ALTER TABLE "MessengerAccount" ADD COLUMN "accessLostReason" TEXT;
