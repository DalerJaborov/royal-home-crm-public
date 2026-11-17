CREATE TABLE "ExpenseReceiptContent" (
    "receiptId" TEXT NOT NULL,
    "image" BYTEA NOT NULL,
    CONSTRAINT "ExpenseReceiptContent_pkey" PRIMARY KEY ("receiptId")
);

CREATE TABLE "TelegramExpenseDraft" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "evidence" JSONB,
    "image" BYTEA,
    "expenseId" TEXT,
    "previewMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramExpenseDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramExpenseDraft_sourceHash_key" ON "TelegramExpenseDraft"("sourceHash");
CREATE UNIQUE INDEX "TelegramExpenseDraft_expenseId_key" ON "TelegramExpenseDraft"("expenseId");
CREATE UNIQUE INDEX "TelegramExpenseDraft_chatId_messageId_key" ON "TelegramExpenseDraft"("chatId", "messageId");
CREATE INDEX "TelegramExpenseDraft_expiresAt_idx" ON "TelegramExpenseDraft"("expiresAt");
ALTER TABLE "ExpenseReceiptContent" ADD CONSTRAINT "ExpenseReceiptContent_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ExpenseReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
