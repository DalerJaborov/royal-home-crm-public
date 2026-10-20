-- Автоматическая карточка по входящему звонку: оператор говорит, а лид заводит CRM.
-- autoLeadAt — замок идемпотентности (разбор приходит отложенно и может прийти дважды),
-- autoLeadStatus — чем кончилось, чтобы «Без разбора» отличал «ИИ не справился» от
-- «до звонка ещё не дошли руки».
ALTER TABLE "IncomingCall" ADD COLUMN     "autoLeadAt" TIMESTAMP(3),
ADD COLUMN     "autoLeadStatus" TEXT;

CREATE INDEX "IncomingCall_autoLeadAt_answered_startedAt_idx" ON "IncomingCall"("autoLeadAt", "answered", "startedAt");
