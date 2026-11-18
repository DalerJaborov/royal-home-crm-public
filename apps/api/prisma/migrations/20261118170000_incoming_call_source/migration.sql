-- Откуда пришёл входящий звонок: обычная линия или WhatsApp через шлюз SIP (18.11.2026).
-- Только ADD COLUMN с DEFAULT: старые строки становятся "phone", блокировка таблицы короткая (PG 11+ не переписывает таблицу).
ALTER TABLE "IncomingCall" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'phone';
