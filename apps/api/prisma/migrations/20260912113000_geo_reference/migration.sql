-- Гео-справочники Душанбе (12.09.2026, docs/geo-match-plan-12-09.md, блок B).
-- Написано руками (prisma migrate dev запрещён в worktree), сверено со schema.prisma.
--
-- Владелец купил и лицензировал адресный слой Душанбе (дома, улицы,
-- микрорайоны, жилые массивы, районы, ориентиры) — файлы лежат в
-- D:\CRM\.data-geo\ вне git (14 МБ, в .gitignore) и наполняются отдельным
-- скриптом prisma/scripts/import-geo.ts, не этой миграцией: в 338 миграциях
-- репозитория INSERT INTO не встречается ни разу, справочники наполняются
-- сидами и разовыми скриптами (см. migrate-properties-view-all.ts как образец).
--
-- PostGIS НЕ подключаем: полигонов всего 31 (27 микрорайонов + 4 района +
-- часть жилых массивов), точка-в-полигоне считается в памяти на стороне
-- Node — geo-колонки хранят WKT как обычный текст.
--
-- Дополнение владельца (то же обсуждение, 12.09.2026): без словаря синонимов
-- геосправочник не ищется — «82 мкр» из переписки не совпадает строкой с
-- «82-й микрорайон» в базе. GeoAlias — единая точка входа для бота и подбора
-- (lib/geoResolve.ts), без FK на цель: targetType держит шесть разных таблиц,
-- а внешний ключ Prisma всегда ведёт в одну (см. докстринг модели).

-- District: новые geo-поля поверх существующей (старой) таблицы. Существующие
-- четыре строки (Сино/Шохмансур/Фирдавси/Исмоили Сомони, см. seed.ts) переживают
-- миграцию как есть — все новые колонки nullable, импорт дозаполнит их UPDATE'ом.
ALTER TABLE "District" ADD COLUMN "sourceId" TEXT;
ALTER TABLE "District" ADD COLUMN "nameTj" TEXT;
ALTER TABLE "District" ADD COLUMN "lat" DECIMAL(65,30);
ALTER TABLE "District" ADD COLUMN "lng" DECIMAL(65,30);
ALTER TABLE "District" ADD COLUMN "boundary" TEXT;
CREATE UNIQUE INDEX "District_sourceId_key" ON "District"("sourceId");

-- Building: справочник домов (24 325 записей источника).
CREATE TABLE "Building" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "street" TEXT,
    "houseNumber" TEXT NOT NULL,
    "microdistrict" TEXT,
    "livingArea" TEXT,
    "districtId" TEXT NOT NULL,
    "lat" DECIMAL(65,30) NOT NULL,
    "lng" DECIMAL(65,30) NOT NULL,
    "purpose" TEXT,
    "floors" INTEGER,
    "wallMaterial" TEXT,
    "entrances" INTEGER,
    "apartments" INTEGER,
    "builtYear" INTEGER,
    "outline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Building_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Building_sourceId_key" ON "Building"("sourceId");
CREATE INDEX "Building_lat_lng_idx" ON "Building"("lat", "lng");
CREATE INDEX "Building_districtId_idx" ON "Building"("districtId");
CREATE INDEX "Building_street_idx" ON "Building"("street");
ALTER TABLE "Building" ADD CONSTRAINT "Building_districtId_fkey"
    FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Street: справочник улиц (920 записей источника).
CREATE TABLE "Street" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameTj" TEXT,
    "kind" TEXT NOT NULL,
    "districtId" TEXT,
    "lat" DECIMAL(65,30) NOT NULL,
    "lng" DECIMAL(65,30) NOT NULL,
    "geometry" TEXT,
    "housesCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Street_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Street_sourceId_key" ON "Street"("sourceId");
CREATE INDEX "Street_districtId_idx" ON "Street"("districtId");
CREATE INDEX "Street_name_idx" ON "Street"("name");
ALTER TABLE "Street" ADD CONSTRAINT "Street_districtId_fkey"
    FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Microdistrict: справочник микрорайонов (27 записей, граница есть у всех).
CREATE TABLE "Microdistrict" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameTj" TEXT,
    "lat" DECIMAL(65,30) NOT NULL,
    "lng" DECIMAL(65,30) NOT NULL,
    "boundary" TEXT NOT NULL,

    CONSTRAINT "Microdistrict_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Microdistrict_sourceId_key" ON "Microdistrict"("sourceId");

-- LivingArea: справочник жилых массивов (117 записей, граница есть у 13).
CREATE TABLE "LivingArea" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameTj" TEXT,
    "lat" DECIMAL(65,30) NOT NULL,
    "lng" DECIMAL(65,30) NOT NULL,
    "boundary" TEXT,

    CONSTRAINT "LivingArea_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LivingArea_sourceId_key" ON "LivingArea"("sourceId");

-- Landmark: справочник ориентиров (857 записей после вычистки мусора Викиданных).
CREATE TABLE "Landmark" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "category" TEXT NOT NULL,
    "address" TEXT,
    "districtId" TEXT,
    "lat" DECIMAL(65,30) NOT NULL,
    "lng" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "Landmark_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Landmark_sourceId_key" ON "Landmark"("sourceId");
CREATE INDEX "Landmark_lat_lng_idx" ON "Landmark"("lat", "lng");
CREATE INDEX "Landmark_category_idx" ON "Landmark"("category");
ALTER TABLE "Landmark" ADD CONSTRAINT "Landmark_districtId_fkey"
    FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- GeoAlias: словарь синонимов ("82 мкр" -> "82-й микрорайон"), без FK на цель
-- (targetType разнотипный — building/street/microdistrict/livingArea/landmark/district).
CREATE TABLE "GeoAlias" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoAlias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GeoAlias_normalized_targetType_targetId_key" ON "GeoAlias"("normalized", "targetType", "targetId");
CREATE INDEX "GeoAlias_normalized_idx" ON "GeoAlias"("normalized");
CREATE INDEX "GeoAlias_targetType_targetId_idx" ON "GeoAlias"("targetType", "targetId");
-- Триграммный индекс для нечёткого поиска через geoResolve.ts (pg_trgm уже
-- подключён миграцией 20260805160000_pg_trgm_fuzzy_search).
CREATE INDEX "GeoAlias_normalized_trgm_idx" ON "GeoAlias" USING GIN ("normalized" gin_trgm_ops);
