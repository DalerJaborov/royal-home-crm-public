-- Соавторы Instagram Reels (26.09.2026): до 3 ников по умолчанию (Settings) + ник
-- агента для авто-подстановки хозяином объекта (Agent). Оба поля NULL по умолчанию —
-- публикация без соавторов продолжает идти ровно как сегодня.
ALTER TABLE "Settings" ADD COLUMN "instagramCollaborators" TEXT;
ALTER TABLE "Agent" ADD COLUMN "instagramUsername" TEXT;
