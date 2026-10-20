-- Ключи входа по отпечатку и лицу (passkeys, WebAuthn).
--
-- Хранится только ОТКРЫТАЯ часть ключа: ею нельзя войти, она годится лишь для
-- проверки подписи. Биометрия остаётся внутри устройства и на сервер не попадает.
--
-- Миграция написана руками, а не через `prisma migrate diff`: diff на этой базе
-- дополнительно предлагает удалить поисковые индексы Client_fullName_trgm_idx,
-- Property_title_trgm_idx и Property_address_trgm_idx — они созданы отдельной
-- миграцией сырым SQL и в схеме Prisma не описаны, поэтому он считает их лишними.
-- Выполнение такого diff молча сломало бы поиск по клиентам и объектам.
CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "deviceName" TEXT,
    "transports" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Passkey_credentialId_key" ON "Passkey"("credentialId");
CREATE INDEX "Passkey_agentId_idx" ON "Passkey"("agentId");

-- Удаление сотрудника уносит его ключи: без учётки они бессмысленны.
ALTER TABLE "Passkey" ADD CONSTRAINT "Passkey_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
