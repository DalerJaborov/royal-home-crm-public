-- Обложки ChatGPT v2 (25.09.2026): квадрат и вертикаль генерируются каждая по своему эталону,
-- на картинку 1-2 кандидатки. Квадрат из вертикали больше не вырезается — флаг не нужен.
ALTER TABLE "Settings" DROP COLUMN "openaiSquareSeparate";
ALTER TABLE "Settings" ADD COLUMN "openaiCandidates" INTEGER NOT NULL DEFAULT 2;
