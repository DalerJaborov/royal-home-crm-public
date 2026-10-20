-- Анкета кандидата привязывается к ЧЕЛОВЕКУ, а не только к разговору.
--
-- До этого анкета жила одним диалогом (conversationId @unique): кандидат,
-- написавший сперва в Instagram, а потом в WhatsApp, заводил вторую анкету,
-- а бот заново спрашивал возраст и опыт. Досье (ContactProfile) есть у каждого
-- написавшего с первого сообщения, поэтому связь ведём прежде всего с ним;
-- clientId добавлен для экрана руководства, где анкеты сводятся с обращениями.
--
-- Обе колонки необязательные и добавляются пустыми: старые анкеты остаются
-- рабочими, связь у них проставит обратная засыпка по conversationId.
ALTER TABLE "JobApplication" ADD COLUMN "contactProfileId" TEXT;
ALTER TABLE "JobApplication" ADD COLUMN "clientId" TEXT;

CREATE INDEX "JobApplication_contactProfileId_idx" ON "JobApplication"("contactProfileId");
CREATE INDEX "JobApplication_clientId_idx" ON "JobApplication"("clientId");

-- ON DELETE SET NULL: удалили досье или карточку клиента — анкета остаётся
-- в очереди руководства, а не исчезает вместе с ними.
ALTER TABLE "JobApplication"
  ADD CONSTRAINT "JobApplication_contactProfileId_fkey"
  FOREIGN KEY ("contactProfileId") REFERENCES "ContactProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobApplication"
  ADD CONSTRAINT "JobApplication_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Обратная засыпка связи у уже собранных анкет: диалог знает своё досье.
UPDATE "JobApplication" a
   SET "contactProfileId" = c."contactProfileId"
  FROM "BotConversation" c
 WHERE a."conversationId" = c."id" AND c."contactProfileId" IS NOT NULL;

UPDATE "JobApplication" a
   SET "contactProfileId" = c."contactProfileId"
  FROM "TelegramConversation" c
 WHERE a."conversationId" = c."id" AND c."contactProfileId" IS NOT NULL;

UPDATE "JobApplication" a
   SET "contactProfileId" = c."contactProfileId"
  FROM "TelegramDirectConversation" c
 WHERE a."conversationId" = c."id" AND c."contactProfileId" IS NOT NULL;

-- Клиент — через досье: другой связи между анкетой и карточкой не существует.
UPDATE "JobApplication" a
   SET "clientId" = p."clientId"
  FROM "ContactProfile" p
 WHERE a."contactProfileId" = p."id" AND p."clientId" IS NOT NULL;
