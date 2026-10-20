-- Кому консультант на телефоне переводит звонок без агента объекта и своего агента (24.09.2026).
ALTER TABLE "Settings" ADD COLUMN "liveVoiceTransferAgentId" TEXT;
