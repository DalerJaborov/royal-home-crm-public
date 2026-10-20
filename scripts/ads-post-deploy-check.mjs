/**
 * РЕКЛАМА: ПРОВЕРКА ПОСЛЕ ВЫКАТА МИГРАЦИИ «ОДНО ОБЪЯВЛЕНИЕ — НЕСКОЛЬКО ОБЪЕКТОВ» — ТОЛЬКО ЧТЕНИЕ.
 *
 * В базу НИЧЕГО НЕ ПИШЕТ (только SELECT) и ничего не чинит: печатает расхождения между
 * двумя источниками правды — Ad.propertyId («основной объект») и строками AdProperty
 * (доли) — и уходит с кодом 1, если они есть. Чинит их синхронизация (setAdProperties в
 * lib/ads/adAllocation.ts) или человек в карточке объявления; здесь — только увидеть.
 *
 * Что проверяет:
 *   1. propertyId указан, а строк AdProperty нет (бэкфилл не догнал; пока читается как одна доля с весом 1);
 *   2. строки AdProperty есть, а propertyId пуст;
 *   3. propertyId не входит в связи объявления;
 *   4. propertyId не равен основному по весу (первый по весу, при равных — по порядку создания);
 *   5. вес связи меньше 0.001 или неположительный (такой вес allocateCents не принимает);
 *   6. связь ведёт на объект из Корзины (deletedAt) — деньги лежат на том, чего в списках нет;
 *   7. сумма долей: объявление без единой допустимой доли при заполненном propertyId.
 *
 * Запуск из корня репозитория (после выката миграции):
 *   npx tsx scripts/ads-post-deploy-check.mjs
 * .env подхватывается из apps/api сам — руками экспортировать не нужно.
 */
import "./_env.cjs";

import { prisma } from "../apps/api/src/db.js";

/** Сколько примеров каждого расхождения печатать. */
const SAMPLE = 20;

const problems = [];
const note = (kind, title, rows) => {
  if (rows.length === 0) {
    console.log(`  ok   ${title}`);
    return;
  }
  problems.push(kind);
  console.log(`  FAIL ${title}: ${rows.length}`);
  for (const row of rows.slice(0, SAMPLE)) console.log(`       - ${JSON.stringify(row)}`);
  if (rows.length > SAMPLE) console.log(`       … и ещё ${rows.length - SAMPLE}`);
};

async function main() {
  const [{ ads }] = await prisma.$queryRaw`SELECT COUNT(*)::int AS ads FROM "Ad"`;
  const [{ links }] = await prisma.$queryRaw`SELECT COUNT(*)::int AS links FROM "AdProperty"`;
  console.log(`Объявлений: ${ads}, строк долей (AdProperty): ${links}`);
  console.log("");

  // 1. propertyId есть — долей нет.
  note(
    "NO_LINK_ROWS",
    "propertyId указан, а строк AdProperty нет",
    await prisma.$queryRaw`
      SELECT a.id, a."externalId", a."propertyId"
      FROM "Ad" a
      WHERE a."propertyId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "AdProperty" p WHERE p."adId" = a.id)
      ORDER BY a."createdAt" DESC`
  );

  // 2. Доли есть — propertyId пуст.
  note(
    "NO_PRIMARY",
    "строки AdProperty есть, а propertyId пуст",
    await prisma.$queryRaw`
      SELECT a.id, a."externalId", (SELECT COUNT(*)::int FROM "AdProperty" p WHERE p."adId" = a.id) AS links
      FROM "Ad" a
      WHERE a."propertyId" IS NULL
        AND EXISTS (SELECT 1 FROM "AdProperty" p WHERE p."adId" = a.id)
      ORDER BY a."createdAt" DESC`
  );

  // 3. propertyId не входит в связи.
  note(
    "PRIMARY_NOT_IN_LINKS",
    "propertyId не входит в связи объявления",
    await prisma.$queryRaw`
      SELECT a.id, a."externalId", a."propertyId"
      FROM "Ad" a
      WHERE a."propertyId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "AdProperty" p WHERE p."adId" = a.id)
        AND NOT EXISTS (SELECT 1 FROM "AdProperty" p WHERE p."adId" = a.id AND p."propertyId" = a."propertyId")
      ORDER BY a."createdAt" DESC`
  );

  // 4. propertyId не равен основному по весу (при равных весах — по порядку создания).
  note(
    "PRIMARY_NOT_HEAVIEST",
    "propertyId не равен основному по весу",
    await prisma.$queryRaw`
      SELECT a.id, a."externalId", a."propertyId" AS "stored", top."propertyId" AS "expected"
      FROM "Ad" a
      JOIN LATERAL (
        SELECT p."propertyId"
        FROM "AdProperty" p
        WHERE p."adId" = a.id
        ORDER BY p.weight DESC, p."createdAt" ASC, p.id ASC
        LIMIT 1
      ) top ON TRUE
      WHERE a."propertyId" IS NOT NULL
        AND a."propertyId" <> top."propertyId"
        AND EXISTS (SELECT 1 FROM "AdProperty" p WHERE p."adId" = a.id AND p."propertyId" = a."propertyId")
      ORDER BY a."createdAt" DESC`
  );

  // 5. Недопустимый вес.
  note(
    "BAD_WEIGHT",
    "вес связи меньше 0.001 (деление долей такую связь не видит)",
    await prisma.$queryRaw`
      SELECT p.id, p."adId", p."propertyId", p.weight::float8 AS weight
      FROM "AdProperty" p
      WHERE p.weight < 0.001
      ORDER BY p."createdAt" DESC`
  );

  // 6. Связь на объект из Корзины.
  note(
    "LINK_TO_TRASHED_PROPERTY",
    "связь ведёт на объект из Корзины",
    await prisma.$queryRaw`
      SELECT p."adId", p."propertyId", pr."shortId"
      FROM "AdProperty" p
      JOIN "Property" pr ON pr.id = p."propertyId"
      WHERE pr."deletedAt" IS NOT NULL
      ORDER BY p."createdAt" DESC`
  );

  // 7. propertyId заполнен, но ни одна связь не имеет допустимого веса.
  note(
    "NO_VALID_WEIGHT",
    "propertyId заполнен, а допустимой доли нет ни у одной связи",
    await prisma.$queryRaw`
      SELECT a.id, a."externalId", a."propertyId"
      FROM "Ad" a
      WHERE a."propertyId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "AdProperty" p WHERE p."adId" = a.id)
        AND NOT EXISTS (SELECT 1 FROM "AdProperty" p WHERE p."adId" = a.id AND p.weight >= 0.001)`
  );

  console.log("");
  if (problems.length === 0) {
    console.log("Расхождений нет.");
  } else {
    console.log(`Расхождения: ${problems.join(", ")}. Скрипт ничего не менял.`);
  }
}

main()
  .catch((err) => {
    console.error("Проверка не выполнена:", err);
    process.exitCode = 2;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (problems.length > 0 && !process.exitCode) process.exitCode = 1;
  });
