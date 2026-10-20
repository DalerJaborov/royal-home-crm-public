-- Наблюдатели монтажа: копии передач монтажёру в Telegram админа.
ALTER TABLE "Agent" ADD COLUMN "montageCopiesTelegram" BOOLEAN NOT NULL DEFAULT false;
