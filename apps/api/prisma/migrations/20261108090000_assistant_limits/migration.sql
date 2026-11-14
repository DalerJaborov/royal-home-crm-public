-- Шаги и срок одного ответа помощницы — рубильниками (решение владельца 07.11.2026: 6 → 30 шагов,
-- 35 → 120 с). Аддитивно: две колонки со значениями по умолчанию, существующие строки не меняются.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "aiAssistantMaxRounds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Settings" ADD COLUMN "aiAssistantDeadlineSec" INTEGER NOT NULL DEFAULT 120;
