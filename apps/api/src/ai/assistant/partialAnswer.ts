/**
 * ЧЕСТНЫЙ ОТВЕТ, КОГДА ШАГИ КОНЧИЛИСЬ (07.11.2026). Раньше человек получал
 * «Не удалось собрать ответ за разумное число шагов» и терял всё, что помощница уже
 * нашла. Теперь: что нашли — списком, что проверили, и один уточняющий вопрос.
 * Результаты инструментов не выдумываются: берём только поля `items[].code/href/...`.
 *
 * ЯЗЫК (пачка 2, 07.11.2026): фраза идёт на языке собеседника — тот же язык хода, что
 * выбрал `assistantLanguagePolicy` (languageRouting.ts). По-таджикски — на «шумо».
 * Номера карточек, суммы и ссылки не переводятся.
 */
import type { ClientLanguage } from "../clientLanguage.js";
import { repliesInTajik } from "./languageRouting.js";

export const LAST_ROUND_INSTRUCTION =
  "\n\nЭТО ПОСЛЕДНИЙ ШАГ: инструменты больше не вызывай. Ответь по тому, что УЖЕ найдено выше. " +
  "Чего не нашла или не успела проверить — скажи прямо и задай ОДИН уточняющий вопрос (ориентир, район, цена).";

export interface CollectedToolResult {
  name: string;
  result: unknown;
}

interface ItemLike {
  code?: unknown;
  href?: unknown;
  title?: unknown;
  address?: unknown;
  name?: unknown;
  district?: unknown;
  price?: unknown;
  currency?: unknown;
  inTrash?: unknown;
  distanceM?: unknown;
}

type ReplyLanguage = "ru" | "tg";

/** Готовые фразы частичного ответа парой ru/tg. Таджикский — на «шумо». */
const TEXTS: Record<
  ReplyLanguage,
  { somoni: string; inTrash: string; head: string; tail: string; empty: (checks: number) => string }
> = {
  ru: {
    somoni: "с.",
    inTrash: "в Корзине",
    head: "Собрала пока вот что, остальное не успела проверить:",
    tail: "Скажите ориентир или район точнее — продолжу поиск.",
    empty: (checks) =>
      `Я сделала ${checks || "несколько"} проверок, но ответа не собрала — запрос получился слишком широким. ` +
      "Назовите ориентир или улицу, район и цену (в сомони или долларах), и я поищу точнее.",
  },
  tg: {
    somoni: "сомонӣ",
    inTrash: "дар Корзина",
    head: "Ҳоло инҳоро ёфтам, боқимондаашро санҷида нарасидам:",
    tail: "Лутфан нишона ё ноҳияро аниқтар гӯед, ҷустуҷӯро идома медиҳам.",
    empty: (checks) =>
      `Ман ${checks || "чанд"} санҷиш кардам, вале ҷавоб ҷамъ нашуд: дархост хеле васеъ шуд. ` +
      "Лутфан нишона ё кӯча, ноҳия ва нархро (бо сомонӣ ё доллар) гӯед, то аниқтар ҷустуҷӯ кунам.",
  },
};

function replyLanguage(language: ClientLanguage | undefined): ReplyLanguage {
  return language && repliesInTajik(language) ? "tg" : "ru";
}

function lineOf(item: ItemLike, lang: ReplyLanguage): string | null {
  const code = typeof item.code === "string" ? item.code : null;
  if (!code) return null;
  const label = [item.title, item.name, item.address, item.district].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const price =
    typeof item.price === "number" && typeof item.currency === "string"
      ? `${item.price.toLocaleString("ru-RU")} ${item.currency === "USD" ? "$" : TEXTS[lang].somoni}`
      : null;
  const href = typeof item.href === "string" ? item.href : null;
  const parts = [
    href ? `[${code}](${href})` : code,
    label ? label.slice(0, 80) : null,
    price,
    typeof item.distanceM === "number" ? `${item.distanceM} м` : null,
    item.inTrash === true ? TEXTS[lang].inTrash : null,
  ].filter(Boolean);
  return `- ${parts.join(" · ")}`;
}

