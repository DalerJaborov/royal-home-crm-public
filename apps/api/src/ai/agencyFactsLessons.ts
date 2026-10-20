import { AGENCY_FACTS } from "./agencyFacts.js";
import { BW, EW } from "./wordBoundary.js";

/**
 * ВЫУЧЕННЫЕ ПРАВИЛА НЕ МОГУТ СПОРИТЬ С ФАКТАМИ КОМПАНИИ (аудит 10.10.2026, P0-2).
 *
 * learnedRulesBlock (lib/botLessons.ts) брал 12 свежих активных правил без фильтра
 * канала и без сверки с фактами — и они шли в чат, в публичные ответы под постами и в
 * голос. Среди 244 активных правил на проде: 27 про рассрочку и ипотеку (фактов «НЕТ»),
 * 12 про аренду (часть велит советовать Somon.tj), «гарантируйте проверку», «встреча с
 * собственником для торга», «срок готовности ролика 1–2 дня», мусор «} his». Оговорка
 * «запреты выше важнее» спасает не всегда: правило свежее и конкретнее.
 *
 * Здесь две чистые проверки, которыми пользуется selectActiveLessons:
 *  - lessonConflict(text) — противоречит ли правило данным AGENCY_FACTS (agencyFacts.ts):
 *    проверки строятся ОТ ДАННЫХ — станет рассрочка правдой (installments: true), и
 *    правила про неё перестанут гаситься сами;
 *  - lessonFitsSurface(channel, surface) — годится ли правило этому каналу.
 * Записи в базе не трогаются: правило просто не подмешивается в промт. На экране
 * «Обучение бота» чип «в промте» читает тот же отбор и честно его не показывает.
 *
 * Отрицание («рассрочки нет», «не обещай ипотеку») — не противоречие, а повтор факта:
 * такие правила проходят. `\b` не используем: по кириллице он молчит (ai/wordBoundary.ts).
 */

export type LessonConflictReason =
  | "installments"
  | "mortgage"
  | "rent"
  | "guarantee"
  | "owner_bargaining"
  | "discount_size"
  | "commission"
  | "other_city"
  | "unbacked_promise"
  | "garbage";

/** Подписи для отчёта и журнала. */
export const LESSON_CONFLICT_LABELS: Record<LessonConflictReason, string> = {
  installments: "рассрочка (фактов: НЕТ)",
  mortgage: "ипотека / банки-партнёры (фактов: НЕТ)",
  rent: "аренда (аренды нет)",
  guarantee: "гарантии («всё чисто» не гарантируем)",
  owner_bargaining: "торг через встречу с собственником (торг ведёт агент)",
  discount_size: "размер скидки (называть нельзя)",
  commission: "комиссия не совпадает с фактами",
  other_city: "другой город (работаем только по Душанбе)",
  unbacked_promise: "срок, которого нет в фактах",
  garbage: "мусорная строка",
};

/** Отрицание рядом с ключевым словом: «нет», «не обещай», «никогда», «запрещено». */
const NEGATION_RE = new RegExp(
  `(?:${BW}нет${EW}|${BW}не\\s+(?:обещ|предлаг|упомин|говор|называ|сообща|подтвержда|сове?ту|гарантир|давай|дава)\\p{L}*|${BW}никогда${EW}|${BW}запрещ\\p{L}*|${BW}без\\s+обещ\\p{L}*|${BW}отсутству\\p{L}*|${BW}не\\s+занима\\p{L}*|${BW}не\\s+вед[её]м)`,
  "iu"
);

/** Сколько знаков вокруг ключевого слова смотрим на отрицание. */
const NEGATION_WINDOW = 40;

