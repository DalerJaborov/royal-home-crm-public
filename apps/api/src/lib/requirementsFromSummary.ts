import type { PropertyType } from "@royal-home/shared";
import { BW, EW, TAIL } from "../ai/wordBoundary.js";

/**
 * «ВЗЯТЬ ИЗ РАЗГОВОРА» (владелец 20.11.2026, кадры карточки клиента с iPhone): «Всё о клиенте» говорит «Ищет: дом/участок,
 * 3-4 сотки, район Назди Сомон», а «Запрос покупателя» ниже — «Тип не указан · Бюджет не указан · Район не указан», и подбор
 * показывает всю базу подряд. Два блока одной карточки противоречили друг другу.
 *
 * Сводка клиента (`Client.aiInsight`, ai/scoring.ts) уже содержит строку «Ищет: …» — её составила модель по разговору. Здесь она
 * ТОЛЬКО разбирается обычным кодом, без нового вызова ИИ. Функция возвращает предложение; в поля оно попадает лишь по нажатию
 * кнопки человеком (`POST /clients/:id/requirements-suggestion/apply`, сервер считает предложение заново).
 *
 * Правило осторожности (ревью #338): лучше промолчать, чем записать выдумку. Поэтому:
 *  · пустые поля — и только они; записанное агентом не затирается;
 *  · неоднозначное («дом/участок») выбором за человека не становится: при двух разных типах тип не предлагается, а вся строка
 *    уходит словами в «Пожелания»; «3-4 комнаты» берётся как «от 3»;
 *  · отрицание («не в Шохмансуре») и «рядом с магазином» не считаются пожеланием;
 *  · бюджет — только число ВПЛОТНУЮ к валюте; названия районов, «до 5 этажа», «до 3 км» вырезаются до разбора; меньше
 *    10 000 сомони (1 000 $) бюджетом не считается.
 */
export interface RequirementsFields {
  desiredType?: PropertyType;
  desiredRooms?: number;
  budgetMin?: number;
  budgetMax?: number;
  currency?: "TJS" | "USD";
  desiredDistrictId?: string;
}

export interface RequirementsSuggestion {
  /** Что записать в пустые поля запроса. */
  fields: RequirementsFields;
  /** Строка «Ищет: …» слово в слово — дописывается к пожеланиям, если там её ещё нет. Только на сервере: клиенту не отдаётся. */
  notesLine: string | null;
  /** Короткие подписи для кнопки: «дом», «3 комн.», «до 500 000 с.», «Исмоили Сомони». Заметок и номеров тут нет. */
  labels: string[];
}

export interface RequirementsSnapshot {
  desiredType: PropertyType | null;
  desiredRooms: number | null;
  budgetMin: unknown;
  budgetMax: unknown;
  desiredDistrictId: string | null;
  hasDesiredPlaces: boolean;
  requirementsNotes: string | null;
}

const NEAR = /(?:рядом|около|возле|недалеко|близ|вблизи|поблизости)\s+(?:с|от|к)?\s*$/iu;
const NEGATION = /(?:^|[\s,;.(])(?:не|кроме|без)\s+(?:в|на|из|у)?\s*$/iu;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type TypeRule = { type: PropertyType; re: RegExp };
const TYPE_RULES: TypeRule[] = [
  { type: "APARTMENT", re: new RegExp(`${BW}квартир${TAIL}`, "giu") },
  { type: "HOUSE", re: new RegExp(`${BW}(?:дом|дома|дому|домом|коттедж${TAIL}|хавли${TAIL}|особняк${TAIL})${EW}`, "giu") },
  { type: "LAND", re: new RegExp(`${BW}(?:участ${TAIL}|сотк${TAIL}|земл${TAIL})`, "giu") },
  { type: "COMMERCIAL", re: new RegExp(`${BW}(?:коммерч${TAIL}|офис${TAIL}|склад${TAIL}|помещени${TAIL})`, "giu") },
];
const TYPE_LABELS: Record<PropertyType, string> = { APARTMENT: "квартира", HOUSE: "дом", LAND: "участок", COMMERCIAL: "коммерческая" };

/** Строка «Ищет: …» из сводки; нет — null. */
export function searchLineFromSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const match = /^\s*Ищет:\s*(.+?)\s*$/imu.exec(summary);
  return match?.[1]?.trim() || null;
}

