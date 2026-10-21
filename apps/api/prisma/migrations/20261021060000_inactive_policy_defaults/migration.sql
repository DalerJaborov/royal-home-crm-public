-- Match the relationship-depth policy used by the application fallback.
-- Existing policy choices are preserved; no client rows are changed.
ALTER TABLE "Settings"
  ALTER COLUMN "inactiveGreenMaxAttempts" SET DEFAULT 5,
  ALTER COLUMN "inactiveRedPingHours" SET DEFAULT 36;
