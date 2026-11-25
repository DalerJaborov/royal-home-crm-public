/**
 * РЕЕСТР РАЗРЕШЁННЫХ СТРОЕК ДУШАНБЕ (memor.pro, решение владельца 20.11.2026).
 *
 * ТОЛЬКО ДЛЯ СОТРУДНИКОВ CRM. Эти данные не уходят на сайт, клиентскому боту, в рекламу и
 * публичные ответы (охраняет apps/api/tests/construction-registry-private.test.ts). Здесь
 * живут правила, которые считают и сервер, и экран: подписи цветов, рейтинг застройщика,
 * нормализация имени, оценка совпадения реестра с нашим объектом. Одно место, как money/geo.
 *
 * Ничего не выдумываем: рейтинг считается только из фактов реестра (цвет проекта, год решения),
 * а нет данных — так и пишется («мало данных»), без числа с потолка.
 */
import { z } from "zod";
import { distanceMeters } from "./geo.js";

export type RegistryColor = "green" | "yellow" | "red";

export const REGISTRY_COLORS: readonly RegistryColor[] = ["green", "yellow", "red"];

export function isRegistryColor(value: unknown): value is RegistryColor {
  return value === "green" || value === "yellow" || value === "red";
}

/** Подписи цветов простыми словами, одни и те же в карточке, на карте и в уведомлении. */
export const REGISTRY_COLOR_LABEL: Record<RegistryColor, { title: string; hint: string; warning: string | null }> = {
  green: {
    title: "Разрешение есть",
    hint: "В реестре документы на стройку полные: разрешение на начало работ выдано.",
    warning: null,
  },
  yellow: {
    title: "В согласовании",
    hint: "Разрешающие документы ещё оформляются. Реестр отмечает такие проекты жёлтым.",
    warning: "Документы ещё оформляются. Клиенту называйте это как данные реестра и не обещайте, что разрешение будет.",
  },
  red: {
    title: "Разрешения нет",
    hint: "В реестре нет разрешения на строительство или заключения экспертизы.",
    warning:
      "Реестр отмечает проект красным: нет разрешения или экспертизы. Договор долевого участия до оформления документов не рекомендуется, предупредите клиента.",
  },
};

/** Подпись под любым блоком реестра: откуда данные и до какой даты они свежие. */
export function registrySourceCaption(updatedAt: Date | string | null): string {
  const base = "По данным реестра Сарраёсати меъморӣ ва шаҳрсозӣ Душанбе";
  if (!updatedAt) return `${base} (дата обновления неизвестна)`;
  const date = registryUpdatedDate(updatedAt);
  return date ? `${base} на ${date}` : base;
}

/** Дата обновления реестра «ДД.ММ.ГГГГ» по Душанбе (UTC+5), не по часовому поясу браузера; null — даты нет. */
export function registryUpdatedDate(updatedAt: Date | string | null): string | null {
  if (!updatedAt) return null;
  const d = typeof updatedAt === "string" ? new Date(updatedAt) : updatedAt;
  if (Number.isNaN(d.getTime())) return null;
  const dushanbe = new Date(d.getTime() + 5 * 3_600_000);
  const dd = String(dushanbe.getUTCDate()).padStart(2, "0");
  const mm = String(dushanbe.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${dushanbe.getUTCFullYear()}`;
}

// ───────────────────────── Нормализация имени застройщика ─────────────────────────

/** Таджикские буквы приводятся к русским основам: «Ҷамол» и «Чамол» — одно и то же имя. */
const TAJIK_FOLD: Record<string, string> = { ҷ: "ч", ҳ: "х", қ: "к", ғ: "г", ӣ: "и", ӯ: "у", ё: "е" };

function fold(raw: string): string {
  return raw.toLowerCase().replace(/[ҷҳқғӣӯё]/g, (ch) => TAJIK_FOLD[ch] ?? ch);
}

/** Организационные формы, которые не отличают одного застройщика от другого (уже в свёрнутом виде). */
const LEGAL_FORMS = new Set(
  ["ҷдмм", "ҷсп", "ҷс", "ҷмм", "ооо", "оао", "зао", "одо", "оо", "чп", "ип", "ҷдс", "ҷк", "ҷсҳ", "чдмм", "чсп"].map(fold),
);

/**
 * Имя застройщика для сравнения и группировки: без «ҶДММ «…»», кавычек, знаков и регистра.
 * «ҶДММ «Дурахшон иншоот»» и «Дурахшон  Иншоот» дают одно и то же.
 */
export function normalizeDeveloperName(raw: string): string {
  const s = fold(raw).replace(/[«»"'“”„‘’`().,;:_\-–—/\\]/g, " ");
  const words = s.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !LEGAL_FORMS.has(w));
  return (kept.length > 0 ? kept : words).join(" ").trim();
}

