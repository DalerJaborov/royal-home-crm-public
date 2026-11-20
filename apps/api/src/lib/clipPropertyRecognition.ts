import { formatPropertyCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { normalizeForQuoteMatch } from "../ai/callQuoteCheck.js";

/**
 * К КАКОМУ ОБЪЕКТУ ЭТОТ РОЛИК (21.11.2026, владелец: «научи чтобы еще и ролики распознавала
 * сама по озвучке описанию или как то названию файла»).
 *
 * Одна дверь распознавания: имя файла, слова сотрудника и расшифровка звука ролика
 * сравниваются с активными объектами (не удалены, не проданы, не сняты — в монтаже и на
 * проверке тоже: ролик часто приходит раньше продажи). Без модели: признаки достаёт код
 * (номер объекта, цена, площадь, комнаты, этаж, район, микрорайон, ориентир), поэтому
 * результат проверяемый и тестируемый, а «похоже» всегда объяснено словами.
 *
 * НИКОГДА НЕ РЕШАЕТ САМА. Итог — до трёх кандидатов с причиной; прикрепление делает только
 * кнопка сотрудника (telegram/staffClip.ts). Похожих слишком много — кандидатов нет, есть
 * число: лучше спросить номер, чем показать три случайных из десяти.
 */

export type ClipSource = "filename" | "caption" | "speech";

export interface ClipTexts {
  filename?: string | null;
  caption?: string | null;
  transcript?: string | null;
}

export interface RecognitionProperty {
  id: string;
  shortId: number;
  address: string | null;
  landmark: string | null;
  rooms: number | null;
  floor: number | null;
  areaSqm: number;
  price: number;
  currency: string;
  districtId: string | null;
  updatedAt: Date;
}

export interface RecognitionDistrict {
  id: string;
  name: string;
  nameTj: string | null;
}

export interface ClipCandidate {
  propertyId: string;
  shortId: number;
  score: number;
  /** Что совпало, по-человечески: «номер 213 в имени файла», «район Сино», «цена 550 000». */
  reasons: string[];
  sources: ClipSource[];
}

export interface ClipRecognition {
  candidates: ClipCandidate[];
  /** Похожих больше трёх с одинаковым счётом — номер лучше спросить. */
  ambiguousCount: number | null;
}

export const CLIP_MAX_CANDIDATES = 3;
const MIN_SCORE = 30;

// ───────────────────────────── номер объекта ─────────────────────────────

/** Слово сразу после числа делает его не номером объекта: «3 комнаты», «5 этаж», «85 м2», «550 тыс». */
const UNIT_AFTER = /^\s*(?:\d{3}(?!\d)|[.,]\d|[-–]?\s*(?:х\s*)?(?:комн|ком(?!\p{L})|к(?!\p{L})|кк(?!\p{L})|этаж|эт(?!\p{L})|м2|м²|м(?!\p{L})|кв|квадрат|метр|сотк|тыс|млн|миллион|сомон|смн|сом(?!\p{L})|tjs|\$|usd|долл|хона|ҳуҷра|хучра|утоқ|ошён|ошен|хазор|ҳазор|мин|сек|шт|фото|ролик|мкр|микро|дом))/iu;

/** Имя файла камеры («IMG_1234», «VID_20261121_…», «PXL_…») и дата съёмки номером не считаются. */
const CAMERA_NAME = /^(?:img|vid|pxl|mvi|dsc|dji|gopr|mov|video|screen|rec|whatsapp|telegram|photo)[\s_-]/iu;

/** «213.mp4», «213 Сино.mp4», «213_1из3.mov», «obj-213», «ob213», «ОБ-213», «объект 213», «№213 финал». */
export function fileObjectNumber(filename: string | null | undefined): number | null {
  if (!filename) return null;
  const base = filename.replace(/\.[a-z0-9]{2,4}$/iu, "").trim();
  if (!base || CAMERA_NAME.test(base) || /^\d{7,}/u.test(base)) return null;
  const tagged = /^(?:obj(?:ect)?|ob|об(?:ъект(?:и)?)?|№|#)\s*[-_.]?\s*(\d{1,6})(?!\d)/iu.exec(base);
  if (tagged) return Number(tagged[1]);
  const leading = /^(\d{1,6})(?!\d)/u.exec(base);
  if (!leading) return null;
  if (UNIT_AFTER.test(base.slice(leading[0].length))) return null;
  return Number(leading[1]);
}

/**
 * Номер объекта, названный в тексте явно: «№213», «ОБ-213», «объект 213», «объекти 213»,
 * а в начале подписи — голое «213» (если дальше не единица: «3 комнаты» — не номер).
 * В расшифровке речи «номер двести тринадцать» после свёртки чисел — «номер 213».
 */
export function textObjectNumbers(text: string | null | undefined, opts: { leadingBare?: boolean } = {}): number[] {
  if (!text) return [];
  const found = new Set<number>();
  const tagged = /(?:^|[^\p{L}\p{N}])(?:№|#|об(?:ъект(?:и|а|у)?)?\.?|obj(?:ect)?)\s*[-_]?\s*(\d{1,6})(?!\d)/giu;
  for (const m of text.matchAll(tagged)) {
    const after = text.slice((m.index ?? 0) + m[0].length);
    if (!UNIT_AFTER.test(after)) found.add(Number(m[1]));
  }
  const spoken = normalizeForQuoteMatch(text);
  for (const m of spoken.matchAll(/(?:^| )(?:объект|объекта|объекти|номер|номери|раками|ракам)( )(\d{1,6})(?= |$)/gu)) {
    const after = spoken.slice((m.index ?? 0) + m[0].length);
    if (!UNIT_AFTER.test(after)) found.add(Number(m[2]));
  }
  if (opts.leadingBare) {
    const leading = /^\s*(\d{1,6})(?!\d)/u.exec(text);
    if (leading && !UNIT_AFTER.test(text.slice(leading[0].length))) found.add(Number(leading[1]));
  }
  return [...found].filter((n) => Number.isSafeInteger(n) && n > 0);
}

// ───────────────────────────── признаки из текста ─────────────────────────────

export interface ClipFacts {
  rooms: number | null;
  floor: number | null;
  areas: number[];
  prices: number[];
  microdistricts: number[];
  /** Слова текста в сравнимом виде (без регистра, таджикские буквы свёрнуты, числа цифрами). */
  tokens: string[];
}

const ROOM_WORDS: Array<[RegExp, number]> = [
  [/^(?:однушк|однокомнатн|1комнатн)/u, 1],
  [/^(?:двушк|двухкомнатн|двухкомн|2комнатн)/u, 2],
  [/^(?:трешк|трехкомнатн|трехкомн|3комнатн)/u, 3],
  [/^(?:четырехкомнатн|четырехкомн)/u, 4],
];

/** «1,5 млн» и «1.2 миллиона» — до свёртки чисел, иначе «1,5» склеится в 15. */
function expandMillions(text: string): string {
  return text.replace(/(\d+)[.,](\d{1,3})\s*(?:млн|миллион\p{L}*)/giu, (_, whole: string, frac: string) =>
    String(Math.round(Number(`${whole}.${frac}`) * 1_000_000)));
}

export function extractClipFacts(text: string | null | undefined): ClipFacts {
  const facts: ClipFacts = { rooms: null, floor: null, areas: [], prices: [], microdistricts: [], tokens: [] };
  if (!text?.trim()) return facts;
  const prepared = expandMillions(text)
    // «85,5 м2» — площадь с дробью: дробь отбрасываем (допуск сравнения полтора метра), иначе «85,5» склеится в 855.
    .replace(/(\d+)[.,]\d+(?=\s*(?:м2|м²|кв|квадрат|метр))/giu, "$1")
    .replace(/(\d+)\s*[кk](?![\p{L}])/giu, (_, n: string) => `${n} тысяч`);
  const tokens = normalizeForQuoteMatch(prepared).split(" ").filter(Boolean);
  facts.tokens = tokens;
  const num = (t: string | undefined) => (t && /^\d+$/u.test(t) ? Number(t) : null);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1] ?? "";
    const prev = tokens[i - 1] ?? "";
    for (const [re, n] of ROOM_WORDS) if (re.test(t)) facts.rooms ??= n;
    const glued = /^(\d{1,4})(м2|м²|кв|квм|мкр|мкрн)$/u.exec(t);
    if (glued) {
      const n = Number(glued[1]);
      if (glued[2]!.startsWith("мкр")) facts.microdistricts.push(n);
      else if (n >= 10 && n <= 3000) facts.areas.push(n);
      continue;
    }
    const n = num(t);
    if (n === null) continue;
    if (/^(?:комн|ком$|хона|хучра|утак|уток)/u.test(next) && n >= 1 && n <= 12) facts.rooms ??= n;
    else if (/^(?:этаж(?!н)|ошена|ошён)/u.test(next) && n >= 1 && n <= 60) facts.floor ??= n;
    else if (/^(?:этаж(?!н)|ошенаи)$/u.test(prev) && n >= 1 && n <= 60) facts.floor ??= n;
    else if (/^(?:м2|м²|кв|квм|квадрат|метр)/u.test(next) && n >= 10 && n <= 3000) facts.areas.push(n);
    else if (/^(?:мкр|мкрн|микрора)/u.test(next) && n >= 1 && n <= 200) facts.microdistricts.push(n);
    else if (/^(?:мкр|мкрн|микрора)/u.test(prev) && n >= 1 && n <= 200) facts.microdistricts.push(n);
    else if (n >= 10_000 && n <= 60_000_000 && t.length <= 8) facts.prices.push(n);
  }
  return facts;
}

// ───────────────────────────── сравнение с объектами ─────────────────────────────

const STOP_WORDS_RAW = [
  "рядом", "напротив", "против", "ориентир", "арентир", "улица", "улицы", "кучаи", "кучаи", "назди", "пеши", "кафои",
  "магазин", "магазина", "ресторан", "ресторана", "торговый", "центр", "центра", "дома", "район", "микрорайон", "махалаи",
  "проспект", "проспекта", "душанбе", "города", "больница", "клиника", "школа", "школы", "поворот", "метров", "здание",
  "нохияи", "кучаи", "бозори", "базара", "стадион", "квартира", "квартиры", "продается", "продаётся", "продажа",
];
/** Слова района, которые значат и другое (валюта «сомони», проспект Рудаки): только рядом со словом «район». */
const AMBIGUOUS_DISTRICT_TOKENS = new Set(["сомони", "рудаки"]);
/** Слова уже в сравнимом виде: «район» после свёртки букв — «раион». */
const DISTRICT_CONTEXT = /^(?:раион|раиона|раионе|нохия|нохияи|р)$/u;

const fold = (s: string) => normalizeForQuoteMatch(s).split(" ").filter(Boolean);
/** Стоп-слова в том же сравнимом виде, что и текст («район» → «раион»). */
const STOP_WORDS = new Set(STOP_WORDS_RAW.flatMap(fold));

function sharesStem(a: string, b: string): boolean {
  const need = Math.max(5, Math.min(a.length, b.length) - 2);
  if (a.length < need || b.length < need) return false;
  return a.slice(0, need) === b.slice(0, need);
}

function districtTokens(d: RecognitionDistrict): string[] {
  return [...new Set([...fold(d.name), ...fold(d.nameTj ?? "")])].filter((t) => t.length >= 4 && !/^(?:раион|нохияи|нохия)$/u.test(t));
}

/** Какие районы названы в тексте (id). */
export function districtsNamed(tokens: readonly string[], districts: readonly RecognitionDistrict[]): RecognitionDistrict[] {
  const named: RecognitionDistrict[] = [];
  for (const d of districts) {
    const hit = districtTokens(d).some((dt) => tokens.some((t, i) => {
      if (!(t === dt || (t.startsWith(dt) && t.length <= dt.length + 3) || (dt.length >= 6 && sharesStem(t, dt)))) return false;
      if (!AMBIGUOUS_DISTRICT_TOKENS.has(dt)) return true;
      return DISTRICT_CONTEXT.test(tokens[i - 1] ?? "") || DISTRICT_CONTEXT.test(tokens[i + 1] ?? "");
    }));
    if (hit) named.push(d);
  }
  return named;
}

const groupDigits = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");

interface SourceFacts { source: ClipSource; facts: ClipFacts; numbers: number[] }

/** Слова ориентира и адреса объекта, по которым его можно узнать (не общие слова, не цифры). */
function placeTokens(p: RecognitionProperty): string[] {
  return [...new Set(fold(`${p.landmark ?? ""} ${p.address ?? ""}`))].filter((t) => t.length >= 5 && !/\d/u.test(t) && !STOP_WORDS.has(t));
}
function placeMicrodistricts(p: RecognitionProperty): number[] {
  const out: number[] = [];
  const text = `${p.landmark ?? ""} ${p.address ?? ""}`.toLowerCase();
  for (const m of text.matchAll(/(\d{1,3})\s*-?\s*(?:й|ой|ый)?\s*(?:мкр|микрорайон)/gu)) out.push(Number(m[1]));
  return out;
}

const SOURCE_WORD: Record<ClipSource, string> = { filename: "имени файла", caption: "подписи", speech: "озвучке" };

/**
 * Чистая часть: признаки по источникам → кандидаты. `canUse` — может ли этот сотрудник
 * вести объект (кандидат, которого он выбрать не может, ему не показываем).
 */
export function scoreClipCandidates(
  texts: ClipTexts,
  properties: readonly RecognitionProperty[],
  districts: readonly RecognitionDistrict[],
  canUse: (p: RecognitionProperty) => boolean = () => true,
): ClipRecognition {
  const sources: SourceFacts[] = [];
  if (texts.filename) {
    const n = fileObjectNumber(texts.filename);
    const base = texts.filename.replace(/\.[a-z0-9]{2,4}$/iu, "").replace(/[_-]+/gu, " ");
    sources.push({ source: "filename", facts: extractClipFacts(CAMERA_NAME.test(texts.filename) ? "" : base), numbers: n ? [n] : [] });
  }
  if (texts.caption) sources.push({ source: "caption", facts: extractClipFacts(texts.caption), numbers: textObjectNumbers(texts.caption, { leadingBare: true }) });
  if (texts.transcript) sources.push({ source: "speech", facts: extractClipFacts(texts.transcript), numbers: textObjectNumbers(texts.transcript) });

  const tokenUse = new Map<string, number>();
  const tokensOf = new Map<string, string[]>();
  for (const p of properties) {
    const tokens = placeTokens(p);
    tokensOf.set(p.id, tokens);
    for (const t of tokens) tokenUse.set(t, (tokenUse.get(t) ?? 0) + 1);
  }
  const named = new Map<ClipSource, RecognitionDistrict[]>();
  for (const s of sources) named.set(s.source, districtsNamed(s.facts.tokens, districts));

  const scored: Array<ClipCandidate & { updatedAt: number; distinctive: boolean }> = [];
  for (const p of properties) {
    if (!canUse(p)) continue;
    let score = 0;
    let excluded = false;
    let distinctive = false;
    const reasons: string[] = [];
    const used = new Set<ClipSource>();
    const add = (points: number, reason: string, source: ClipSource, strong = false) => {
      score += points;
      if (!reasons.includes(reason)) reasons.push(reason);
      used.add(source);
      if (strong) distinctive = true;
    };
    for (const s of sources) {
      if (s.numbers.includes(p.shortId)) add(100, `номер ${p.shortId}`, s.source, true);
      const f = s.facts;
      if (f.prices.length) {
        const hit = f.prices.find((v) => Math.abs(v - p.price) <= p.price * 0.02);
        if (hit) add(35, `цена ${groupDigits(p.price)}${p.currency === "USD" ? " $" : ""}`, s.source, true);
        else if (f.prices.every((v) => Math.abs(v - p.price) > p.price * 0.15)) score -= 30;
      }
      if (f.areas.length) {
        const hit = f.areas.find((v) => Math.abs(v - p.areaSqm) <= Math.max(1.5, p.areaSqm * 0.03));
        if (hit) add(30, `площадь ${String(p.areaSqm).replace(".", ",")} м²`, s.source, true);
        else score -= 15;
      }
      if (f.rooms !== null && p.rooms !== null) {
        if (f.rooms === p.rooms) add(15, `${p.rooms} комн.`, s.source);
        else excluded = true;
      }
      if (f.floor !== null && p.floor !== null) {
        if (f.floor === p.floor) add(10, `${p.floor} этаж`, s.source);
        else score -= 15;
      }
      const ds = named.get(s.source) ?? [];
      if (ds.length && p.districtId) {
        const d = ds.find((x) => x.id === p.districtId);
        if (d) add(15, `район ${d.name.replace(/\s*\(район\)\s*/u, "")}`, s.source);
        else score -= 25;
      }
      const micro = placeMicrodistricts(p);
      const microHit = f.microdistricts.find((m) => micro.includes(m));
      if (microHit) add(20, `${microHit}-й микрорайон`, s.source, true);
      let placeHits = 0;
      for (const pt of tokensOf.get(p.id) ?? []) {
        if (placeHits >= 2) break;
        const use = tokenUse.get(pt) ?? 0;
        if (use > 5) continue;
        if (f.tokens.some((t) => sharesStem(t, pt))) {
          placeHits++;
          add(use <= 2 ? 20 : 10, `ориентир «${pt}»`, s.source, use <= 2);
        }
      }
    }
    if (excluded || score < MIN_SCORE || reasons.length === 0) continue;
    scored.push({ propertyId: p.id, shortId: p.shortId, score, reasons, sources: [...used], updatedAt: p.updatedAt.getTime(), distinctive });
  }
  scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  if (scored.length > CLIP_MAX_CANDIDATES) {
    const top = scored[0]!;
    const tied = scored.filter((c) => c.score === top.score).length;
    if (tied > CLIP_MAX_CANDIDATES && !top.distinctive) return { candidates: [], ambiguousCount: tied };
  }
  return {
    candidates: scored.slice(0, CLIP_MAX_CANDIDATES).map(({ updatedAt: _u, distinctive: _d, ...c }) => c),
    ambiguousCount: null,
  };
}

/** «по подписи и озвучке совпали: район Сино, 3 комн., цена 550 000». */
export function describeCandidate(c: ClipCandidate): string {
  const from = c.sources.map((s) => SOURCE_WORD[s]);
  const head = from.length ? `по ${from.join(" и ")} совпали` : "совпали";
  return `${formatPropertyCode(c.shortId)}: ${head} ${c.reasons.join(", ")}`;
}

/** Активные объекты: не удалены, не проданы, не сняты. Ролик бывает и до продажи (монтаж, проверка). */
const ACTIVE_WHERE = { deletedAt: null, status: { notIn: ["SOLD", "WITHDRAWN"] as never[] } };
const RECOGNITION_LIMIT = 3000;

/** Распознать объект по имени файла, подписи и расшифровке. Ничего не пишет. */
export async function recognizeClipProperty(
  texts: ClipTexts,
  canUse: (p: RecognitionProperty & { status: string; assignedAgentId: string | null; intakeAgentId: string | null; createdById: string | null }) => boolean = () => true,
): Promise<ClipRecognition> {
  if (!texts.filename && !texts.caption?.trim() && !texts.transcript?.trim()) return { candidates: [], ambiguousCount: null };
  const [rows, districts] = await Promise.all([
    prisma.property.findMany({
      where: ACTIVE_WHERE,
      select: {
        id: true, shortId: true, address: true, landmark: true, rooms: true, floor: true, areaSqm: true, price: true, currency: true,
        districtId: true, updatedAt: true, status: true, assignedAgentId: true, intakeAgentId: true, createdById: true,
      },
      orderBy: { updatedAt: "desc" },
      take: RECOGNITION_LIMIT,
    }),
    prisma.district.findMany({ select: { id: true, name: true, nameTj: true } }),
  ]);
  const properties = rows.map((r) => ({ ...r, status: String(r.status), areaSqm: Number(r.areaSqm), price: Number(r.price), currency: String(r.currency) }));
  return scoreClipCandidates(texts, properties, districts, canUse as (p: RecognitionProperty) => boolean);
}
