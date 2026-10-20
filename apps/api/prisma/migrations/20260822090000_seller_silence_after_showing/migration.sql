-- AlterTable
-- Антифрод «Контроля руководителя» (мозговой штурм владельца 20-21.08.2026, часть
-- «Красные флаги»): порог тишины после проведённого показа — сколько дней без
-- единого касания через CRM (звонок/сообщение) после показа считать тревожным
-- сигналом. См. Settings.sellerSilenceAfterShowingDays и routes/oversight.ts.
ALTER TABLE "Settings" ADD COLUMN     "sellerSilenceAfterShowingDays" INTEGER NOT NULL DEFAULT 7;