// ───────────────────────── Рейтинг застройщика ─────────────────────────

export interface RatedProject {
  color: RegistryColor;
  /** Год решения мэра из номера (1-2020 → 2020); null, если не разобрался. */
  decisionYear: number | null;
}

export type DeveloperLetter = "A" | "B" | "C" | "D";

export interface DeveloperRating {
  total: number;
  green: number;
  yellow: number;
  red: number;
  /** Красные проекты, у которых решению два года и больше, а документов так и нет. */
  staleRed: number;
  /** Год самого раннего решения в реестре; null, если нигде не указан. */
  sinceYear: number | null;
  /** 0–100; null — данных мало, оценку не выдаём (но факты показываем). */
  score: number | null;
  letter: DeveloperLetter | null;
  /** Почему такая оценка: одна короткая фраза на составляющую, без «магии». */
  reasons: string[];
}

/** Меньше стольких проектов — буква не ставится: по одному-двум проектам оценка была бы выдумкой. */
export const RATING_MIN_PROJECTS = 3;
/** Решению мэра два года и больше, а цвет красный — штраф «затянутый проект». */
export const RATING_STALE_YEARS = 2;
export const RATING_STALE_RED_PENALTY = 5;
export const RATING_STALE_RED_PENALTY_CAP = 20;
/** Пороги букв по баллу. */
export const RATING_LETTER_MIN: Record<DeveloperLetter, number> = { A: 85, B: 65, C: 40, D: 0 };

/** Год решения из номера «524-2024» → 2024; «1-2020-Б» → 2020. */
export function decisionYearFromQaror(qaror: string): number | null {
  const m = /-(\d{4})(?:\D|$)/.exec(qaror);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 2000 && year <= 2100 ? year : null;
}

export function letterForScore(score: number): DeveloperLetter {
  if (score >= RATING_LETTER_MIN.A) return "A";
  if (score >= RATING_LETTER_MIN.B) return "B";
  if (score >= RATING_LETTER_MIN.C) return "C";
  return "D";
}

/**
 * Рейтинг застройщика только из фактов реестра.
 * Балл = доля «хороших» проектов: зелёный весит 1, жёлтый 0,5, красный 0; минус 5 баллов (но не больше 20)
 * за каждый красный проект, которому уже два года и больше. Мало проектов (меньше 3) — буква не ставится.
 */
export function rateDeveloper(projects: readonly RatedProject[], now: Date = new Date()): DeveloperRating {
  const total = projects.length;
  let green = 0;
  let yellow = 0;
  let red = 0;
  let staleRed = 0;
  let sinceYear: number | null = null;
  const currentYear = new Date(now.getTime() + 5 * 3_600_000).getUTCFullYear();
  for (const p of projects) {
    if (p.color === "green") green += 1;
    else if (p.color === "yellow") yellow += 1;
    else {
      red += 1;
      if (p.decisionYear !== null && currentYear - p.decisionYear >= RATING_STALE_YEARS) staleRed += 1;
    }
    if (p.decisionYear !== null && (sinceYear === null || p.decisionYear < sinceYear)) sinceYear = p.decisionYear;
  }

  if (total === 0) {
    return { total, green, yellow, red, staleRed, sinceYear, score: null, letter: null, reasons: ["В реестре проектов этого застройщика нет."] };
  }
  const reasons: string[] = [];
  reasons.push(`Проектов в реестре: ${total}.`);
  reasons.push(`С разрешением (зелёные): ${green} из ${total}.`);
  if (yellow > 0) reasons.push(`В согласовании (жёлтые): ${yellow}.`);
  reasons.push(red > 0 ? `Без разрешения или экспертизы (красные): ${red}.` : "Красных проектов нет.");
  if (staleRed > 0) reasons.push(`Из красных затянуты на ${RATING_STALE_YEARS} года и больше: ${staleRed}.`);
  if (sinceYear !== null) reasons.push(`Первое решение мэра в реестре: ${sinceYear} год.`);

  if (total < RATING_MIN_PROJECTS) {
    reasons.push(`Мало данных: оценка ставится от ${RATING_MIN_PROJECTS} проектов.`);
    return { total, green, yellow, red, staleRed, sinceYear, score: null, letter: null, reasons };
  }
  const base = ((green + yellow * 0.5) / total) * 100;
  const penalty = Math.min(staleRed * RATING_STALE_RED_PENALTY, RATING_STALE_RED_PENALTY_CAP);
  const score = Math.max(0, Math.min(100, Math.round(base - penalty)));
  return { total, green, yellow, red, staleRed, sinceYear, score, letter: letterForScore(score), reasons };
}

