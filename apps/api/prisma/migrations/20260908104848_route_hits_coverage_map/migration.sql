-- CreateTable
CREATE TABLE "RouteHit" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RouteHit_kind_lastSeenAt_idx" ON "RouteHit"("kind", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "RouteHit_kind_key_key" ON "RouteHit"("kind", "key");
