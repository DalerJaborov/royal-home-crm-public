/**
 * СЛУЖЕБНЫЕ СТРОКИ В «ЗАМЕТКАХ» КЛИЕНТА — ОДИН СПИСОК (21.11.2026).
 *
 * Бот, приём заявок, разбор комментариев и звонков кладут в Client.requirementsNotes
 * не только слова клиента, но и свои ярлыки: «🌍 ВНЕ ДУШАНБЕ — клиент назвал «Гиссар»…»,
 * «🏷 ПРОДАВЕЦ — хочет разместить объект у нас…», «📞 ПРОСИТ ПЕРЕЗВОНИТЬ: …». Один и тот
 * же ярлык стоит у десятков разных людей, и сравнение заметок «Может, один человек?»
 * (lib/fuzzySearch.ts::fuzzySimilarClientNotes) принимало его за сходство: снимок
 * владельца 21.11 — «Прочее обращение» с тремя подсказками 82–84% к трём разным людям;
 * замер прода — все 162 подсказки у 20 карточек от ярлыков 🌍/🚫.
 *
 * Здесь перечислено, ЧТО считается служебным, а не правило «строка со значка»: клиент
 * пишет объявления значками сам («🏠 Продаю…\n📍 Сино\n💰 …»), и customerNewLeadBridge
 * кладёт его сообщения в заметки дословно — правило по значку стёрло бы именно то, что
 * и выдаёт одного человека с двух номеров.
 *
 * ГДЕ СЧИТАЕТСЯ. Только кодом, один раз при записи: перехват записи Client в db.ts
 * кладёт результат clientNotesPlain() в Client.requirementsNotesPlain, по нему и ищутся
 * похожие (GIN-индекс, оператор %). Очистка регулярками в SQL на каждый запрос стоила
 * 4 с на 5000 карточек против 0,18 с (замер ревью #382) — поэтому её там нет вовсе.
 * Сменился список — сменился CLIENT_NOTE_LABELS_REV (хеш списка), и обход при старте
 * worker пересчитывает старые строки (lib/clientNotesPlainSweep.ts).
 *
 * Новый ярлык, который код пишет в заметки, добавляется СЮДА; сторож —
 * tests/client-similar-notes-system-lines.test.ts.
 */

export type ClientNoteLabel = {
  /** Неизменное начало строки — до первой подстановки `${…}`. */
  prefix: string;
  /**
   * drop — строка целиком служебная.
   * quote — служебная обёртка вокруг слов клиента «…»: остаются слова (и их продолжение
   *   на следующих строках, пока кавычка не закроется). markers — где начинаются слова,
   *   по порядку: первый найденный («Слова клиента: «» — последнее вхождение, «« » — первая
   *   кавычка после префикса). cut — служебные вставки, вырезаемые до поиска.
   * after — служебное начало «префикс (…)» со скобками любой вложенности, дальше пересказ.
   */
  keep: "drop" | "quote" | "after";
  markers?: string[];
  cut?: RegExp[];
  /** Файл, который пишет эту строку (сторож проверяет, что префикс там есть), или legacy — только старые данные прода. */
  source: string;
};

/** «Когда звонить: «вечером»» — время звонка, а не слова клиента (ai/leadOnlyMode.ts::leadOnlyNoteWithCallbackTime). */
const CALLBACK_TIME = /\.?\s*Когда звонить: «[^»\n]*»/g;

