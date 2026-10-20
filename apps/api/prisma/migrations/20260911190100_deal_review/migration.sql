-- Пачка 11, 11.09.2026: отзыв и рекомендация после сделки (docs/gaps-audit-11-09.md).

CREATE TABLE "DealReview" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "rating" INTEGER,
    "text" TEXT,
    "referralPhone" TEXT,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "DealReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DealReview_dealId_clientId_key" ON "DealReview"("dealId", "clientId");
CREATE INDEX "DealReview_clientId_idx" ON "DealReview"("clientId");
CREATE INDEX "DealReview_answeredAt_idx" ON "DealReview"("answeredAt");

ALTER TABLE "DealReview" ADD CONSTRAINT "DealReview_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealReview" ADD CONSTRAINT "DealReview_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
