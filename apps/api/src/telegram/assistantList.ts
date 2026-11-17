import { escapeHtml } from "./assistantReply.js";

/**
 * ОДНО ОФОРМЛЕНИЕ ВСЕХ СПИСКОВ ПОМОЩНИЦЫ В TELEGRAM (владелец 10.11.2026).
 *
 * «Списки в чат-ботах — красиво и единообразно: заголовок с иконкой и числом,
 * номер карточки жирным, коротко по смыслу, совет отдельной строкой; одно место
 * оформления на все инструменты». Образец владельца:
 *
 *   🏠 Объекты без движения · 2
 *
 *   1️⃣ ОБ-000161 — 3к · Ашан
 *   💰 $120 750 · 📉 соседние дешевле ~10%
 *   📅 48 дней без продажи
 *
 *   💡 Совет: предложите собственникам пересмотреть цену.
 *
 * Правила: номер-эмодзи 1️⃣…🔟, дальше «11.»; номер карточки (ОБ-/ПК-/ПР-)
 * первым и жирным; главное — второй строкой, срок/дата — третьей; длинное —
 * свёрнутой цитатой; сообщение не длиннее предела Telegram (4096) — иначе
 * страницы, нумерация продолжается; ru/tg.
 *
 * Здесь только ВИД. Данные, права и маски телефонов — забота того, кто зовёт.
 * Кнопки («🔕 Не присылать такое» и т. п.) — тоже: это не текст.
 */

export type ListLang = "ru" | "tg";

export interface AssistantListItem {
  /** Номер карточки: «ОБ-000161», «ПК-000042». Идёт первым, жирным. */
  code?: string;
  /** Ссылка на карточку CRM — только для текстового вида (ответ модели). */
  href?: string;
  /** Коротко, что это: «3к · Ашан». */
  title: string;
  /** Главное — вторая строка (и следующие, если их несколько). */
  main?: string[];
  /** Срок, дата, сколько дней — отдельной строкой. */
  when?: string;
  /** Длинное пояснение — свёрнутой цитатой (в HTML) или обрезанной строкой. */
  details?: string;
}

export interface AssistantList {
  icon: string;
  title: string;
  /** Сколько всего (может быть больше, чем показано). По умолчанию — items.length. */
  total?: number;
  items: AssistantListItem[];
  /** Совет — последней строкой «💡 Совет: …». */
  tip?: string;
  /** Строка под списком до совета: «Показываю 5 из 12». */
  note?: string;
  /** Текст, если список пуст. */
  empty?: string;
  lang?: ListLang;
}

/** Предел Telegram — 4096 знаков; запас на разметку кнопок и маски. */
export const LIST_MESSAGE_LIMIT = 4_000;
const DETAILS_LIMIT = 900;

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** 1️⃣…🔟, дальше «11.» — эмодзи-цифр больше десяти нет. */
export function listNumber(n: number): string {
  return n >= 1 && n <= KEYCAPS.length ? KEYCAPS[n - 1]! : `${n}.`;
}

const COPY = {
  ru: { tip: "Совет", page: (i: number, n: number) => `стр. ${i}/${n}`, empty: "Пока пусто." },
  tg: { tip: "Маслиҳат", page: (i: number, n: number) => `саҳ. ${i}/${n}`, empty: "Ҳоло холӣ." },
} as const;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

type Render = {
  bold: (t: string) => string;
  esc: (t: string) => string;
  code: (item: AssistantListItem) => string;
  details: (t: string) => string;
};

const HTML: Render = {
  bold: (t) => `<b>${t}</b>`,
  esc: escapeHtml,
  code: (item) => (item.code ? `<b>${escapeHtml(item.code)}</b>` : ""),
  details: (t) => `<blockquote expandable>${escapeHtml(clip(t, DETAILS_LIMIT))}</blockquote>`,
};

/**
 * Текстовый вид — для ответа, который дальше идёт обычным путём ответа
 * помощницы (assistantDelivery: экранирование, ссылки в имени, коды моноширинным).
 * Жирный там снимается, поэтому код карточки становится ссылкой на неё.
 */
const TEXT: Render = {
  bold: (t) => t,
  esc: (t) => t.replace(/[[\]]/g, " "),
  code: (item) => (item.code ? (item.href ? `[${item.code}](${item.href})` : item.code) : ""),
  details: (t) => `   ${clip(t, 300)}`,
};

function header(list: AssistantList, r: Render, page?: { i: number; n: number }): string {
  const total = list.total ?? list.items.length;
  const pageMark = page && page.n > 1 ? ` (${COPY[list.lang ?? "ru"].page(page.i, page.n)})` : "";
  return `${list.icon} ${r.bold(r.esc(list.title))} · ${total}${pageMark}`;
}

function itemBlock(item: AssistantListItem, n: number, r: Render): string {
  const code = r.code(item);
  const head = `${listNumber(n)} ${code ? `${code} — ` : ""}${r.esc(item.title)}`;
  const lines = [head, ...(item.main ?? []).filter(Boolean).map(r.esc)];
  if (item.when) lines.push(r.esc(item.when));
  if (item.details?.trim()) lines.push(r.details(item.details));
  return lines.join("\n");
}

function footer(list: AssistantList, r: Render): string[] {
  const out: string[] = [];
  if (list.note) out.push(r.esc(list.note));
  if (list.tip) out.push(`💡 ${COPY[list.lang ?? "ru"].tip}: ${r.esc(list.tip)}`);
  return out;
}

function paginate(list: AssistantList, r: Render, limit: number): string[] {
  const lang = list.lang ?? "ru";
  if (list.items.length === 0) {
    return [[`${list.icon} ${r.bold(r.esc(list.title))}`, r.esc(list.empty ?? COPY[lang].empty)].join("\n\n")];
  }
  const blocks = list.items.map((item, i) => itemBlock(item, i + 1, r));
  const tail = footer(list, r);
  // Резерв на заголовок со страницей «(стр. 10/10)».
  const headRoom = header(list, r, { i: 99, n: 99 }).length + 2;
  const tailRoom = tail.join("\n\n").length + 2;
  const pages: string[][] = [[]];
  let size = headRoom;
  for (const raw of blocks) {
    // Одна карточка длиннее страницы — обрезаем её саму, а не теряем.
    // Обрезка не должна разрезать «&amp;» — Telegram отверг бы всё сообщение.
    const block = raw.length > limit - headRoom - tailRoom
      ? clip(raw.replace(/<[^>]+>/g, ""), limit - headRoom - tailRoom).replace(/&[#a-z0-9]*…$/i, "…")
      : raw;
    const current = pages[pages.length - 1]!;
    if (current.length && size + block.length + 2 > limit) {
      pages.push([block]);
      size = headRoom + block.length + 2;
    } else {
      current.push(block);
      size += block.length + 2;
    }
  }
  if (tail.length && size + tailRoom > limit) pages.push([]);
  return pages.map((page, i) => {
    const parts = [header(list, r, { i: i + 1, n: pages.length }), ...page];
    if (i === pages.length - 1) parts.push(...tail);
    return parts.join("\n\n");
  });
}

/** HTML-страницы для sendHtmlMessage. Каждая ≤ limit знаков. */
export function renderAssistantListHtml(list: AssistantList, limit = LIST_MESSAGE_LIMIT): string[] {
  return paginate(list, HTML, limit);
}

/** Текстовые страницы для обычного пути ответа помощницы. */
export function renderAssistantListText(list: AssistantList, limit = LIST_MESSAGE_LIMIT): string[] {
  return paginate(list, TEXT, limit);
}