export const CLIENT_NOTE_LABELS: readonly ClientNoteLabel[] = [
  // ai/leadKind.ts — ярлык типа обращения (decideLeadKind) и две пометки направления.
  { prefix: "❓ направление не подтверждено словами клиента", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "❓ уточнить: покупает или продаёт", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "🗂 ПО ДОСЬЕ: ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "🌍 ВНЕ ДУШАНБЕ — клиент назвал «", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "🏷 ПРОДАЖА ВНЕ ДУШАНБЕ — ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "💼 НЕ КЛИЕНТ: ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "🚫 НЕ НАШ ПРОФИЛЬ: ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "❓ НЕ ПО ТЕМЕ — ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "🔑 ПОХОЖЕ НА АРЕНДУ — ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "❓ ПРИШЁЛ ПО РЕКЛАМЕ И НИЧЕГО НЕ НАПИСАЛ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "❓ БОТ НЕ ПОНЯЛ, ЧЕГО ХОЧЕТ ЧЕЛОВЕК", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "🏷 ПРОДАВЕЦ — хочет разместить объект у нас", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "💼 СОИСКАТЕЛЬ РАБОТЫ", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "🔑 АРЕНДА — не наше дело", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "❓ Обращение не по профилю", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "❓ ТИП ОБРАЩЕНИЯ НЕ ОПРЕДЕЛЁН", keep: "drop", source: "ai/leadKind.ts" },
  { prefix: "❓ БОТ НЕ СПРАВИЛСЯ С ВОПРОСОМ", keep: "drop", source: "services/leads/intentUnknown.ts" },
  // Просьба перезвонить: пересказ оператора («Хочет продать. район: …», ai/operator/decide.ts) —
  // служебный; слова клиента — после «Слова клиента: «», а в старой форме заметки
  // (lib/customerLeadOnlyCore.ts: «<сценарий>: «слова»») — в первой кавычке.
  {
    prefix: "📞 ПРОСИТ ПЕРЕЗВОНИТЬ: ",
    keep: "quote",
    markers: ["Слова клиента: «", "«"],
    cut: [CALLBACK_TIME],
    source: "messengers/conversation.ts",
  },
  { prefix: "📍 вне зоны (Душанбе и Рудаки): ", keep: "drop", source: "lib/customerNewLeadBridge.ts" },
  { prefix: "❓ возможно, объект за границей (слова клиента: «", keep: "drop", source: "lib/customerNewLeadBridge.ts" },
  // Комментарии под нашими постами: обёртка служебная, текст комментария (бывает в несколько строк) — клиента.
  {
    prefix: "Продаёт свою недвижимость: выложил объявление в комментарии под нашим постом",
    keep: "quote",
    markers: ["«"],
    source: "messengers/comments.ts",
  },
  { prefix: "Рекламный комментарий под нашим постом (реклама чужой недвижимости): ", keep: "quote", markers: ["«"], source: "messengers/comments.ts" },
  { prefix: "Клиент снова оставил номер в комментарии под нашим постом: ", keep: "quote", markers: ["«"], source: "messengers/commentPhoneLead.ts" },
  { prefix: "Оставил номер в комментарии под нашим постом: ", keep: "quote", markers: ["«"], source: "messengers/commentPhoneLead.ts" },
  { prefix: "Подходящих покупателей в базе сейчас нет", keep: "drop", source: "lib/ownerBuyerMatch.ts" },
  { prefix: "Подходящие покупатели в базе: ", keep: "drop", source: "lib/ownerBuyerMatch.ts" },
  { prefix: "⚠️ Код переопределил тип со слов модели (", keep: "after", source: "ai/incomingCallLead.ts" },
  { prefix: "Со страницы: ", keep: "drop", source: "routes/webhooks.ts" },
  // Старые ярлыки: код их больше не пишет, но в заметках прода они лежат (замер 21.11).
  { prefix: "❓ ПРОТИВОРЕЧИЕ: ", keep: "drop", source: "legacy" },
  { prefix: "❓ НАПРАВЛЕНИЕ НЕ ПОДТВЕРЖДЕНО", keep: "drop", source: "legacy" },
  { prefix: "Спам-комментарий под нашим постом", keep: "quote", markers: ["«"], source: "legacy" },
];

/**
 * Версия списка: меняется сама при любой правке CLIENT_NOTE_LABELS (FNV-1a по его
 * содержимому, включая cut), поэтому помнить о ручном «поднять версию» не нужно.
 */
export const CLIENT_NOTE_LABELS_REV: number = (() => {
  const text = JSON.stringify(CLIENT_NOTE_LABELS, (_k, v) => (v instanceof RegExp ? v.source : v)) + "|parser-v1";
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
})();

const EDGE_WS = /^[ \n\t\r]+|[ \n\t\r]+$/g;

function labelOf(line: string): ClientNoteLabel | undefined {
  const t = line.replace(/^[ \t]+/, "");
  return CLIENT_NOTE_LABELS.find((l) => t.startsWith(l.prefix));
}

/** Текст после «префикс (…)» с учётом вложенных скобок; null — скобка не закрылась. */
function afterParens(body: string): string | null {
  let depth = 1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")" && --depth === 0) return body.slice(i + 1).replace(/^\.?[ \t]*/, "");
  }
  return null;
}

