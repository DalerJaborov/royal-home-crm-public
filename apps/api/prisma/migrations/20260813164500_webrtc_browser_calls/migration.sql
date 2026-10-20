-- Звонки прямо в браузере CRM: адрес соединения со станцией, передатчик звука
-- и браузерный SIP-аккаунт сотрудника.
ALTER TABLE "Settings" ADD COLUMN     "asteriskWebrtcWsUrl" TEXT,
ADD COLUMN     "asteriskWebrtcTurnUrl" TEXT,
ADD COLUMN     "asteriskWebrtcTurnUser" TEXT,
ADD COLUMN     "asteriskWebrtcTurnPassword" TEXT;

ALTER TABLE "Agent" ADD COLUMN     "webrtcUser" TEXT,
ADD COLUMN     "webrtcPassword" TEXT;

CREATE UNIQUE INDEX "Agent_webrtcUser_key" ON "Agent"("webrtcUser");
