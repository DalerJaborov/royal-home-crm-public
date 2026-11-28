-- БОТ ДОГОНЯЕТ ПОСЛЕ ПАУЗЫ (27.11.2026, владелец: «чтобы бот сам догонял ... чтобы мы даже не заметили»).
--
-- Ход ядра живёт от времени получения сообщения: 120 секунд на ответ, 15 минут жизни подписанного входа.
-- Сообщение, пришедшее, пока сотрудник поставил бота на паузу, ядро удерживало (HELD), и после паузы
-- ответить на него было уже нельзя. "resumedAt" — время, с которого ОДИН РАЗ отсчитывается новый ход
-- того же сообщения (lib/customerTurnCatchUp.ts ставит его CAS-ом). Подлинность входа по-прежнему
-- сверяется по исходному "receivedAt"; меняются только часы хода.
--
-- Только добавляет: колонку, проверку и рубильник. Данные не меняются.

ALTER TABLE "Settings" ADD COLUMN "botCatchUpEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "CustomerPropertyIngressTicket" ADD COLUMN "resumedAt" TIMESTAMP(3);

-- Возобновить можно не раньше получения и не позже суток после него (окно Meta на ответ — 24 часа).
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerIngress_resumed_check" CHECK (
  "resumedAt" IS NULL OR ("resumedAt" >= "receivedAt" AND "resumedAt" <= "receivedAt" + interval '24 hours')
);

-- Срок хода считается от часов хода: COALESCE("resumedAt","receivedAt"). Для невозобновлённых билетов —
-- ровно прежнее правило.
ALTER TABLE "CustomerPropertyIngressTicket" DROP CONSTRAINT "CustomerIngress_agent_pin_check";
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerIngress_agent_pin_check" CHECK (
  ("agentRevisionId" IS NULL AND "providerOperationId" IS NULL AND "providerDeadlineAt" IS NULL)
  OR
  ("agentRevisionId" IS NOT NULL AND "providerOperationId" IS NOT NULL AND "providerDeadlineAt" IS NOT NULL
    AND "agentRevisionId" ~ '^[a-f0-9]{64}$'
    AND "providerOperationId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "originVersion" IS NOT NULL AND "originVersion"=1
    AND "originCiphertext" IS NOT NULL AND "inputRecordedAt" IS NOT NULL
    AND "payloadVersion" IS NOT NULL AND "payloadVersion"=1
    AND "providerDeadlineAt">"receivedAt"
    AND "providerDeadlineAt"<=COALESCE("resumedAt","receivedAt")+interval '15 minutes')
);

-- Возобновление — один раз и только у удержанного хода без закреплённой модели: пин хода не продлевается никогда
-- (customer_agent_ticket_pin_immutable), а второй "resumedAt" дал бы второй ответ на то же сообщение.
CREATE FUNCTION customer_ticket_resume_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."resumedAt" IS DISTINCT FROM OLD."resumedAt" THEN
    IF OLD."resumedAt" IS NOT NULL OR NEW."resumedAt" IS NULL OR OLD."agentRevisionId" IS NOT NULL
       OR NEW."agentRevisionId" IS NOT NULL OR OLD."processingState" IS DISTINCT FROM 'HELD'
       OR OLD."originVersion" IS DISTINCT FROM 1 OR OLD."tombstonedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'customer turn can be resumed once, only while held and unpinned';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_ticket_resume_once BEFORE UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_ticket_resume_once();
