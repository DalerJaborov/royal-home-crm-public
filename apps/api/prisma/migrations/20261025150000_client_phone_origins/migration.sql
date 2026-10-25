CREATE TABLE "ClientPhoneOrigin" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "phoneHash" TEXT NOT NULL,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "sourceId" TEXT,
  CONSTRAINT "ClientPhoneOrigin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientPhoneOrigin_clientId_phoneHash_key" ON "ClientPhoneOrigin"("clientId", "phoneHash");
ALTER TABLE "ClientPhoneOrigin" ADD CONSTRAINT "ClientPhoneOrigin_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No historical backfill: old numbers have no invented addition timestamp.
-- Full digits, not the nine-digit matching tail, distinguish international contacts.
CREATE FUNCTION record_client_extra_phone_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE digits text; prior_digits text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT ARRAY(SELECT regexp_replace(p, '[^0-9]', '', 'g') FROM unnest(COALESCE(OLD."extraPhones", ARRAY[]::text[])) AS p) INTO prior_digits;
  ELSE
    prior_digits := ARRAY[]::text[];
  END IF;
  FOR digits IN SELECT DISTINCT regexp_replace(p, '[^0-9]', '', 'g') FROM unnest(COALESCE(NEW."extraPhones", ARRAY[]::text[])) AS p LOOP
    IF digits <> '' AND NOT (digits = ANY(prior_digits)) THEN
      INSERT INTO "ClientPhoneOrigin" ("id", "clientId", "phoneHash", "addedAt", "source")
      VALUES (gen_random_uuid()::text, NEW."id", md5(digits), CURRENT_TIMESTAMP, 'UNKNOWN')
      ON CONFLICT ("clientId", "phoneHash") DO UPDATE SET "addedAt" = EXCLUDED."addedAt", "source" = 'UNKNOWN', "sourceId" = NULL;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_extra_phone_origin AFTER INSERT OR UPDATE OF "extraPhones" ON "Client"
FOR EACH ROW EXECUTE FUNCTION record_client_extra_phone_origin();
