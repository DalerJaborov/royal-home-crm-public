-- 13.09.2026, задача «экспорт переписки + версия промта» (владелец: если клиент
-- жалуется, что бот сказал что-то не то, — сейчас нельзя узнать, каким текстом
-- промта бот отвечал в конкретный момент). Минимальное версионирование: строка
-- версии рядом с промтом (SYSTEM_PROMPT_VERSION в ai/assistant.ts,
-- LIVE_VOICE_PROMPT_VERSION в ai/liveVoicePersona.ts), обновляется вручную при
-- значимой правке текста — ничего автоматического.
--
-- Оба поля nullable и без DEFAULT: старые записи (AiLog и LiveVoiceSession) не
-- знают, каким промтом отвечали, — врать им подставленной версией не нужно,
-- честное «нет данных» лучше выдуманной.
--
-- Живой голос НЕ пишется в AiLog вовсе (нет учёта токенов/стоимости Live-сессии,
-- см. ai/liveVoiceClient.ts) — версия его промта хранится прямо на записи звонка
-- (LiveVoiceSession), а не в общем журнале ИИ.

-- AlterTable
ALTER TABLE "AiLog" ADD COLUMN "promptVersion" TEXT;

-- AlterTable
ALTER TABLE "LiveVoiceSession" ADD COLUMN "promptVersion" TEXT;
