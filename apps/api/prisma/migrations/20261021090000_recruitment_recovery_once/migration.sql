-- A renamed campaign never grants another historical correction, including UNKNOWN.
CREATE UNIQUE INDEX "RecruitmentRecovery_original_once_key"
 ON "RecruitmentRecovery"("originalConversationId");
