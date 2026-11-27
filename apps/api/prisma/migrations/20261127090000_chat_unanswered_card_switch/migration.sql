-- Рубильник «Клиент в WhatsApp без ответа бота: карточка сама» (27.11.2026, переписки 26.11 без карточки).
-- Только добавляет колонку. ВКЛ по умолчанию: новая автоматика работает сразу после выката, выключает человек.
ALTER TABLE "Settings" ADD COLUMN "chatUnansweredCardEnabled" BOOLEAN NOT NULL DEFAULT true;
