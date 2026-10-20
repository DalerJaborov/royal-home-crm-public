-- Свой эталон обложки для ChatGPT в Настройках (владелец 29.09.2026).
ALTER TABLE "Settings" ADD COLUMN "coverReferenceSquareUrl" TEXT;
ALTER TABLE "Settings" ADD COLUMN "coverReferenceStoryUrl" TEXT;
-- Владелец 29.09: «пусть ChatGPT сам делает всё — и текст, и картинку, по нашему референсу».
UPDATE "Settings" SET "coverProvider" = 'OPENAI', "openaiTextMode" = 'MODEL';