// ───────────────────────── Сопоставление с нашим объектом ─────────────────────────

/**
 * Радиусы, метры. Менять только вместе с тестом.
 *  - strong: до него связываем само по названию застройщика или по улице у новостройки;
 *  - addressed: до него связываем само, только если совпали И улица, И номер дома на ней (точка в CRM часто
 *    поставлена геокодером по адресу и уезжает на сотню метров; номер дома — свидетельство сильнее расстояния);
 *  - candidate: дальше — не предлагаем вовсе.
 */
export const MATCH_RADIUS_M = { strong: 80, addressed: 150, candidate: 250 } as const;

export type RegistryMatchLevel = "auto" | "suggest" | "none";

export interface RegistryMatchInput {
  /** Наш объект. */
  property: {
    lat: number | null;
    lng: number | null;
    address: string | null;
    title: string;
    description: string | null;
    isNewBuilding: boolean;
  };
  /** Проект реестра. */
  project: { lat: number; lng: number; address: string | null; customer: string };
}

export interface RegistryMatch {
  level: RegistryMatchLevel;
  /** 0–100. Показывается агенту как «насколько уверены». */
  confidence: number;
  distanceM: number | null;
  /** Простыми словами, на чём основано совпадение. */
  reasons: string[];
}

/**
 * АДРЕС ПО-ТАДЖИКСКИ И ПО-РУССКИ (25.11.2026). Реестр пишет «кӯчаи М. Турсунзода №7 ва №9», CRM — «улица Мирзо Турсунзаде, 9».
 * Сравниваем не строки, а пары «улица → её номера домов»: номер, перечисленный у другой улицы того же проекта, не считается.
 *  - слова-указатели (кӯчаи/хиёбони/гузаргоҳи/улица/проспект…) отбрасываются и начинают новую улицу;
 *  - после «ноҳияи/район/шаҳри» и «квартираҳои/хонаҳои/ҳуҷраҳои/блоки…» номера — не номера домов: до следующей улицы пропускаем;
 *  - перечисления и диапазоны: «№№8, 10-15, 11 ва 13» → 8, 10…15, 11, 13; «20-А» → 20а; «Қазоқон-1» → слово и номер;
 *  - буквы: ӣ→и, ӯ→у, ғ→г, қ→к, ҳ→х, ҷ→ч, ё→е, а русское «дж» → «ч» (Джалол = Ҷалол).
 * Улицы совпадают точно, по началу слова (Карамова = Карамов, Садриддина = Садриддин) или по «костяку» согласных
 * (Турсунзаде = Турсунзода, Казакон = Қазоқон). Совпадение по костяку — догадка транслитерации: для автосвязи
 * ему нужен ещё и общий номер дома (см. scoreRegistryMatch).
 */

/** Слова, которые начинают новую улицу и сами ничего не отличают (уже в свёрнутом виде). */
const STREET_MARKERS = new Set([
  "улица", "ул", "улицы", "проспект", "пр", "переулок", "пер", "проезд", "тупик", "бульвар", "шоссе", "микрорайон", "мкр", "мкрн",
  "кучаи", "куча", "кучахои", "кучахо", "хиебони", "хиебон", "гузаргохи", "гузаргох", "гузаргоххои", "гузаргоххо",
  "махаллаи", "махалла", "к", "квартал",
]);

