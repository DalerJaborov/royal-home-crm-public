-- ctwa_clid рекламы click-to-WhatsApp (04.10.2026) — только добавление необязательной
-- колонки. Хранится для будущей отдачи событий в Meta (Conversions API); сейчас
-- наружу не уходит.
ALTER TABLE "BotConversation" ADD COLUMN "adClickId" TEXT;
