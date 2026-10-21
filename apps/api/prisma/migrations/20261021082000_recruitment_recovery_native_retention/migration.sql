-- Keep the original receipt identity without preventing native conversation
-- deletion. The live nullable pointer is not a new send target or a rebind.
ALTER TABLE "RecruitmentRecovery" ADD COLUMN "originalConversationId" TEXT;
UPDATE "RecruitmentRecovery" SET "originalConversationId"="conversationId";
ALTER TABLE "RecruitmentRecovery" ALTER COLUMN "originalConversationId" SET NOT NULL;
ALTER TABLE "RecruitmentRecovery" ALTER COLUMN "conversationId" DROP NOT NULL;
ALTER TABLE "RecruitmentRecovery" ADD CONSTRAINT "RecruitmentRecovery_native_binding"
 CHECK ("conversationId" IS NULL OR "conversationId"="originalConversationId");
ALTER TABLE "RecruitmentRecovery" DROP CONSTRAINT "RecruitmentRecovery_conversation_fkey";
ALTER TABLE "RecruitmentRecovery" ADD CONSTRAINT "RecruitmentRecovery_conversation_fkey"
 FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL;
CREATE OR REPLACE FUNCTION "guardRecruitmentRecovery"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recovery receipt is retained'; END IF;
 IF NEW."conversationId" IS DISTINCT FROM OLD."conversationId" AND NOT
   (NEW."conversationId" IS NULL AND NOT EXISTS (SELECT 1 FROM "BotConversation" WHERE "id"=OLD."conversationId")) THEN RAISE EXCEPTION 'Recovery cannot rebind'; END IF;
 IF ROW(NEW."id",NEW."campaign",NEW."originalConversationId",NEW."endpointScopeId",NEW."transportJson",NEW."fenceJson",NEW."sourceHash",NEW."sourceAt",NEW."catalogHash",NEW."payloadEncrypted",NEW."payloadHash",NEW."actorId",NEW."createdAt") IS DISTINCT FROM
 ROW(OLD."id",OLD."campaign",OLD."originalConversationId",OLD."endpointScopeId",OLD."transportJson",OLD."fenceJson",OLD."sourceHash",OLD."sourceAt",OLD."catalogHash",OLD."payloadEncrypted",OLD."payloadHash",OLD."actorId",OLD."createdAt") THEN RAISE EXCEPTION 'Immutable recovery source'; END IF;
 IF OLD."attemptAt" IS NOT NULL AND NEW."attemptAt" IS DISTINCT FROM OLD."attemptAt" THEN RAISE EXCEPTION 'Immutable recovery attempt'; END IF;
 IF OLD."status" IN ('ACCEPTED','UNKNOWN','NOT_SENT','SUPPRESSED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN RAISE EXCEPTION 'Terminal recovery outcome'; END IF;
 IF OLD."providerMid" IS NOT NULL AND NEW."providerMid" IS DISTINCT FROM OLD."providerMid" THEN RAISE EXCEPTION 'Immutable provider receipt'; END IF;
 RETURN NEW;
END $$;
DROP INDEX "RecruitmentRecovery_campaign_conversation_key";
CREATE UNIQUE INDEX "RecruitmentRecovery_campaign_conversation_key" ON "RecruitmentRecovery"("campaign","originalConversationId");
