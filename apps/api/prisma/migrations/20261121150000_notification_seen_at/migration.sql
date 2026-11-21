-- «Просмотрено» отдельно от «сделано»: только добавляет колонку, данные не трогает.
ALTER TABLE "Notification" ADD COLUMN "seenAt" TIMESTAMP(3);
