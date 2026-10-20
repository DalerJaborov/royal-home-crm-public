/**
 * §10.4 ПЛАНА — СКОЛЬКО СВЕЖИХ КАРТОЧЕК ПОЛУЧИЛИ БЫ ДРУГОЙ ТИП (22.09.2026).
 *
 * Читает базу, ничего не пишет. Отвечает на один вопрос перед тем, как включать
 * `Settings.contactCategoryDrivesLeadKind`: сколько карточек за последние N дней
 * ушли в «Прочие» ровно по тем двум причинам, которые новый тумблер умеет
 * разрешать (модель не уверена / намерения нет вовсе), и у скольких из них уже
 * было досье с установленной категорией BUYER/SELLER — то есть при включённом
 * тумблере они стали бы обычной карточкой покупателя/продавца, а не «Прочим».
 *
 * НЕ считает решение владельца за него: печатает список client short id вместе
 * со счётом, включать тумблер или нет — по-прежнему его слово.
 *
 * Запуск из корня репозитория (нужен API .env с DATABASE_URL):
 *   npx tsx scripts/estimate-category-lead-kind-flips.ts [--days=30]
 */
import "./_env.cjs";
import { prisma } from "../apps/api/src/db.js";

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? Number(daysArg.slice("--days=".length)) : 30;

// Те же две метки, что decideLeadKind ставит в requirementsNotes первой строкой
// в ветках "confident===false" и "намерение не определено" (ai/leadKind.ts) —
// единственные два случая, которые priorCategory умеет разрешить.
const UNCERTAIN_LABELS = ["БОТ НЕ ПОНЯЛ, ЧЕГО ХОЧЕТ ЧЕЛОВЕК", "ТИП ОБРАЩЕНИЯ НЕ ОПРЕДЕЛЁН"];

async function main(): Promise<void> {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const candidates = await prisma.client.findMany({
    where: {
      kind: "OTHER",
      createdAt: { gte: since },
      OR: UNCERTAIN_LABELS.map((label) => ({ requirementsNotes: { contains: label } })),
    },
    select: { id: true, shortId: true, requirementsNotes: true },
  });

  console.log(`За последние ${DAYS} дн.: карточек «Прочее» по неуверенному ходу — ${candidates.length}.`);
  if (candidates.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const profiles = await prisma.contactProfile.findMany({
    where: { clientId: { in: candidates.map((c) => c.id) } },
    select: { clientId: true, category: true },
  });
  const categoryByClientId = new Map(profiles.map((p) => [p.clientId as string, p.category]));

  let wouldFlip = 0;
  const flippedRows: string[] = [];
  for (const c of candidates) {
    const category = categoryByClientId.get(c.id);
    if (category === "BUYER" || category === "SELLER") {
      wouldFlip++;
      flippedRows.push(`  ПК-${String(c.shortId).padStart(6, "0")} → ${category}`);
    }
  }

  console.log(`Из них досье уже знало BUYER/SELLER (стали бы этим типом, а не «Прочим»): ${wouldFlip}.`);
  if (flippedRows.length > 0) {
    console.log("");
    console.log(flippedRows.join("\n"));
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