/** После этих слов номера — не номера домов (квартиры, комнаты, корпуса) или дальше район и город: до следующей улицы пропускаем. */
const SKIP_MARKERS = new Set([
  "нохияи", "нохия", "район", "шахри", "шахр", "город", "квартирахои", "квартираи", "квартира", "квартиры", "кв",
  "хонахои", "хонаи", "хучрахои", "хучраи", "хучра", "блоки", "блок", "блокхо", "манзилхои", "манзили", "корпус", "подъезд", "этаж",
]);

/** После этого слова номера уже не дома: этаж, комнаты, подъезд, квартира, площадь (до следующей улицы). */
const NOT_HOUSE_WORD = /^(этаж|эт$|комн|ком$|подъезд|кв$|квартир|сотк|сот$|м2|кабат|ошена|хучр)/;
/** Число ПЕРЕД этим словом — не номер дома: «9 этаж», «3-комнатная», «60 м2». Квартиры сюда не входят: «№6 квартираҳои». */
const NUMBER_BEFORE_NOT_HOUSE = /^(этаж|эт$|комн|ком$|сотк|сот$|м2|кабат|ошена)/;

/**
 * Названия районов Душанбе: без указателя улицы перед ними это район, а не улица («Сино, Айни 12»). После «кӯчаи/улица»
 * («проспект Исмоили Сомони») они остаются словами улицы.
 */
const DISTRICT_WORDS = new Set(["сино", "синои", "шохмансур", "шохмансури", "фирдавси", "фирдавсии", "исмоили", "сомони", "сомонии"]);

/** Слова адреса, которые не отличают одну улицу от другой. */
const ADDRESS_NOISE = new Set([
  "дом", "душанбе", "собик", "бинои", "назди", "пеши", "напротив", "рядом", "возле", "ориентир", "буриши", "кисмати",
  "шимолу", "шарки", "шимоли", "чануби", "гарби", "истикомати", "истикоматии", "шахсии", "баландошена", "сохтмони", "сохтмонаш",
  "иншоотхои", "нотамоми", "мавчудаи", "номер", "здание",
]);

/** Сворачивает таджикские буквы, регистр и русское «дж» (= ҷ). */
function foldAddress(raw: string): string {
  return fold(raw).replace(/дж/g, "ч");
}

const NUMBER_TOKEN = /^\d{1,4}(?:\/\d{1,4})?[а-яa-z]?$/;
/** Диапазон «10-15» раскрываем только короткий: «1-2020» или «8-100» — не перечень домов. */
const MAX_RANGE_SPAN = 30;

export interface AddressSegment {
  /** Слова названия улицы (свёрнутые, от 4 букв). */
  words: string[];
  /** Номера домов этой улицы: «12», «20а», «61/3». */
  numbers: string[];
}

