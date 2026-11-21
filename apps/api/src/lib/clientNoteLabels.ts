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
 * Новый ярлык, который код пишет в заметки, добавляется СЮДА; сторож —
 * tests/client-similar-notes-system-lines.test.ts: каждая строка со значка в файлах,
 * пишущих заметки, обязана начинаться с префикса из списка (или стоять в списке
 * «не заметки» с причиной), а каждый префикс — дословно встречаться в своём файле.
 */
import { Prisma } from "../generated/prisma/client.js";

export type ClientNoteLabel = {
  /** Неизменное начало строки — до первой подстановки `${…}`. */
  prefix: string;
  /**
   * drop — строка целиком служебная.
   * quote — служебная обёртка вокруг цитаты клиента: остаётся текст «…» после `marker`
   *   (marker «« » — первая открывающая кавычка строки, иначе — последнее вхождение marker).
   * after — служебное начало до первого «).», дальше пересказ модели, он остаётся.
   */
  keep: "drop" | "quote" | "after";
  marker?: string;
  /** Файл, который пишет эту строку (сторож проверяет, что префикс там есть), или legacy — только старые данные прода. */
  source: string;
};

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
  // Просьба перезвонить: пересказ оператора («Хочет продать. район: …») — служебный,
  // «Слова клиента: «…»» в конце — его собственные слова, их сравниваем.
  { prefix: "📞 ПРОСИТ ПЕРЕЗВОНИТЬ: ", keep: "quote", marker: "Слова клиента: «", source: "messengers/conversation.ts" },
  { prefix: "📍 вне зоны (Душанбе и Рудаки): ", keep: "drop", source: "lib/customerNewLeadBridge.ts" },
  { prefix: "❓ возможно, объект за границей (слова клиента: «", keep: "drop", source: "lib/customerNewLeadBridge.ts" },
  // Комментарии под нашими постами: обёртка служебная, текст комментария — клиента.
  {
    prefix: "Продаёт свою недвижимость: выложил объявление в комментарии под нашим постом",
    keep: "quote",
    marker: "«",
    source: "messengers/comments.ts",
  },
  { prefix: "Рекламный комментарий под нашим постом (реклама чужой недвижимости): ", keep: "quote", marker: "«", source: "messengers/comments.ts" },
  { prefix: "Клиент снова оставил номер в комментарии под нашим постом: ", keep: "quote", marker: "«", source: "messengers/commentPhoneLead.ts" },
  { prefix: "Оставил номер в комментарии под нашим постом: ", keep: "quote", marker: "«", source: "messengers/commentPhoneLead.ts" },
  { prefix: "Подходящих покупателей в базе сейчас нет", keep: "drop", source: "lib/ownerBuyerMatch.ts" },
  { prefix: "Подходящие покупатели в базе: ", keep: "drop", source: "lib/ownerBuyerMatch.ts" },
  { prefix: "⚠️ Код переопределил тип со слов модели (", keep: "after", source: "ai/incomingCallLead.ts" },
  { prefix: "Со страницы: ", keep: "drop", source: "routes/webhooks.ts" },
  // Старые ярлыки: код их больше не пишет, но в заметках прода они лежат (замер 21.11).
  { prefix: "❓ ПРОТИВОРЕЧИЕ: ", keep: "drop", source: "legacy" },
  { prefix: "❓ НАПРАВЛЕНИЕ НЕ ПОДТВЕРЖДЕНО", keep: "drop", source: "legacy" },
  { prefix: "Спам-комментарий под нашим постом", keep: "quote", marker: "«", source: "legacy" },
];

const escapeRe = (s: string): string => s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
const LINE_START = "(^|\\n)[ \\t]*";

/**
 * Одни и те же регулярки для JS и для Postgres (ARE): только литералы, группы,
 * альтернативы и жадные `[^…]*` — эти конструкции оба движка понимают одинаково,
 * равенство проверяет тест на живой базе.
 */
type Pass = { pattern: string; keepGroups: boolean };

function buildPasses(): Pass[] {
  const passes: Pass[] = [];
  for (const label of CLIENT_NOTE_LABELS) {
    const p = escapeRe(label.prefix);
    if (label.keep === "quote") {
      const marker = label.marker ?? "«";
      const upToQuote = marker === "«" ? "[^«\\n]*«" : `[^\\n]*${escapeRe(marker)}`;
      passes.push({ pattern: `${LINE_START}${p}${upToQuote}([^\\n]*)»[^»\\n]*`, keepGroups: true });
    } else if (label.keep === "after") {
      passes.push({ pattern: `${LINE_START}${p}[^)\\n]*\\)\\.[ \\t]*([^\\n]*)`, keepGroups: true });
    }
  }
  // Всё, что осталось со служебным началом (в том числе обёртка без цитаты), — целиком.
  const all = CLIENT_NOTE_LABELS.map((l) => escapeRe(l.prefix)).join("|");
  passes.push({ pattern: `${LINE_START}(?:${all})[^\\n]*`, keepGroups: false });
  return passes;
}

const PASSES = buildPasses();
const JS_PASSES = PASSES.map((p) => ({ re: new RegExp(p.pattern, "g"), to: p.keepGroups ? "$1$2" : "" }));
// Ровно те знаки, что снимает btrim(…, E' \n\t\r') в Postgres, — не String.prototype.trim.
const EDGE_WS = /^[ \n\t\r]+|[ \n\t\r]+$/g;

/** Заметки без служебных строк — то, что сравнивается как «слова человека». */
export function stripClientNoteLabels(text: string): string {
  let out = text;
  for (const { re, to } of JS_PASSES) out = out.replace(re, to);
  return out.replace(EDGE_WS, "");
}

/** Тот же остаток, посчитанный Postgres-ом над колонкой (или выражением). */
export function stripClientNoteLabelsSql(column: Prisma.Sql): Prisma.Sql {
  let expr = column;
  for (const p of PASSES) {
    expr = Prisma.sql`regexp_replace(${expr}, ${p.pattern}, ${p.keepGroups ? "\\1\\2" : ""}, 'g')`;
  }
  return Prisma.sql`btrim(${expr}, E' \\n\\t\\r')`;
}

/** Длина в кодовых точках — как length() в Postgres (эмодзи — один знак, а не два). */
export function noteLength(text: string): number {
  return [...text].length;
}
