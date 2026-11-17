-- Пропущенный входящий звонок не теряется (18.11.2026): два рубильника, оба ВЫКЛЮЧЕНЫ.
-- Только добавление колонок с умолчанием: поведение прода не меняется, пока владелец не включит.
ALTER TABLE "Settings" ADD COLUMN "missedCallSmsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "missedCallSmsText" TEXT NOT NULL DEFAULT 'Салом. Шумо занг задед, мо ҷавоб дода натавонистем. Ба WhatsApp нависед: https://wa.me/992777776001 Вы звонили, мы не успели ответить. Напишите нам в WhatsApp.';
ALTER TABLE "Settings" ADD COLUMN "missedCallCallbackTaskEnabled" BOOLEAN NOT NULL DEFAULT false;
