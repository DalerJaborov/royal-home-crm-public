-- Наши номера WhatsApp (27.11.2026): phone_number_id → номер цифрами. Нужен ядру, чтобы
-- узнать «пишет наш же другой номер» при двух номерах (Royal Home + «Арван»). Новая пустая
-- таблица, существующие строки не трогаются; заполняется сама (lib/whatsappOwnNumbers.ts).
CREATE TABLE "WhatsappOwnNumber" (
    "phoneNumberId" TEXT NOT NULL,
    "digits" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappOwnNumber_pkey" PRIMARY KEY ("phoneNumberId")
);
