-- Шаблоны обложек для соцсетей (владелец, 23.09.2026).
ALTER TABLE "Settings" ADD COLUMN "coverTemplateMode" TEXT NOT NULL DEFAULT 'FIXED';
ALTER TABLE "Settings" ADD COLUMN "coverTemplateId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "coverTemplateEnabledIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "CoverTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "svgUrl" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "leavesUrl" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "CoverTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CoverTemplate_createdAt_idx" ON "CoverTemplate"("createdAt");
