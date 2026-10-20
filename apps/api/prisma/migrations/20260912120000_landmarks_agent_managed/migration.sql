-- Справочник ориентиров ведут агенты (12.09.2026, docs/geo-match-plan-12-09.md,
-- блок J, решение владельца). Написано руками (prisma migrate dev запрещён в
-- worktree), сверено со schema.prisma.
--
-- sourceId становится необязательным ПО ТОЙ ЖЕ ПРИЧИНЕ, что у District.sourceId
-- (см. миграцию 20260912113000_geo_reference): запись, которую заводит агент
-- вручную из Настроек, не приходит из купленного слоя и своего "id" источника
-- не имеет. Существующие 857 строк (или сколько их успел завести import-geo.ts
-- к этому моменту) уже все со значением — DROP NOT NULL их не трогает.
ALTER TABLE "Landmark" ALTER COLUMN "sourceId" DROP NOT NULL;

-- enabled: скрытие вместо удаления. DEFAULT true — все существующие
-- (импортированные) записи остаются видимыми как были.
ALTER TABLE "Landmark" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- source: "import" | "agent". DEFAULT 'import' — все существующие записи
-- пришли из купленного слоя, ничего не переразмечаем задним числом.
ALTER TABLE "Landmark" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'import';

-- radiusM: насколько широко люди понимают название, метры. Не задан у
-- существующих записей — подбор до сих пор берёт DEFAULT_RADIUS_BY_TYPE.
ALTER TABLE "Landmark" ADD COLUMN "radiusM" INTEGER;

-- createdById/updatedById: без FK, см. докстринг модели в schema.prisma —
-- та же причина, что у StyleExample.agentId и StageEvent.agentId.
ALTER TABLE "Landmark" ADD COLUMN "createdById" TEXT;
ALTER TABLE "Landmark" ADD COLUMN "updatedById" TEXT;

-- updatedAt: DEFAULT CURRENT_TIMESTAMP только чтобы ALTER TABLE не упал на уже
-- заполненной таблице — Prisma дальше пишет её сама на каждое изменение (@updatedAt),
-- как и остальные такие колонки в схеме.
ALTER TABLE "Landmark" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Landmark_enabled_idx" ON "Landmark"("enabled");

-- ЗНАЧИМОСТЬ (дополнение владельца 12.09.2026 к блоку J: строка расстояний в
-- стиле Booking.com на карточке объекта не должна выбирать ориентиры просто
-- по близости). DEFAULT 0 — существующие записи из поставки без явного мнения
-- о значимости остаются "обычными", пока агент/руководитель не поднимет вес.
ALTER TABLE "Landmark" ADD COLUMN "weight" INTEGER NOT NULL DEFAULT 0;

-- mentions: считается отдельным блоком добычи из звонков/переписок (блок O,
-- не эта миграция) — здесь только колонка.
ALTER TABLE "Landmark" ADD COLUMN "mentions" INTEGER NOT NULL DEFAULT 0;

-- isCityCenter: «до центра» отдельной строкой, как у Booking.
ALTER TABLE "Landmark" ADD COLUMN "isCityCenter" BOOLEAN NOT NULL DEFAULT false;
