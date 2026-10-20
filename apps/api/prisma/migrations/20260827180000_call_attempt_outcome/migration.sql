-- Машиночитаемый исход дозвона: чем кончился звонок через CRM.
-- До этого «клиент не ответил» и «агент не снял трубку» различались только по
-- тексту notes, а на этом различии держится гейт перевода в Неактивные.
ALTER TABLE "Interaction" ADD COLUMN "callAttempt" TEXT;

-- Разметка задним числом по тексту, который писал callTracker.finishCall.
-- Одноразово: дальше значение ставит сам код при завершении звонка.
UPDATE "Interaction"
   SET "callAttempt" = 'TALKED'
 WHERE type = 'CALL' AND "callAttempt" IS NULL
   AND (notes LIKE 'Звонок через CRM, разговор %' OR "recordingDurationSec" > 0);

UPDATE "Interaction"
   SET "callAttempt" = 'NO_ANSWER'
 WHERE type = 'CALL' AND "callAttempt" IS NULL
   AND notes LIKE 'Звонок через CRM: клиент не ответил%';

UPDATE "Interaction"
   SET "callAttempt" = 'AGENT_NO_PICKUP'
 WHERE type = 'CALL' AND "callAttempt" IS NULL
   AND notes LIKE 'Звонок через CRM не состоялся: агент не снял трубку%';

UPDATE "Interaction"
   SET "callAttempt" = 'CANCELLED'
 WHERE type = 'CALL' AND "callAttempt" IS NULL
   AND notes LIKE 'Звонок через CRM отменён агентом%';

-- Гейт спрашивает «была ли попытка дозвониться до ЭТОГО клиента» — то есть
-- ходит по clientId и типу. Без индекса это seq scan по всей хронологии.
CREATE INDEX "Interaction_clientId_type_callAttempt_idx"
    ON "Interaction" ("clientId", type, "callAttempt");