function negatedNear(text: string, index: number, length: number): boolean {
  const from = Math.max(0, index - NEGATION_WINDOW);
  const to = Math.min(text.length, index + length + NEGATION_WINDOW);
  // Окно не выходит за границы предложения: «нет денег сразу. Предложи рассрочку» —
  // отрицание из соседнего предложения не считается.
  const before = text.slice(from, index).split(/[.!?;\n]/).pop() ?? "";
  const after = text.slice(index + length, to).split(/[.!?;\n]/)[0] ?? "";
  // «Не гарантируй», «не предлагай рассрочку»: частица «не» прямо перед ключевым словом.
  const directNot = new RegExp(`${BW}не\\s+$`, "iu").test(before);
  return directNot || NEGATION_RE.test(before) || NEGATION_RE.test(after);
}

/** Есть ли в тексте НЕотрицаемое упоминание. */
function affirms(text: string, re: RegExp): boolean {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(global)) {
    if (!negatedNear(text, m.index ?? 0, m[0].length)) return true;
  }
  return false;
}

const INSTALLMENTS_RE = new RegExp(`${BW}(?:рассрочк\\p{L}*|trade[- ]?in|трейд[- ]?ин|муддатнок\\p{L}*|қарзи\\s+муддат\\p{L}*)`, "iu");
const MORTGAGE_RE = new RegExp(`${BW}(?:ипотек\\p{L}*|ипотеч\\p{L}*|банк\\p{L}*[- ]партн[её]р\\p{L}*|кредит\\p{L}*\\s+(?:в|через|от)\\s+банк\\p{L}*)`, "iu");
const RENT_RE = new RegExp(`${BW}(?:аренд\\p{L}*|иҷора\\p{L}*|сдать\\s+(?:в\\s+)?(?:наём|наем)|снять\\s+квартир\\p{L}*)`, "iu");
/** Совет искать на чужих площадках — всегда противоречие: «отказ — это весь ответ» (SCENARIO_RENT). */
const EXTERNAL_LISTINGS_RE = /somon|сомон\.?\s?tj|olx|телеграм[- ]?канал\p{L}*\s+(?:с|по|для)\s+аренд/iu;
const GUARANTEE_RE = new RegExp(`${BW}(?:гарант\\p{L}*|ручаемся|ручайтесь|кафолат\\p{L}*)`, "iu");
const OWNER_RE = new RegExp(`${BW}(?:собственник\\p{L}*|хозя\\p{L}*|соҳиб\\p{L}*)`, "iu");
const BARGAIN_RE = new RegExp(`${BW}(?:торг\\p{L}*|скидк\\p{L}*|снизить\\s+цен\\p{L}*|уступ\\p{L}*)`, "iu");
const MEETING_RE = new RegExp(`${BW}(?:встреч\\p{L}*|созвон\\p{L}*|свед\\p{L}*|познаком\\p{L}*|связать\\p{L}*|напрямую)`, "iu");
const DISCOUNT_SIZE_RE = /скидк\p{L}*[^.!?\n]{0,25}?\d+(?:[.,]\d+)?\s*(?:%|процент)|\d+(?:[.,]\d+)?\s*(?:%|процент\p{L}*)\s*скидк/iu;
const COMMISSION_PERCENT_RE = /комисси\p{L}*[^.!?\n]{0,40}?(\d+(?:[.,]\d+)?)\s*(?:%|процент)/giu;
const BUYER_RE = new RegExp(`${BW}покупател\\p{L}*`, "iu");
const OTHER_CITY_RE = new RegExp(
  `${BW}(?:худжанд\\p{L}*|хуҷанд\\p{L}*|вахдат\\p{L}*|турсунзод\\p{L}*|гиссар\\p{L}*|ҳисор\\p{L}*|бохтар\\p{L}*|куляб\\p{L}*|кулоб\\p{L}*|истаравшан\\p{L}*|пенджикент\\p{L}*|панҷакент\\p{L}*|рогун\\p{L}*|нурек\\p{L}*|курган[- ]тюб\\p{L}*)`,
  "iu"
);
/** Срок, которого нет в фактах: «ролик за 1–2 дня», «срок готовности». */
const UNBACKED_DEADLINE_RE = /срок\p{L}*\s+готовност\p{L}*|(?:ролик|видео|монтаж)\p{L}*[^.!?\n]{0,40}?\d+\s*[-–—]\s*\d+\s*(?:дн|час|сут)|(?:за|через)\s+\d+\s*[-–—]\s*\d+\s*(?:дн|сут)\p{L}*[^.!?\n]{0,30}(?:ролик|видео|монтаж)/iu;

