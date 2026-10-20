-- Промт ответов на комментарии Instagram переезжает из кода в Настройки.
-- NULL по умолчанию: пустая настройка означает «действует зашитый по умолчанию».
ALTER TABLE "Settings" ADD COLUMN "botCommentPrompt" TEXT;
