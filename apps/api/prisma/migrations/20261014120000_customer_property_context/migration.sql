ALTER TABLE "BotConversation"
  ADD COLUMN "customerPropertyFocus" JSONB,
  ADD COLUMN "customerPropertyFocusRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CustomerPropertyIngressTicket" (
  "eventKey" TEXT NOT NULL PRIMARY KEY,
  "order" BIGSERIAL NOT NULL UNIQUE,
  "scopeKey" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL REFERENCES "BotConversation"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CustomerPropertyIngressTicket_conversationId_scopeKey_idx"
  ON "CustomerPropertyIngressTicket"("conversationId", "scopeKey");
