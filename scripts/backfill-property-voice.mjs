/**
 * ДОБОР «ГОЛОСА РЫНКА» ПО СТАРЫМ ДАННЫМ — запуск (03.10.2026).
 *
 * Сама работа живёт модулем `apps/api/src/lib/propertyVoice/backfill.ts`, чтобы её
 * проверял тест. Что делает и почему только по доказанному — в его шапке.
 *
 * Запуск из корня репозитория:
 *   npx tsx scripts/backfill-property-voice.mjs           — только показать, сколько будет создано (по умолчанию)
 *   npx tsx scripts/backfill-property-voice.mjs --apply   — записать в базу
 * .env подхватывается из apps/api сам — руками экспортировать не нужно.
 *
 * Идемпотентен: повторный запуск ничего не меняет. НА ПРОДЕ ЗАПУСКАЕТ ВЛАДЕЛЕЦ:
 * скрипт пишет в живую базу, и когда это произойдёт, решает он.
 */
import "./_env.cjs";

import { prisma } from "../apps/api/src/db.js";
import { backfillPropertyVoice } from "../apps/api/src/lib/propertyVoice/backfill.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "РЕЖИМ ЗАПИСИ: связи и объекты будут записаны." : "Режим показа: в базу ничего не пишется.");
  const stats = await backfillPropertyVoice({ apply: APPLY });

  const verb = APPLY ? "создано/проставлено" : "будет создано/проставлено";
  console.log("");
  console.log(`Связей «диалог ↔ объект» (${verb}): ${stats.conversationLinks}`);
  for (const [source, n] of Object.entries(stats.conversationLinksBySource)) {
    console.log(`    ${source}: ${n}`);
  }
  console.log(`Вопросов собственнику с объектом (${verb}): ${stats.ownerQuestions}`);
  console.log(`Комментариев с объектом (${verb}): ${stats.comments}`);
  console.log(`Разборов звонков с объектом (${verb}): ${stats.callAnalyses}`);
  if (!APPLY) {
    console.log("");
    console.log("Чтобы записать: npx tsx scripts/backfill-property-voice.mjs --apply");
  }
}

main()
  .catch((err) => {
    console.error("Добор прерван:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
