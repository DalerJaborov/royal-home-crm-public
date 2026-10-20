/**
 * РАЗБОР ПРЕЖНИХ ПЕРЕПИСОК И ЗВОНКОВ В ДОСЬЕ СОБЕСЕДНИКА — запуск.
 *
 * Сама работа живёт модулем `apps/api/src/lib/contactProfileBackfill.ts`, чтобы
 * её можно было проверить тестом: разбор идёт по записям живых людей.
 *
 * Запуск из корня репозитория:
 *   npx tsx scripts/backfill-contact-profiles.ts           — только показать, что изменится
 *   npx tsx scripts/backfill-contact-profiles.ts --apply   — записать в базу
 * .env подхватывается из apps/api сам — руками экспортировать не нужно.
 *
 * НА ПРОДЕ ЗАПУСКАЕТ ВЛАДЕЛЕЦ. Скрипт правит записи людей, и решение о том,
 * когда это произойдёт, за ним (план от 20.09, остановка в фазе 1).
 */
import "./_env.cjs";
import { prisma } from "../apps/api/src/db.js";
import { backfillContactProfiles } from "../apps/api/src/lib/contactProfileBackfill.js";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  console.log(APPLY ? "РЕЖИМ ЗАПИСИ: досье будут заведены." : "Режим показа: в базу ничего не пишется.");
  const stats = await backfillContactProfiles({ apply: APPLY });

  console.log("");
  console.log(`Переписок мессенджеров без досье: ${stats.conversations}`);
  console.log(`Диалогов Telegram-бота:           ${stats.telegram}`);
  console.log(`Личных сообщений Telegram:        ${stats.direct}`);
  console.log(`Входящих звонков:                 ${stats.calls}`);
  if (stats.skipped > 0) {
    console.log(`Пропущено (канал не даёт признака): ${stats.skipped}`);
  }
  if (APPLY) {
    console.log(`Заведено и заполнено досье:       ${stats.profiles}`);
  } else {
    console.log("");
    console.log("Чтобы записать: npx tsx scripts/backfill-contact-profiles.ts --apply");
  }
}

main()
  .catch((err) => {
    console.error("Разбор прерван:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
