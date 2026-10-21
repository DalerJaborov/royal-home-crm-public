-- One explicit staff-approved bot correction per campaign/native conversation.
-- It is neither a synthetic inbound nor a customer action/HUMAN release grant.
CREATE TABLE "RecruitmentRecovery" (
 "id" TEXT PRIMARY KEY, "campaign" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
 "endpointScopeId" TEXT NOT NULL, "transportJson" JSONB NOT NULL, "fenceJson" JSONB,
 "sourceHash" TEXT NOT NULL, "sourceAt" TIMESTAMP(3) NOT NULL,
 "catalogHash" TEXT NOT NULL, "payloadEncrypted" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
 "actorId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'READY',
 "providerMid" TEXT, "attemptAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3), "projectionAt" TIMESTAMP(3),
 "reason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "RecruitmentRecovery_conversation_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE RESTRICT,
 CONSTRAINT "RecruitmentRecovery_endpoint_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT,
 CONSTRAINT "RecruitmentRecovery_actor_fkey" FOREIGN KEY ("actorId") REFERENCES "Agent"("id") ON DELETE RESTRICT,
 CONSTRAINT "RecruitmentRecovery_status" CHECK ("status" IN ('READY','IN_FLIGHT','ACCEPTED','UNKNOWN','NOT_SENT','SUPPRESSED')),
 CONSTRAINT "RecruitmentRecovery_hashes" CHECK ("sourceHash" ~ '^[a-f0-9]{64}$' AND "catalogHash" ~ '^[a-f0-9]{64}$' AND "payloadHash" ~ '^[a-f0-9]{64}$'),
 CONSTRAINT "RecruitmentRecovery_receipt" CHECK (("status" <> 'ACCEPTED' OR ("providerMid" IS NOT NULL AND "attemptAt" IS NOT NULL AND "finishedAt" IS NOT NULL)) AND ("projectionAt" IS NULL OR "status"='ACCEPTED'))
);
CREATE UNIQUE INDEX "RecruitmentRecovery_campaign_conversation_key" ON "RecruitmentRecovery"("campaign","conversationId");
CREATE UNIQUE INDEX "RecruitmentRecovery_scope_mid_key" ON "RecruitmentRecovery"("endpointScopeId","providerMid");
CREATE INDEX "RecruitmentRecovery_status_created_idx" ON "RecruitmentRecovery"("status","createdAt");
CREATE FUNCTION "guardRecruitmentRecovery"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recovery receipt is retained'; END IF;
 IF ROW(NEW."id",NEW."campaign",NEW."conversationId",NEW."endpointScopeId",NEW."transportJson",NEW."fenceJson",NEW."sourceHash",NEW."sourceAt",NEW."catalogHash",NEW."payloadEncrypted",NEW."payloadHash",NEW."actorId",NEW."createdAt") IS DISTINCT FROM
 ROW(OLD."id",OLD."campaign",OLD."conversationId",OLD."endpointScopeId",OLD."transportJson",OLD."fenceJson",OLD."sourceHash",OLD."sourceAt",OLD."catalogHash",OLD."payloadEncrypted",OLD."payloadHash",OLD."actorId",OLD."createdAt") THEN RAISE EXCEPTION 'Immutable recovery source'; END IF;
 IF OLD."attemptAt" IS NOT NULL AND NEW."attemptAt" IS DISTINCT FROM OLD."attemptAt" THEN RAISE EXCEPTION 'Immutable recovery attempt'; END IF;
 IF OLD."status" IN ('ACCEPTED','UNKNOWN','NOT_SENT','SUPPRESSED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN RAISE EXCEPTION 'Terminal recovery outcome'; END IF;
 IF OLD."providerMid" IS NOT NULL AND NEW."providerMid" IS DISTINCT FROM OLD."providerMid" THEN RAISE EXCEPTION 'Immutable provider receipt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentRecovery_immutable" BEFORE UPDATE OR DELETE ON "RecruitmentRecovery" FOR EACH ROW EXECUTE FUNCTION "guardRecruitmentRecovery"();
