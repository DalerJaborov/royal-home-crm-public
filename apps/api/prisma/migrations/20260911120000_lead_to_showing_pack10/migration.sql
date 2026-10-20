-- Пачка 10 (11.09.2026): путь лида до показа.
-- Interaction.outsideCrm — «Связался со своего телефона» (п.1).
ALTER TABLE "Interaction" ADD COLUMN "outsideCrm" BOOLEAN NOT NULL DEFAULT false;

-- PendingSummary: пороги эскалации «Итог показа», независимые от переносов (п.3).
ALTER TABLE "PendingSummary" ADD COLUMN "showingAgentReminderAt" TIMESTAMP(3);
ALTER TABLE "PendingSummary" ADD COLUMN "showingSupervisorAlertAt" TIMESTAMP(3);