/**
 * Слова клиента с позиции после открывающей «: идём до парной », считая вложенные «»,
 * и переходим на следующие строки (многострочный комментарий), пока кавычка не
 * закроется или не начнётся следующая служебная строка. Незакрытая (текст обрезан
 * по длине) — берём всё, что есть.
 */
function takeQuote(lines: string[], start: number, from: string): { words: string; next: number } {
  const out: string[] = [];
  let depth = 1;
  let text = from;
  let i = start;
  for (;;) {
    let end = -1;
    for (let k = 0; k < text.length; k++) {
      if (text[k] === "«") depth++;
      else if (text[k] === "»" && --depth === 0) {
        end = k;
        break;
      }
    }
    if (end >= 0) {
      out.push(text.slice(0, end));
      return { words: out.join("\n"), next: i + 1 };
    }
    out.push(text);
    if (i + 1 >= lines.length || labelOf(lines[i + 1])) return { words: out.join("\n"), next: i + 1 };
    i++;
    text = lines[i];
  }
}

/**
 * Заметки без служебных строк — то, что сравнивается как «слова человека».
 * Края — ровно [ \n\t\r] (как btrim в Postgres), длина остатка — clientNotesLength.
 */
export function clientNotesPlain(text: string | null | undefined): string {
  if (!text) return "";
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const label = labelOf(lines[i]);
    if (!label) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let body = lines[i].replace(/^[ \t]+/, "").slice(label.prefix.length);
    if (label.keep === "after") {
      const rest = afterParens(body);
      if (rest) out.push(rest);
      i++;
      continue;
    }
    if (label.keep === "drop") {
      i++;
      continue;
    }
    for (const re of label.cut ?? []) body = body.replace(re, "");
    let from = -1;
    for (const marker of label.markers ?? ["«"]) {
      const at = marker === "«" ? body.indexOf("«") : body.lastIndexOf(marker);
      if (at >= 0) {
        from = at + marker.length;
        break;
      }
    }
    if (from < 0) {
      i++;
      continue;
    }
    const { words, next } = takeQuote(lines, i, body.slice(from));
    if (words.replace(EDGE_WS, "")) out.push(words);
    i = next;
  }
  return out.join("\n").replace(EDGE_WS, "");
}

/** Длина в кодовых точках — как length() в Postgres (эмодзи — один знак, а не два). */
export function clientNotesLength(text: string): number {
  return [...text].length;
}

/**
 * ОДНА ДВЕРЬ ЗАПИСИ (вызывается только из перехвата Client в db.ts). Если в данных записи
 * есть requirementsNotes (строка, null или { set }), рядом кладётся его очищенная копия
 * и версия списка. Без этого места поиск похожих читал бы устаревший текст.
 */
export function withClientNotesPlain(data: unknown): void {
  if (!data || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const row of data) withClientNotesPlain(row);
    return;
  }
  const row = data as Record<string, unknown>;
  if (!("requirementsNotes" in row)) return;
  let raw = row.requirementsNotes;
  if (raw && typeof raw === "object" && "set" in (raw as object)) raw = (raw as { set: unknown }).set;
  if (raw === undefined) return;
  const plain = typeof raw === "string" ? clientNotesPlain(raw) : "";
  row.requirementsNotesPlain = plain || null;
  row.requirementsNotesPlainRev = CLIENT_NOTE_LABELS_REV;
}
