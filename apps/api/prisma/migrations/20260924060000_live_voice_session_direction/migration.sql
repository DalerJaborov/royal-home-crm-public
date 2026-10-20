-- Консультант на входящих (24.09.2026): кто кому звонит, номер звонящего и досье.
ALTER TABLE "LiveVoiceSession" ADD COLUMN "direction" TEXT;
ALTER TABLE "LiveVoiceSession" ADD COLUMN "callerNumber" TEXT;
ALTER TABLE "LiveVoiceSession" ADD COLUMN "contactProfileId" TEXT;