/** Разбор адреса на улицы и их номера домов. Адрес без названия улицы — пустой список. */
export function addressSegments(raw: string | null | undefined): AddressSegment[] {
  if (!raw) return [];
  const text = foldAddress(raw)
    // Буква корпуса в кавычках сразу за номером («31"а"», «13 «г»», «36”а”») — часть номера: 31а, 13г, 36а.
    .replace(/(\d)\s*[«"'“”„‘’`]\s*([а-яa-z])\s*[»"'“”„‘’`]/g, "$1$2")
    // «56г. Душанбе», «12д.»: буква с точкой сразу за номером — сокращение (город, дом), а не корпус.
    .replace(/(\d)([гдкшип])\.(?=\s*[а-яa-z])/g, "$1 $2.")
    // Прочие кавычки, скобки и знаки номера — в сторону.
    .replace(/[«»"'“”„‘’`()[\]{}№#]/g, " ")
    // «20-А» → «20а»: буква корпуса пишется и через дефис (одна буква, дальше не буква).
    .replace(/(\d)\s*-\s*([а-яa-z])(?![а-яa-z])/g, "$1$2")
    // «10-15» → диапазон (раскроем ниже); прочие дефисы — разделители («Қазоқон-1», «1-ум»).
    .replace(/(\d)\s*-\s*(\d)/g, "$1~$2")
    .replace(/[.,;:\\!?+=*_–—-]/g, " ");
  // Отдельно стоящую букву к номеру НЕ клеим (ревью 25.11.2026): «Айни 56 к 2», «Турсунзода 7 и 9», «56, г. Душанбе» —
  // это корпус, союз, город, а не дом «56к», «7и», «56г». Корпус пишут слитно («20а»), через дефис или в кавычках.
  const tokens = text.split(/\s+/).filter(Boolean);

  const segments: AddressSegment[] = [];
  let current: AddressSegment = { words: [], numbers: [] };
  let skipping = false;
  /** Текущая улица открыта указателем («кӯчаи», «улица»): тогда название района в ней — часть названия улицы. */
  let openedByMarker = false;
  const flush = () => {
    if (current.words.length > 0 || current.numbers.length > 0) segments.push(current);
    current = { words: [], numbers: [] };
    openedByMarker = false;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (STREET_MARKERS.has(t)) {
      flush();
      skipping = false;
      openedByMarker = true;
      continue;
    }
    if (SKIP_MARKERS.has(t) || NOT_HOUSE_WORD.test(t)) {
      skipping = true;
      continue;
    }
    if (/^\d/.test(t)) {
      if (skipping) continue;
      // «9 этаж», «3-комнатная», «60 м2» — число не номер дома.
      const next = tokens[i + 1];
      if (next && NUMBER_BEFORE_NOT_HOUSE.test(next)) continue;
      const range = /^(\d{1,4})~(\d{1,4})$/.exec(t);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        if (b > a && b - a <= MAX_RANGE_SPAN) for (let n = a; n <= b; n += 1) current.numbers.push(String(n));
        else current.numbers.push(String(a), String(b));
        continue;
      }
      // «5/а» → «5а»; обломки распознавания («2}7», «91,0») на номер не похожи — не берём, чтобы не совпасть случайно.
      const n = t.replace(/\/([а-яa-z])$/, "$1");
      if (NUMBER_TOKEN.test(n)) current.numbers.push(n);
      continue;
    }
    if (ADDRESS_NOISE.has(t) || t.length < 4 || !/^[а-яa-z]/.test(t)) continue;
    // Новое слово после номеров — уже следующая улица («…Шоҳин 27, 29 … Одинаев №43»).
    if (current.numbers.length > 0) flush();
    // Слово после «ноҳияи/район» — название района, а не улицы.
    if (skipping) continue;
    // Район без указателя улицы («Сино, Айни 12») — не улица.
    if (DISTRICT_WORDS.has(t) && !openedByMarker) continue;
    current.words.push(t);
  }
  flush();
  return segments.filter((s) => s.words.length > 0);
}

/** Плоский список слов и номеров адреса (подписи и старые вызовы). */
export function addressTokens(raw: string | null | undefined): { words: string[]; numbers: string[] } {
  const segments = addressSegments(raw);
  return { words: segments.flatMap((s) => s.words), numbers: segments.flatMap((s) => s.numbers) };
}

/** «Костяк» слова: согласные без х/й/ь/ъ, сдвоенные схлопнуты. Турсунзаде и Турсунзода → «трснзд». */
function consonantSkeleton(word: string): string {
  return word.replace(/[аеиоуыэюяхйьъ]/g, "").replace(/(.)\1+/g, "$1");
}

/** Расстояние правки (вставка, удаление, замена буквы); короткие слова, поэтому простая таблица. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Как совпали два слова улицы: точно (в том числе с падежной концовкой) или только по написанию («fuzzy»): тот же костяк
 * согласных И не больше двух правок (Турсунзаде/Турсунзода, Казакон/Қазоқон). Разные фамилии с одним костяком
 * (Хусейнзода/Хасанзода, Назарова/Нозиров) правкам не проходят; что прошло (Карамова/Каримов) — только «fuzzy»,
 * и автосвязь по нему ставится лишь вблизи и с номером дома (scoreRegistryMatch).
 */
export function streetWordMatch(a: string, b: string): "exact" | "fuzzy" | null {
  if (a === b) return "exact";
  if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return "exact";
  const skeleton = consonantSkeleton(a);
  if (skeleton.length >= 4 && a[0] === b[0] && skeleton === consonantSkeleton(b) && editDistance(a, b) <= 2) return "fuzzy";
  return null;
}

export interface AddressAgreement {
  /** Есть общая улица. */
  street: boolean;
  /** Улица совпала только по костяку согласных (другое написание): без номера дома это догадка. */
  streetFuzzy: boolean;
  /** Совпал номер дома, названный именно у общей улицы. */
  house: boolean;
  /** Улица общая, у обеих сторон на ней названы номера, но ни один не совпал: скорее соседний дом. */
  houseConflict: boolean;
}

/** Совпадение адресов: общая улица и номер дома, названный именно у этой улицы. */
export function addressAgreement(a: string | null | undefined, b: string | null | undefined): AddressAgreement {
  const sa = addressSegments(a);
  const sb = addressSegments(b);
  let street = false;
  let exactStreet = false;
  let house = false;
  let numbersOnBothSides = false;
  for (const x of sa) {
    for (const y of sb) {
      let kind: "exact" | "fuzzy" | null = null;
      for (const w of x.words) {
        for (const v of y.words) {
          const m = streetWordMatch(w, v);
          if (m === "exact") kind = "exact";
          else if (m === "fuzzy" && kind === null) kind = "fuzzy";
        }
      }
      if (!kind) continue;
      street = true;
      if (kind === "exact") exactStreet = true;
      if (x.numbers.length > 0 && y.numbers.length > 0) {
        numbersOnBothSides = true;
        if (x.numbers.some((n) => y.numbers.includes(n))) house = true;
      }
    }
  }
  return { street, streetFuzzy: street && !exactStreet, house, houseConflict: street && numbersOnBothSides && !house };
}

/** Назван ли застройщик в тексте нашей карточки. Короткие имена (<5 букв) не считаем: ложные совпадения. */
export function developerMentioned(customer: string, ...texts: (string | null | undefined)[]): boolean {
  const name = normalizeDeveloperName(customer);
  if (name.length < 5) return false;
  const haystack = normalizeDeveloperName(texts.filter(Boolean).join(" "));
  // По границам слов: «Рудаки» внутри «Рудакинский» не считается названием застройщика.
  return ` ${haystack} `.includes(` ${name} `);
}

/**
 * Оценка: «связать само», «предложить агенту» или «не похоже».
 * Не домысливаем: без точки у объекта — «не похоже»; одно только расстояние — не повод связывать.
 *  - auto до 80 м: застройщик назван; ИЛИ совпали улица и номер дома на ней; ИЛИ новостройка на той же улице, если
 *    улица совпала не только по написанию-догадке и номера домов не противоречат друг другу;
 *  - auto до 150 м: только улица (точно, не по написанию-догадке) И номер дома на ней (точка могла уехать от геокодера);
 *  - suggest: до 250 м и есть хотя бы один признак (новостройка, улица, дом, застройщик): агент подтверждает.
 * Номера домов у обеих сторон есть, но разные («Айни 56» против «Айнӣ №58 ва 60») — это соседний дом: только предложение.
 */
export function scoreRegistryMatch(input: RegistryMatchInput): RegistryMatch {
  const { property: p, project: r } = input;
  if (p.lat === null || p.lng === null) return { level: "none", confidence: 0, distanceM: null, reasons: [] };
  const distance = Math.round(distanceMeters(p.lat, p.lng, r.lat, r.lng));
  if (distance > MATCH_RADIUS_M.candidate) return { level: "none", confidence: 0, distanceM: distance, reasons: [] };

  const addr = addressAgreement(p.address, r.address);
  const named = developerMentioned(r.customer, p.title, p.description);
  const reasons: string[] = [`Расстояние до стройки по реестру: ${distance} м.`];
  let confidence = distance <= 30 ? 50 : distance <= MATCH_RADIUS_M.strong ? 40 : 20;
  if (addr.street) {
    confidence += addr.streetFuzzy ? 15 : 20;
    reasons.push(addr.streetFuzzy ? "Улица в адресе похожа на улицу в реестре (другое написание)." : "Улица в адресе совпадает с реестром.");
  }
  if (addr.house) {
    confidence += 15;
    reasons.push("Номер дома совпадает с реестром.");
  }
  if (addr.houseConflict) {
    confidence -= 15;
    reasons.push("Номер дома в реестре другой: возможно, это соседний дом.");
  }
  if (named) {
    confidence += 25;
    reasons.push("Застройщик назван в карточке объекта.");
  }
  if (p.isNewBuilding) {
    confidence += 10;
    reasons.push("Объект отмечен как новостройка.");
  }
  confidence = Math.max(1, Math.min(confidence, 100));

  const close = distance <= MATCH_RADIUS_M.strong;
  const addressed = addr.street && addr.house;
  const strongEvidence = named || addressed || (p.isNewBuilding && addr.street && !addr.streetFuzzy && !addr.houseConflict);
  if (close && strongEvidence) return { level: "auto", confidence, distanceM: distance, reasons };
  // Дальше 80 м — только точная улица: совпадение по написанию-догадке там не довод (ревью 25.11.2026).
  if (addressed && !addr.streetFuzzy && distance <= MATCH_RADIUS_M.addressed) return { level: "auto", confidence, distanceM: distance, reasons };
  if (p.isNewBuilding || addr.street || addr.house || named) return { level: "suggest", confidence, distanceM: distance, reasons };
  return { level: "none", confidence: 0, distanceM: distance, reasons: [] };
}

// ───────────────────────── Поиск по реестру (поле «Застройщик и разрешение», Шабнам) ─────────────────────────

/**
 * ПОИСК ПО ВСЕМУ СПИСКУ РЕЕСТРА (25.11.2026): поле выбора в мастере, форме и карточке объекта и инструмент Шабнам
 * «привяжи объект к застройщику». Одно правило на сервер и экран. Сравниваем свёрнутые строки: регистр, таджикские
 * буквы (Ҷамол = Чамол), русское «дж» (Джалол = Ҷалол), кавычки и знаки; организационные формы («ҶДММ», «ООО») в
 * запросе ничего не отличают и отбрасываются.
 */
export function registrySearchKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return foldAddress(raw)
    .replace(/[«»"'“”„‘’`().,;:_\-–—/\\№#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Слова запроса без организационных форм. Пустой запрос — пустой список. */
export function registryQueryTokens(query: string | null | undefined): string[] {
  const words = registrySearchKey(query).split(" ").filter(Boolean);
  const kept = words.filter((w) => !LEGAL_FORMS.has(w));
  return kept.length > 0 ? kept : words;
}

export interface RegistrySearchFields {
  title: string;
  customer: string;
  developer?: string | null;
  address?: string | null;
  qaror?: string | null;
}

/**
 * Насколько проект подходит под запрос: null — не подходит; больше — лучше. Каждое слово запроса обязано найтись
 * в названии, застройщике, адресе или номере решения. Номер решения целиком — 100; название начинается с запроса — 90;
 * все слова в названии — 80; в имени застройщика — 70; где-то в карточке — 50.
 */
export function registryQueryScore(query: string | null | undefined, fields: RegistrySearchFields): number | null {
  const tokens = registryQueryTokens(query);
  if (tokens.length === 0) return 0;
  const q = tokens.join(" ");
  const title = registrySearchKey(fields.title);
  const developer = `${registrySearchKey(fields.customer)} ${registrySearchKey(fields.developer)}`.trim();
  const address = registrySearchKey(fields.address);
  const qaror = registrySearchKey(fields.qaror);
  if (qaror && qaror === q) return 100;
  const everywhere = `${title} ${developer} ${address} ${qaror}`;
  if (!tokens.every((t) => everywhere.includes(t))) return null;
  if (title.startsWith(q)) return 90;
  if (tokens.every((t) => title.includes(t))) return 80;
  if (tokens.every((t) => developer.includes(t))) return 70;
  return 50;
}

/** Проект реестра в поле выбора и в списке поиска: только то, что нужно строке. */
export interface RegistryProjectOption {
  id: string;
  title: string;
  /** Застройщик (как он назван в реестре). */
  developer: string;
  address: string | null;
  qaror: string;
  color: RegistryColor;
  /** Расстояние до точки объекта, метры; null — точки нет. */
  distanceM: number | null;
  sourceUrl: string;
}

export interface RegistryProjectSearchResponse {
  enabled: boolean;
  updatedAt: string | null;
  /** Реестр ещё ни разу не загружался. */
  notLoaded: boolean;
  items: RegistryProjectOption[];
}

/** Лучший вариант для новой точки: уровень уверенности и до трёх запасных. Ничего не пишет в базу. */
export interface RegistryMatchPreviewResponse {
  enabled: boolean;
  updatedAt: string | null;
  notLoaded: boolean;
  noPoint: boolean;
  /** auto — подставить сразу; suggest — догадка «проверьте»; none — поле пустое. */
  level: RegistryMatchLevel;
  best: (RegistryProjectOption & { confidence: number; reasons: string[] }) | null;
  alternatives: RegistryProjectOption[];
}

/**
 * Выбор сотрудника в поле «Застройщик и разрешение», отправляется вместе с объектом (создание и правка).
 *  - project — сотрудник выбрал проект сам: ручная связь, автоматика её не трогает;
 *  - none — «нет в реестре / не новостройка»: связь снимается, проекты рядом больше не предлагаются.
 * Нет поля — решает автоматика (уверенное совпадение связывается само, как раньше).
 */
export const registryChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: z.guid() }),
  z.object({ kind: z.literal("none") }),
]);
export type RegistryChoice = z.infer<typeof registryChoiceSchema>;

// ───────────────────────── Короткий статус объекта (список CRM и Шабнам) ─────────────────────────

/**
 * Короткий статус реестра у объекта для списков: значок в CRM и одна строка в ответах Шабнам (25.11.2026).
 * Только для сотрудников. "none" — у новостройки связи с реестром нет: проверить вручную.
 */
export type RegistryBriefStatus = RegistryColor | "none";

export interface RegistryBrief {
  status: RegistryBriefStatus;
  /** Оценка застройщика A–D; null — мало данных или связи нет. */
  letter: DeveloperLetter | null;
}

/** Одна строка для сотрудника: «Реестр: разрешение есть, застройщик B». Без даты: её добавляет тот, кто показывает. */
export function registryBriefLine(brief: RegistryBrief): string {
  if (brief.status === "none") return "Реестр строек: связи с проектом нет, разрешение проверьте вручную.";
  const label = REGISTRY_COLOR_LABEL[brief.status];
  const rating = brief.letter ? `, оценка застройщика ${brief.letter}` : "";
  return `Реестр строек: ${label.title.toLowerCase()}${rating}.`;
}

/** Предупреждение сотруднику: у жёлтого и красного — прямое, у зелёного и «нет связи» — нет. */
export function registryBriefWarning(brief: RegistryBrief): string | null {
  return brief.status === "none" ? null : REGISTRY_COLOR_LABEL[brief.status].warning;
}

// ───────────────────────── Ответы API (общие типы для экрана) ─────────────────────────

export interface RegistryProjectDto {
  id: string;
  sourceId: string;
  title: string;
  customer: string;
  qaror: string;
  color: RegistryColor;
  category: string;
  lat: number;
  lng: number;
  address: string | null;
  description: string | null;
  floors: number | null;
  blocks: string[];
  documents: { name: string; ready: boolean }[];
  sourceUrl: string;
  statusChangedAt: string | null;
  removed: boolean;
  developerId: string;
}

export interface RegistryDeveloperDto {
  id: string;
  name: string;
  rating: DeveloperRating;
}

export interface RegistrySuggestionDto {
  project: RegistryProjectDto;
  developer: RegistryDeveloperDto;
  confidence: number;
  distanceM: number | null;
  reasons: string[];
}

export interface RegistryPropertyResponse {
  /** Рубильник «Реестр строек» выключен — экран ничего не показывает. */
  enabled: boolean;
  /** Когда реестр обновлялся в последний раз (успешный забор); null — ещё ни разу. */
  updatedAt: string | null;
  link: null | {
    method: "AUTO" | "MANUAL";
    confidence: number;
    distanceM: number | null;
    reasons: string[];
    project: RegistryProjectDto;
    developer: RegistryDeveloperDto;
  };
  /** Предложения на подтверждение (до трёх), если связи ещё нет. */
  suggestions: RegistrySuggestionDto[];
  /** Связи нет и подходящего проекта рядом нет: «в реестре не найден» (только у новостроек, у вторички это не сигнал). */
  notFound: boolean;
  /** Реестр ещё ни разу не загружался: сказать «ещё не загружен», а не «не найден». */
  notLoaded: boolean;
  /** У объекта нет точки на карте: сопоставлять нечем. */
  noPoint: boolean;
}

export interface RegistryMapResponse {
  enabled: boolean;
  updatedAt: string | null;
  projects: {
    id: string;
    lat: number;
    lng: number;
    color: RegistryColor;
    title: string;
    customer: string;
    category: string;
    letter: DeveloperLetter | null;
    developerId: string;
  }[];
  /** Цвет реестра у НАШИХ объектов, у которых есть уверенная или ручная связь. */
  propertyColors: Record<string, RegistryColor>;
}
