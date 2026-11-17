-- One-brain live check (17.11.2026): the model's words beside the template, kept 72 hours for the owner to read before live.
CREATE TABLE "CustomerAgentAnswerSample" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationId" TEXT,
    "eventKey" TEXT,
    "answerMode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "customerText" TEXT NOT NULL,
    "modelText" TEXT NOT NULL,
    "templateText" TEXT NOT NULL,
    CONSTRAINT "CustomerAgentAnswerSample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerAgentAnswerSample_createdAt_idx" ON "CustomerAgentAnswerSample"("createdAt");
CREATE INDEX "CustomerAgentAnswerSample_expiresAt_idx" ON "CustomerAgentAnswerSample"("expiresAt");
