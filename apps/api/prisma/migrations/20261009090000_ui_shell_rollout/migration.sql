-- Nullable and disabled by default: existing users keep the legacy shell.
ALTER TABLE "Settings" ADD COLUMN "uiShellRollout" JSONB;
