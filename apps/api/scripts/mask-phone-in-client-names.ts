/**
 * ЗАКРЫТЬ НОМЕР, ЛЕЖАЩИЙ В ИМЕНИ КАРТОЧКИ (разовый, 20.08.2026).
 *
 * Предыстория. Владелец увидел у агента карточку с именем «Входящий
 * +992910001003» и справедливо спросил: почему номер вышел агенту, ведь он
 * закрыт правилом `clients.viewPhone`? Правило работало — но закрывало ПОЛЕ
 * `phone`, а номер лежал в ИМЕНИ: карточку незнакомого звонившего CRM заводит
 * сама, и до сегодняшнего дня писала в имя открытый номер целиком
 * (lib/telephony/incomingCalls.ts и два соседних места).
 *
 * Что уже исправлено в коде без этого скрипта:
 *  · новые карточки заводятся сразу с маской в имени — «Входящий +992•••••54»;
 *  · выдача карточки и списка клиентов маскирует номер в имени на лету
 *    (routes/clients.ts, presentClient).
 *
 * Зачем тогда скрипт. Маскировка на выдаче стоит там, где карточка превращается
 * в ответ, — а имя клиента уходит агенту и мимо этого места: в push-уведомление
 * («Новый лид — Входящий +992910001003»), в календарь, на доску сделок. Гоняться
 * за каждым таким местом — ровно та ошибка, о которой предупреждает шапка
 * lib/clientPhone.ts: «правило, записанное в одном маршруте, не является
 * правилом». Дешевле и надёжнее убрать номер из самих данных: в поле `phone` он
 * остаётся и открывается тому, у кого есть право.
 *
 * Что теряется: ничего. Эти имена CRM написала сама, человек их не вводил, а
 * настоящий номер лежит в `phone` рядом.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/mask-phone-in-client-names.ts            — показать, что будет сделано
 *     npx tsx scripts/mask-phone-in-client-names.ts --apply    — выполнить
 *
 * Без `--apply` не пишет НИЧЕГО. Повторный запуск безопасен: у уже закрытых имён
 * цифр подряд не осталось, и скрипт их не найдёт.
 */
import { prisma } from "../src/db.js";
import { maskPhonesInText } from "../src/lib/clientPhone.js";

/** Размер страницы: предел выборки обязателен — правило репозитория. Обходим ВСЕХ
 *  живых клиентов страницами по курсору `id`, а не берём первые N (аудит Codex
 *  04.10, OPS08): при клиентах больше предела повторный запуск читал те же
 *  строки и никогда не доходил до остальных. */
const PAGE = 500;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const candidates: Array<{ id: string; shortId: number; fullName: string }> = [];
  for (let cursor: string | undefined; ; ) {
    const page = await prisma.client.findMany({
      where: { deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, shortId: true, fullName: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    candidates.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }

  // Сравниваем результат маскировки с исходником, а не пытаемся отобрать
  // «подозрительные» имена запросом: правило, что считать номером, живёт в одном
  // месте (maskPhonesInText) — второй его копии здесь быть не должно.
  const toFix = candidates
    .map((c) => ({ ...c, masked: maskPhonesInText(c.fullName) }))
    .filter((c) => c.masked !== c.fullName);

  console.log(`Просмотрено карточек: ${candidates.length}`);
  console.log(`С номером в имени: ${toFix.length}`);
  for (const c of toFix) {
    console.log(`  КЛ-${String(c.shortId).padStart(6, "0")}: «${c.fullName}» → «${c.masked}»`);
  }

  if (!apply) {
    console.log(toFix.length > 0 ? "\nЗапустите с --apply, чтобы применить." : "\nМенять нечего.");
    return;
  }

  for (const c of toFix) {
    await prisma.client.update({ where: { id: c.id }, data: { fullName: c.masked } });
  }
  console.log(`\nОбновлено карточек: ${toFix.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
