/**
 * ПЕРЕНОС ЗАПАСНЫХ НОМЕРОВ ИЗ ТЕКСТА ЗАМЕТОК В ПОЛЕ (разовый, 18.08.2026).
 *
 * Предыстория. До появления `Client.extraPhones` лишние номера клиента девать было
 * некуда, и владелец записывал их строкой в заметки карточки:
 *
 *     Другие номера, которые оставил клиент: 030001023, 000001018, 200001022
 *
 * Человек это прочитает, система — нет: звонок с любого из этих номеров карточку не
 * находил. Скрипт переносит такие номера в поле и УБИРАЕТ строку из заметок — иначе
 * один и тот же факт остался бы в двух местах и начал бы расходиться.
 *
 * Почему скрипт, а не SQL внутри миграции. Разбор свободного текста — не то, что
 * стоит зашивать в необратимый шаг схемы: миграция обязана применяться одинаково на
 * любой базе, а этот перенос зависит от того, что и как написал человек. Отдельный
 * запуск ещё и виден в журнале: было столько-то карточек, тронуто столько-то.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/backfill-extra-phones-from-notes.ts            — показать, что будет сделано
 *     npx tsx scripts/backfill-extra-phones-from-notes.ts --apply    — выполнить
 *
 * Без `--apply` не пишет НИЧЕГО. Повторный запуск безопасен: строка из заметок уже
 * убрана, номера уже в поле — скрипт просто не найдёт работы.
 */
import { prisma } from "../src/db.js";
import { normalizeDigits } from "../src/ai/leadQualifier.js";
import { pickFreeExtraPhones } from "../src/lib/clientPhones.js";

/**
 * Как выглядит та самая строка. Ищем по началу («другие номера»), а не по точному
 * тексту: владелец писал её руками и мог оформить чуть иначе. Регистр не важен.
 */
// \w в JavaScript НЕ матчит кириллицу — «Другие» через \w* не находилось вовсе
// (поймано пробным прогоном). Отсюда \p{L} и флаг u.
const NOTE_LINE = /^.*друг\p{L}*\s+номер\p{L}*.*$/gimu;

/** Кого чинить: карточки, в заметках которых есть похожая строка. Предел выборки
 *  обязателен — правило репозитория: это размер СТРАНИЦЫ, обходим всех страницами
 *  по курсору `id`. Раньше брали первые 200: карточки, где «номер» есть, а
 *  переносить нечего (`continue` ниже), из выборки не выходят и навсегда занимали
 *  окно, так что остальные никогда не добирались (аудит Codex 04.10, OPS08). */
const LIMIT = 200;

/**
 * ПОЧЕМУ ЗДЕСЬ РАЗБОР МЯГЧЕ, ЧЕМ У БОТА.
 *
 * Бот (extractAllPhones в ai/leadQualifier.ts) берёт только то, что похоже на
 * настоящий номер по форме: девять цифр, начиная с 3-9, либо код страны, либо явный
 * «+». Иначе он однажды запишет клиенту цену «1050000» как телефон.
 *
 * Здесь этого риска нет: строку человек ПОДПИСАЛ словами «другие номера, которые
 * оставил клиент» — то есть отобрал их сам. Зато строгое правило теряет ровно то,
 * ради чего скрипт написан: у Навруза из карточки ПК-47 два номера начинаются с
 * нуля («030001023», «000001018»), а третий — с двойки («200001022»), и ни один под
 * форму мобильного не подходит. Потерять их значило бы оставить задачу невыполненной
 * ради чистоты правила, которое в этом месте ничего не защищает.
 *
 * Остаются только границы длины (9-15 цифр, как в clientPhoneSchema) и приведение к
 * международному виду общей функцией CRM (normalizeDigits).
 */
function numbersFromLabelledLine(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(/\+?\d[\d  .()\-]{7,17}\d/g) ?? []) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    const tail = digits.slice(-9);
    if (seen.has(tail)) continue;
    seen.add(tail);
    out.push(normalizeDigits(digits));
  }
  return out;
}


async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  async function* candidates() {
    for (let cursor: string | undefined; ; ) {
      const page = await prisma.client.findMany({
        where: {
          deletedAt: null,
          requirementsNotes: { contains: "номер", mode: "insensitive" },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, shortId: true, fullName: true, phone: true, whatsappPhone: true, extraPhones: true, requirementsNotes: true },
        orderBy: { id: "asc" },
        take: LIMIT,
      });
      yield* page;
      if (page.length < LIMIT) return;
      cursor = page[page.length - 1].id;
    }
  }

  let touched = 0;
  for await (const client of candidates()) {
    const notes = client.requirementsNotes ?? "";
    const lines = notes.match(NOTE_LINE) ?? [];
    if (lines.length === 0) continue;

    // Разбор мягче ботовского — почему, см. numbersFromLabelledLine ниже.
    const found = numbersFromLabelledLine(lines.join("\n"));
    if (found.length === 0) continue;

    const fresh = await pickFreeExtraPhones(found, {
      clientId: client.id,
      phone: client.phone,
      whatsappPhone: client.whatsappPhone,
      existing: client.extraPhones,
    });
    // Строку убираем, только если её содержимое действительно переехало в поле
    // (или уже там лежит) — иначе номера пропали бы совсем.
    const alreadyThere = found.length > 0 && fresh.length === 0;
    if (fresh.length === 0 && !alreadyThere) continue;

    const cleanedNotes = notes.replace(NOTE_LINE, "").replace(/\n{3,}/g, "\n\n").trim();

    console.log(
      `ПК-${client.shortId} ${client.fullName}: ${fresh.length ? `+${fresh.join(", ")}` : "номера уже в поле"}` +
        `\n  строка из заметок: ${lines.map((l) => l.trim()).join(" | ")}`
    );
    touched++;
    if (!apply) continue;

    // Поле и заметки — одной операцией: иначе можно остаться со стёртой строкой и
    // без номеров (или наоборот, с задвоенной записью факта).
    await prisma.client.update({
      where: { id: client.id },
      data: {
        extraPhones: { set: [...client.extraPhones, ...fresh] },
        requirementsNotes: cleanedNotes || null,
      },
    });
  }

  console.log(
    apply
      ? `Готово: обновлено карточек — ${touched}.`
      : `Пробный прогон: под перенос попадает карточек — ${touched}. Запустите с --apply, чтобы выполнить.`
  );
}

main()
  .catch((err) => {
    console.error("[backfill-extra-phones] упало:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
