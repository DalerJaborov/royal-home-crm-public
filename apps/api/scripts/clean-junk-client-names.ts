/**
 * УБРАТЬ МУСОР ИЗ ПОЛЯ «ИМЯ» КАРТОЧКИ (разовый, 30.08.2026).
 *
 * Предыстория. Владелец 30.08.2026: «некоторые дают своё имя, а ИИ не вставляет имя
 * в карточку, это важно». Разбор прода за 14 дней показал вторую половину той же
 * беды: в поле «Имя» попадал ВЕСЬ текст сообщения клиента, если фильтр счёл его
 * похожим на имя, — а фильтр (`looksLikeRealName`) пропускал любую фразу с заглавной
 * буквы до 40 знаков. Отсюда живые карточки: «Чихели кунум» (= «а как мне это
 * сделать?»), «Бахшиш дер чавоб додестам ман кордаям» (= «извините, что поздно
 * отвечаю, я на работе»), «Тел», «Ака», «Варзоб», «Адрес курган», «Хона хар 😂».
 *
 * Что уже исправлено в коде без этого скрипта (messengers/conversation.ts):
 *  · в имя пишется результат `normalizeClientName`, а не `text.trim()`;
 *  · заглушка опознаётся общей `isPlaceholderName`, а не третьей копией регулярки.
 * То есть ВПЕРЁД мусор больше не заводится.
 *
 * Зачем тогда скрипт. Уже испорченные карточки код не чинит намеренно: их имена
 * вписаны до правки, следа «это заполнил ИИ» у них нет, и автозаполнение обязано
 * считать их введёнными человеком — иначе оно затирало бы настоящую работу агентов.
 * Разобрать их может только разовый проход с глазами владельца.
 *
 * Что делает: если имя НЕ заглушка и при этом `normalizeClientName` его отвергает
 * (то есть это фраза, город, «Тел» и т.п.), ставит принятую в проекте заглушку с
 * номером карточки — «Покупатель ПК-000042». Тогда карточка снова считается
 * безымянной, и её имя дозаполнится само, как только клиент представится.
 *
 * Что теряется: ничего. Отвергнутый текст — это реплика клиента, она осталась в
 * переписке карточки; плюс скрипт печатает каждую замену построчно, и этот вывод
 * стоит сохранить перед запуском с `--apply`.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/clean-junk-client-names.ts            — показать, что будет сделано
 *     npx tsx scripts/clean-junk-client-names.ts --apply    — выполнить
 *
 * Без `--apply` не пишет НИЧЕГО. Повторный запуск безопасен: поставленная заглушка
 * опознаётся `isPlaceholderName` и во второй раз не трогается.
 *
 * СНАЧАЛА прогнать scripts/move-social-username-out-of-names.ts: ник — это тоже
 * «не имя», но у него своя судьба (переезжает в socialUsername), и терять его,
 * заменив заглушкой, нельзя.
 */
import { prisma } from "../src/db.js";
import { isPlaceholderName } from "../src/lib/placeholderName.js";
import { normalizeClientName } from "../src/ai/replyGuards.js";
import { looksLikeSocialUsername } from "../src/lib/clientOrigin.js";
import { CLIENT_KIND_LABELS, formatClientCode } from "@royal-home/shared";
import type { ClientKind } from "@royal-home/shared";

/** Предел выборки обязателен — правило репозитория. Идём страницами по курсору. */
const BATCH = 500;

/**
 * Демонстрационные карточки («🎓 Демо: Азиз Рахимов») трогать нельзя: это учебные
 * записи для обучения сотрудников, их имена намеренно с эмодзи и потому не проходят
 * фильтр настоящего имени. На проде их 12 из 165 — без этой отсечки скрипт «починил»
 * бы ровно их и ничего больше.
 */
const DEMO_MARK = "Демо";

/** Та же заглушка, что ставит бот при приёме заявки (messengers/conversation.ts). */
function placeholderFor(kind: string, shortId: number): string {
  const k = (kind as ClientKind) ?? "OTHER";
  return `${CLIENT_KIND_LABELS[k] ?? "Клиент"} ${formatClientCode(shortId, k)}`;
}

type Row = { id: string; shortId: number; fullName: string; kind: string };

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  let cursor: string | undefined;
  let scanned = 0;
  const toFix: Array<Row & { name: string }> = [];

  for (;;) {
    const page: Row[] = await prisma.client.findMany({
      where: { deletedAt: null },
      select: { id: true, shortId: true, fullName: true, kind: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]!.id;

    for (const c of page) {
      if (c.fullName.includes(DEMO_MARK)) continue;
      // Заглушка — это не мусор, а честное «имени пока нет».
      if (isPlaceholderName(c.fullName)) continue;
      // Ник разбирает соседний скрипт: ему заглушка не нужна, ему нужен переезд.
      if (looksLikeSocialUsername(c.fullName)) continue;
      // Настоящее имя фильтр пропускает — значит остаётся только мусор.
      if (normalizeClientName(c.fullName) !== null) continue;
      toFix.push({ ...c, name: placeholderFor(c.kind, c.shortId) });
    }

    if (page.length < BATCH) break;
  }

  console.log(`Просмотрено карточек: ${scanned}`);
  console.log(`С мусором в поле «Имя»: ${toFix.length}`);
  for (const c of toFix) {
    console.log(`  ${formatClientCode(c.shortId, c.kind as ClientKind)}: «${c.fullName}» → «${c.name}»`);
  }

  if (!apply) {
    console.log(
      toFix.length > 0
        ? "\nСохраните вывод выше и запустите с --apply, чтобы применить."
        : "\nМенять нечего.",
    );
    return;
  }

  for (const c of toFix) {
    await prisma.client.update({ where: { id: c.id }, data: { fullName: c.name } });
  }
  console.log(`\nОбновлено карточек: ${toFix.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