const NUM = String.raw`(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(?:\s*(тыс\p{L}*\.?|млн|к|k)(?![\p{L}\p{N}]))?`;
const CUR = String.raw`\s*(?:сомони|смн|tjs|сом(?![\p{L}\p{N}])|\$|долл\p{L}*|usd|у\.\s?е\.)`;
const USD_WORD = /(?:\$|долл\p{L}*|usd|у\.\s?е\.)/iu;

function amountFrom(raw: string, unit: string | undefined): number | null {
  const n = Number(raw.replace(/[  ]/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (unit ?? "").toLowerCase();
  return Math.round(u.startsWith("млн") ? n * 1_000_000 : u.startsWith("тыс") || u === "к" || u === "k" ? n * 1000 : n);
}

/**
 * Бюджет из «до 500 тыс сомони», «от 300 до 400 тысяч сомони», «$60000». Валюта обязана стоять ВПЛОТНУЮ к числу; меньше
 * 10 000 сомони (1 000 $) — не бюджет. Текст ждёт уже без названий районов, этажей и километров (`stripNonMoney`).
 */
export function budgetFromText(text: string): { min?: number; max?: number; currency: "TJS" | "USD" } | null {
  const enough = (value: number, currency: "TJS" | "USD") => value >= (currency === "USD" ? 1000 : 10_000);
  const currencyOf = (chunk: string): "TJS" | "USD" => (USD_WORD.test(chunk) ? "USD" : "TJS");
  const range = new RegExp(`${BW}от\\s*${NUM}${UNIT}\\s*до\\s*${NUM}${UNIT}${CUR}`, "iu").exec(text);
  if (range) {
    const currency = currencyOf(range[0]);
    const min = amountFrom(range[1], range[2] ?? range[4]), max = amountFrom(range[3], range[4]);
    if (min && max && max >= min && enough(max, currency)) return { min: enough(min, currency) ? min : undefined, max, currency };
  }
  const single = new RegExp(`(?:${BW}(до|от)\\s*)?(?:\\$\\s*${NUM}${UNIT}|${NUM}${UNIT}${CUR})`, "iu").exec(text);
  if (single) {
    const raw = single[2] ?? single[4];
    const unit = single[2] ? single[3] : single[5];
    const value = raw ? amountFrom(raw, unit) : null;
    const currency = currencyOf(single[0]);
    if (value && enough(value, currency)) return (single[1] ?? "").toLowerCase() === "от" ? { min: value, currency } : { max: value, currency };
  }
  return null;
}

/** Вырезает то, что похоже на деньги, но ими не является: названия районов, «5 этажа», «3 км», «60 м²», «сотки», «комнаты». */
function stripNonMoney(text: string, districtNames: ReadonlyArray<string>): string {
  return withoutDistricts(text, districtNames)
    .replace(new RegExp(`\\d+(?:[.,]\\d+)?\\s*[-–]?\\s*(?:этаж${TAIL}|км${EW}|километр${TAIL}|м²|м2|кв\\.?\\s*м${TAIL}|метр${TAIL}|сотк${TAIL}|мин${TAIL}|комн${TAIL})`, "giu"), " ");
}

function withoutDistricts(text: string, districtNames: ReadonlyArray<string>): string {
  let out = text;
  for (const name of districtNames) if (name.trim()) out = out.replace(new RegExp(`${BW}${escapeRe(name.trim())}${TAIL}`, "giu"), " ");
  return out;
}

function normalizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** Заметки уже говорят то же самое (все слова от четырёх букв и все числа строки есть в них): повторно не дописываем. */
export function notesAlreadyHave(notes: string | null | undefined, line: string): boolean {
  if (!notes?.trim()) return false;
  const have = normalizeWords(notes);
  const wanted = normalizeWords(line).filter((w) => w.length >= 4 || /\d/.test(w));
  return wanted.length > 0 && wanted.every((w) => have.some((h) => h === w || (h.length >= 4 && w.length >= 4 && h.slice(0, 5) === w.slice(0, 5))));
}

const nearBefore = (text: string, index: number) => NEAR.test(text.slice(Math.max(0, index - 24), index));

export function suggestRequirements(
  summary: string | null | undefined,
  current: RequirementsSnapshot,
  districts: ReadonlyArray<{ id: string; name: string }>,
): RequirementsSuggestion | null {
  const line = searchLineFromSummary(summary);
  if (!line) return null;
  const fields: RequirementsFields = {};
  const labels: string[] = [];
  const names = districts.map((d) => d.name);

  // Район: по позиции в тексте (названный раньше побеждает); отрицание и «рядом с …» пожеланием не считаются.
  if (!current.desiredDistrictId && !current.hasDesiredPlaces) {
    let hit: { at: number; id: string; name: string } | null = null;
    for (const d of districts) {
      const name = d.name.trim();
      if (!name) continue;
      for (const m of line.matchAll(new RegExp(`${BW}${escapeRe(name)}${TAIL}`, "giu"))) {
        if (NEGATION.test(line.slice(Math.max(0, m.index - 16), m.index)) || nearBefore(line, m.index)) continue;
        if (!hit || m.index < hit.at) hit = { at: m.index, id: d.id, name };
        break;
      }
    }
    if (hit) { fields.desiredDistrictId = hit.id; labels.push(hit.name); }
  }

  if (!current.desiredType) {
    const typeText = withoutDistricts(line, names);
    const found = new Set<PropertyType>();
    for (const rule of TYPE_RULES) {
      for (const m of typeText.matchAll(rule.re)) {
        if (nearBefore(typeText, m.index)) continue;
        found.add(rule.type);
        break;
      }
    }
    // Два разных типа в одной строке («дом/участок», «дом, 3 сотки») — выбор за человека не делаем.
    if (found.size === 1) { const [type] = [...found]; fields.desiredType = type; labels.push(TYPE_LABELS[type]); }
  }

  if (!current.desiredRooms) {
    const text = withoutDistricts(line, names);
    const range = new RegExp(`${BW}(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})\\s*[-–]?\\s*(?:комн${TAIL}|ком\\.|к${EW})`, "iu").exec(text);
    const single = new RegExp(`${BW}(\\d{1,2})\\s*[-–]?\\s*(?:комн${TAIL}|ком\\.|к${EW})`, "iu").exec(text);
    // «3-4 комнаты» — это «от 3»: берём меньшее, полная строка остаётся словами в «Пожеланиях».
    const n = range ? Math.min(Number(range[1]), Number(range[2])) : single ? Number(single[1]) : 0;
    if (n >= 1 && n <= 20) { fields.desiredRooms = n; labels.push(`${n} комн.`); }
  }

  if (current.budgetMin == null && current.budgetMax == null) {
    const budget = budgetFromText(stripNonMoney(line, names));
    if (budget) {
      if (budget.min) fields.budgetMin = budget.min;
      if (budget.max) fields.budgetMax = budget.max;
      fields.currency = budget.currency;
      const unit = budget.currency === "USD" ? "$" : "с.";
      const fmt = (n: number) => n.toLocaleString("ru-RU").replace(/[  ]/g, " ");
      labels.push(budget.min && budget.max ? `${fmt(budget.min)}–${fmt(budget.max)} ${unit}` : budget.max ? `до ${fmt(budget.max)} ${unit}` : `от ${fmt(budget.min!)} ${unit}`);
    }
  }

  // Слова клиента целиком — в «Пожелания»: сотки, неназванный в справочнике район и прочее не теряются.
  const notesLine = notesAlreadyHave(current.requirementsNotes, line) ? null : line;
  const named = !fields.desiredDistrictId && !current.desiredDistrictId ? /район\s+([А-ЯЁA-Z][^,.;]*)/u.exec(line) : null;
  if (!Object.keys(fields).length && !notesLine) return null;
  if (notesLine && named) labels.push(named[1].trim());
  if (!labels.length) labels.push("пожелания словами");
  return { fields, notesLine, labels };
}