/** Есть ли в результатах инструментов хоть одна карточка с кодом. */
export function hasFoundItems(collected: readonly CollectedToolResult[]): boolean {
  return collected.some(({ result }) => {
    const items = (result as { items?: unknown } | null)?.items;
    return Array.isArray(items) && items.some((i) => typeof (i as ItemLike)?.code === "string");
  });
}

/** Записи этого хода: исполненные и ждущие нажатия «Подтвердить» (имена инструментов). */
export interface TurnWrites {
  done: readonly string[];
  pending: readonly string[];
}

/** Что сделала запись — бытовыми словами, парой ru/tg; незнакомое имя — общая фраза. */
const WRITE_LABELS: Record<string, Record<ReplyLanguage, string>> = {
  create_task: { ru: "создала задачу", tg: "вазифа сохтам" },
  reschedule_task: { ru: "перенесла задачу", tg: "вазифаро ба вақти дигар гузарондам" },
  complete_task: { ru: "закрыла задачу", tg: "вазифаро анҷом додам" },
  add_client_note: { ru: "добавила заметку", tg: "қайд илова кардам" },
  book_showing: { ru: "записала показ", tg: "намоишро навиштам" },
  reschedule_showing: { ru: "перенесла показ", tg: "намоишро гузарондам" },
  cancel_showing: { ru: "отменила показ", tg: "намоишро бекор кардам" },
  create_client: { ru: "завела клиента", tg: "мизоҷ сохтам" },
  change_property_price: { ru: "изменение цены", tg: "тағйири нарх" },
  change_property_status: { ru: "изменение статуса объекта", tg: "тағйири ҳолати объект" },
  restore_property: { ru: "восстановление объекта из Корзины", tg: "баргардонидани объект аз Корзина" },
  delete_property: { ru: "удаление объекта", tg: "нест кардани объект" },
};

function writeLabel(name: string, lang: ReplyLanguage): string {
  return WRITE_LABELS[name]?.[lang] ?? (lang === "tg" ? "амал" : "действие");
}

/** Строки «уже сделано» и «ждёт подтверждения» — чтобы частичный ответ не умолчал о записи. */
function writesLines(writes: TurnWrites | undefined, lang: ReplyLanguage): string[] {
  if (!writes) return [];
  const uniq = (names: readonly string[]) => [...new Set(names.map((n) => writeLabel(n, lang)))];
  const out: string[] = [];
  if (writes.done.length) {
    out.push(`${lang === "tg" ? "Дар ин ҷавоб аллакай иҷро шуд" : "Уже сделано в этом ответе"}: ${uniq(writes.done).join("; ")}.`);
  }
  if (writes.pending.length) {
    out.push(`${lang === "tg" ? "Тасдиқи шуморо дар корт интизор аст" : "Ждёт вашего подтверждения в карточке"}: ${uniq(writes.pending).join("; ")}.`);
  }
  return out;
}

/**
 * Текст «собрала частично» из результатов инструментов за диалог.
 * @param language язык хода (`assistantLanguagePolicy(...).language`); без него — русский.
 * @param writes записи этого хода: о сделанном частичный ответ говорит прямо (ревью 08.11).
 */
export function partialAnswerFromResults(
  collected: readonly CollectedToolResult[],
  language?: ClientLanguage,
  writes?: TurnWrites,
): string {
  const lang = replyLanguage(language);
  const done = writesLines(writes, lang);
  const withWrites = (text: string) => (done.length ? `${done.join("\n")}\n${text}` : text);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { result } of collected) {
    const items = (result as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      const line = lineOf(raw as ItemLike, lang);
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
      if (lines.length >= 6) break;
    }
    if (lines.length >= 6) break;
  }
  if (lines.length === 0) return withWrites(TEXTS[lang].empty(collected.length));
  return withWrites(`${TEXTS[lang].head}\n${lines.join("\n")}\n${TEXTS[lang].tail}`);
}
