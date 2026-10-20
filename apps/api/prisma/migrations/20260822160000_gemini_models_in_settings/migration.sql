-- AlterTable
-- Имена моделей Gemini переезжают из .env на сервере в Настройки CRM.
-- Причина: Google закрыл две модели за месяц (gemini-2.5-flash 02.08 и
-- gemini-2.5-pro 22.08.2026), каждый раз молча, с HTTP 404 на каждый вызов,
-- и каждый раз бот работал на резервной модели до тех пор, пока кто-то не
-- заходил на сервер по SSH. Имя модели — расходник, а не архитектура.
--
-- NULL и пустой список означают «настройка не заполнена»: работает прежнее
-- правило `.env || дефолт из кода` (ai/geminiTransport.ts). Поэтому колонки
-- nullable и с пустым умолчанием — существующая установка не меняет поведения.
ALTER TABLE "Settings" ADD COLUMN     "geminiModel" TEXT;
ALTER TABLE "Settings" ADD COLUMN     "geminiFallbackModels" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Settings" ADD COLUMN     "geminiTranscribeModels" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Settings" ADD COLUMN     "geminiImageModel" TEXT;

-- Дешёвая ступень для простых задач (классификация, извлечение полей). NULL —
-- простые задачи идут обычной моделью диалогов, то есть поведение не меняется.
ALTER TABLE "Settings" ADD COLUMN     "geminiLiteModel" TEXT;