/** Мусор: меньше шести букв или начинается со служебного знака («} his»). */
function isGarbage(text: string): boolean {
  const t = text.trim();
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (letters < 6) return true;
  if (/^[}\]{[)(<>|\\/`~^]/.test(t)) return true;
  // Правило без единой кириллической буквы — обрывок кода или чужого языка.
  return !/\p{Script=Cyrillic}/u.test(t);
}

/** Противоречит ли правило фактам компании. null — не противоречит. */
export function lessonConflict(text: string): LessonConflictReason | null {
  const t = text.normalize("NFC");
  if (isGarbage(t)) return "garbage";
  const f = AGENCY_FACTS;
  if (!f.installments && affirms(t, INSTALLMENTS_RE)) return "installments";
  if (!f.mortgage && affirms(t, MORTGAGE_RE)) return "mortgage";
  if (!f.rent && (EXTERNAL_LISTINGS_RE.test(t) || affirms(t, RENT_RE))) return "rent";
  if (!f.guarantees && affirms(t, GUARANTEE_RE)) return "guarantee";
  if (!f.botNamesDiscount && DISCOUNT_SIZE_RE.test(t)) return "discount_size";
  // Торг ведёт агент: свести клиента с собственником ради торга — против SALES_FACTS.
  for (const sentence of t.split(/[.!?;\n]/)) {
    if (OWNER_RE.test(sentence) && BARGAIN_RE.test(sentence) && MEETING_RE.test(sentence) && !NEGATION_RE.test(sentence)) {
      return "owner_bargaining";
    }
  }
  for (const m of t.matchAll(COMMISSION_PERCENT_RE)) {
    const value = Number(m[1].replace(",", "."));
    const sentence = t.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + m[0].length);
    const expected = BUYER_RE.test(sentence) ? f.commission.buyerPercent : f.commission.sellerPercent;
    if (value !== expected) return "commission";
  }
  if (!f.otherCities && affirms(t, OTHER_CITY_RE)) return "other_city";
  if (UNBACKED_DEADLINE_RE.test(t)) return "unbacked_promise";
  return null;
}

// ── каналы ────────────────────────────────────────────────────────────────────

/** Где правило окажется в промте. */
export type LessonSurface = "chat" | "voice" | "comments";

/** Каналы переписки (BotLesson.channel = Conversation.channel). */
const TEXT_CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "TELEGRAM", "WEBSITE", "FACEBOOK", "MESSENGER", "TIKTOK"]);

/**
 * ГОДИТСЯ ЛИ ПРАВИЛО КАНАЛУ (P0-2, «фильтр по каналу»).
 *  - chat — все: выводы из звонков агентов (kind call_answer, канал PHONE) учат чат
 *    говорить так, как говорят живые продавцы, — это решение владельца 07.08.2026;
 *  - voice — звонки (PHONE) и общие (сводки «ALL», ручные): правила переписки
 *    («пиши кириллицей», «пришли фото») голосу не про него;
 *  - comments (публичные ответы под постами) — без PHONE: сценарии частного звонка
 *    («возьми номер», «назови цену») в публичном ответе не годятся.
 */
export function lessonFitsSurface(channel: string | null | undefined, surface: LessonSurface): boolean {
  const ch = (channel ?? "").toUpperCase();
  if (surface === "chat") return true;
  if (surface === "voice") return !TEXT_CHANNELS.has(ch);
  return ch !== "PHONE";
}
