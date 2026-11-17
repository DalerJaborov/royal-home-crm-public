-- Живая фраза бота по-таджикски (#180). ВЫКЛЮЧЕНО по умолчанию: таджикские фразы ещё не
-- слушал носитель языка (17.11.2026); включает владелец на экране «Бот».
ALTER TABLE "Settings" ADD COLUMN "botSayTajik" BOOLEAN NOT NULL DEFAULT false;
