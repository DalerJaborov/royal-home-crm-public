-- В2 владельца (15.11.2026): комментарий, на который бот не смог ответить из-за сбоя
-- (ИИ недоступен, технический отказ ядра, застрял в очереди), — человеку одной сводкой.
-- Рубильник сторожа lib/commentWaitingAlert.ts; по умолчанию включён.
ALTER TABLE "Settings" ADD COLUMN "commentFailureWatchEnabled" BOOLEAN NOT NULL DEFAULT true;
