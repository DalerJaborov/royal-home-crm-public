-- Консультант на телефоне берёт настоящие входящие (24.09.2026, робозвонок, правка 5).
ALTER TABLE "Settings" ADD COLUMN "liveVoiceInboundMode" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Settings" ADD COLUMN "liveVoiceInboundWaitSeconds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "IncomingCall" ADD COLUMN "answeredByConsultant" BOOLEAN NOT NULL DEFAULT false;
