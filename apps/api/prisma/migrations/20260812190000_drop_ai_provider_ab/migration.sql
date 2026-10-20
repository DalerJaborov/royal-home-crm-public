-- Сравнение поставщиков ИИ закончено (решение владельца 12.08.2026 — Gemini).
-- Удаляются пометка поставщика у диалога и рубильник сравнения: механизм вырезан
-- из кода целиком, оставлять колонки значит хранить данные, которые никто уже не
-- прочитает, и снова наткнуться на них через полгода как на загадку.
ALTER TABLE "BotConversation" DROP COLUMN IF EXISTS "aiProvider";
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "aiProviderTestEnabled";

-- Настройки, которые не читала ни одна строка кода:
--  defaultCommissionPercent — заменена тройкой долей (интейкер/риелтор/компания);
--  offHoursMessage — остаток режима «вне рабочих часов», отменённого 31.07.2026:
--    бот отвечает круглосуточно, эту фразу с тех пор никто не отправлял.
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "defaultCommissionPercent";
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "offHoursMessage";
