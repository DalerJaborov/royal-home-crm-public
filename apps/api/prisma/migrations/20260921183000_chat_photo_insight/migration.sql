-- КЭШ ОЦЕНКИ ФОТО ПРОДАВЦА ИЗ ПЕРЕПИСКИ (владелец 21.09.2026, «объект продавца
-- заполняется сам, но деньги на токены зря не тратятся»).
--
-- Правка ТОЛЬКО ДОБАВЛЯЕТ: новая независимая таблица, ключ — sha256 содержимого
-- файла, а не связь с Client/Property. Существующие таблицы не меняются.

-- CreateTable
CREATE TABLE "ChatPhotoInsight" (
    "sha256" TEXT NOT NULL,
    "isPlan" BOOLEAN NOT NULL DEFAULT false,
    "condition" "PropertyCondition",
    "rooms" INTEGER,
    "score" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPhotoInsight_pkey" PRIMARY KEY ("sha256")
);
