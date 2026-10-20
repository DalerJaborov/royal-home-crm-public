-- Когда боту уже поручали спросить у кандидата номер телефона.
-- Нужен, чтобы догоняющая просьба ушла человеку РОВНО ОДИН РАЗ:
-- повторный прогон рассылки (lib/askCandidatePhone.ts) обязан быть безопасным.
ALTER TABLE "JobApplication" ADD COLUMN "phoneAskedAt" TIMESTAMP(3);
