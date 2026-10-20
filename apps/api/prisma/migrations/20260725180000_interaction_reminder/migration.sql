-- Отметка об отправленном напоминании «встреча через час»: без неё push уходил бы
-- на каждом тике джоба, пока не наступит время встречи.
-- Отдельный индекс не нужен: джоб отбирает задачи по nextActionDate, а он уже
-- проиндексирован (@@index([nextActionDate]) в модели Interaction).
ALTER TABLE "Interaction" ADD COLUMN "reminderSentAt" TIMESTAMP(3);
