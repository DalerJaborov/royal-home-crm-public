ALTER TABLE "InvestigationDecision" ADD COLUMN "level" TEXT NOT NULL DEFAULT 'C1';
UPDATE "InvestigationDecision" SET "level"=CASE "newStatus" WHEN 'CLEARED' THEN 'C0' WHEN 'CONFIRMED' THEN 'C4' ELSE 'C1' END;
