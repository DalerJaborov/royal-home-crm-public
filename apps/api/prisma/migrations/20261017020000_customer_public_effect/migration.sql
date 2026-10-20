-- Independent public-source effects; never a customer/staff DM grant.
-- No FK cascade: deleting a source must not erase an uncertain send receipt.
CREATE TABLE "CustomerPublicEffect" (
  "id" text PRIMARY KEY, "sourceId" text NOT NULL, "sourceRevision" bigint NOT NULL,
  "sourceHash" text NOT NULL, "endpointScopeId" text NOT NULL, "policyRevision" bigint NOT NULL,
  "agentRevisionId" text NOT NULL, "authorKey" text NOT NULL, "dayKey" text NOT NULL,
  "kind" text NOT NULL, "category" text NOT NULL, "payloadEncrypted" text,
  "payloadHash" text NOT NULL, "status" text NOT NULL DEFAULT 'IN_FLIGHT',
  "providerId" text, "outcomeReason" text, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" timestamp(3),
  CONSTRAINT "CustomerPublicEffect_kind_check" CHECK ("kind" IN ('hide','delete','private_reply')),
  CONSTRAINT "CustomerPublicEffect_category_check" CHECK ("category" IN ('spam','abuse','agency_ad','seller_ad')),
  CONSTRAINT "CustomerPublicEffect_status_check" CHECK ("status" IN ('IN_FLIGHT','ACCEPTED','REFUSED','GONE','UNKNOWN','SUPPRESSED')),
  CONSTRAINT "CustomerPublicEffect_shape_check" CHECK (
    "sourceRevision">=0 AND "policyRevision">=0 AND "sourceHash" ~ '^[a-f0-9]{64}$'
    AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "authorKey" ~ '^[a-f0-9]{64}$'
    AND "agentRevisionId" ~ '^[a-f0-9]{64}$'
    AND ("kind"='private_reply')=("payloadEncrypted" IS NOT NULL)
    AND ("status"='IN_FLIGHT')=("finishedAt" IS NULL)
    AND ("providerId" IS NULL OR ("kind"='private_reply' AND "status"='ACCEPTED')))
);
CREATE UNIQUE INDEX "CustomerPublicEffect_source_kind" ON "CustomerPublicEffect"("sourceId","kind");
CREATE INDEX "CustomerPublicEffect_endpointScopeId_authorKey_createdAt_idx" ON "CustomerPublicEffect"("endpointScopeId","authorKey","createdAt");
CREATE UNIQUE INDEX "CustomerPublicEffect_one_dm_day" ON "CustomerPublicEffect"("endpointScopeId","authorKey","dayKey") WHERE "kind"='private_reply';
CREATE FUNCTION customer_public_effect_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW."id",NEW."sourceId",NEW."sourceRevision",NEW."sourceHash",NEW."endpointScopeId",NEW."policyRevision",NEW."agentRevisionId",NEW."authorKey",NEW."dayKey",NEW."kind",NEW."category",NEW."payloadEncrypted",NEW."payloadHash",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."sourceId",OLD."sourceRevision",OLD."sourceHash",OLD."endpointScopeId",OLD."policyRevision",OLD."agentRevisionId",OLD."authorKey",OLD."dayKey",OLD."kind",OLD."category",OLD."payloadEncrypted",OLD."payloadHash",OLD."createdAt")
    OR OLD."status"<>'IN_FLIGHT' THEN RAISE EXCEPTION 'immutable public effect'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CustomerPublicEffect_immutable" BEFORE UPDATE ON "CustomerPublicEffect" FOR EACH ROW EXECUTE FUNCTION customer_public_effect_immutable();
