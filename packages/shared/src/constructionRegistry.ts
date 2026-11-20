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
  const d = typeof updatedAt === "string" ? new Date(updatedAt) : updatedAt;
  if (Number.isNaN(d.getTime())) return base;
  // Дата по Душанбе (UTC+5), не по часовому поясу браузера.
  const dushanbe = new Date(d.getTime() + 5 * 3_600_000);
  const dd = String(dushanbe.getUTCDate()).padStart(2, "0");
  const mm = String(dushanbe.getUTCMonth() + 1).padStart(2, "0");
  return `${base} на ${dd}.${mm}.${dushanbe.getUTCFullYear()}`;
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

/** Радиусы, метры. Менять только вместе с тестом. */
export const MATCH_RADIUS_M = { strong: 80, candidate: 250 } as const;

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

/** Слова адреса, которые не отличают одну улицу от другой. */
const ADDRESS_NOISE = new Set(
  ["улица", "ул", "кучаи", "куча", "проспект", "пр", "дом", "душанбе", "город", "район", "нохияи", "мкр", "микрорайон", "шахри", "блок", "ва"],
);

export function addressTokens(raw: string | null | undefined): { words: string[]; numbers: string[] } {
  if (!raw) return { words: [], numbers: [] };
  const cleaned = fold(raw).replace(/[«»"'“”„‘’`().,;:/\\№#-]/g, " ");
  const words: string[] = [];
  const numbers: string[] = [];
  for (const t of cleaned.split(/\s+/).filter(Boolean)) {
    if (/^\d+[а-яa-z]?$/.test(t)) numbers.push(t);
    else if (t.length >= 4 && !ADDRESS_NOISE.has(t)) words.push(t);
  }
  return { words, numbers };
}

/** Совпадение адресов: общее слово улицы и общий номер дома. */
export function addressAgreement(a: string | null | undefined, b: string | null | undefined): { street: boolean; house: boolean } {
  const ta = addressTokens(a);
  const tb = addressTokens(b);
  const street = ta.words.some((w) => tb.words.some((x) => x === w || (w.length >= 5 && x.length >= 5 && (w.startsWith(x) || x.startsWith(w)))));
  const house = ta.numbers.some((n) => tb.numbers.includes(n));
  return { street, house };
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
 * Не домысливаем: без точки у объекта — «не похоже»; одно только расстояние на старом доме — не повод связывать.
 *  - auto: до 80 м и (застройщик назван ИЛИ совпали улица и дом ИЛИ новостройка с совпавшей улицей).
 *  - suggest: до 250 м и есть хотя бы один признак (новостройка, улица, дом, застройщик): агент подтверждает.
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
    confidence += 20;
    reasons.push("Улица в адресе совпадает с реестром.");
  }
  if (addr.house) {
    confidence += 15;
    reasons.push("Номер дома совпадает с реестром.");
  }
  if (named) {
    confidence += 25;
    reasons.push("Застройщик назван в карточке объекта.");
  }
  if (p.isNewBuilding) {
    confidence += 10;
    reasons.push("Объект отмечен как новостройка.");
  }
  confidence = Math.min(confidence, 100);

  const close = distance <= MATCH_RADIUS_M.strong;
  const strongEvidence = named || (addr.street && addr.house) || (p.isNewBuilding && addr.street);
  if (close && strongEvidence) return { level: "auto", confidence, distanceM: distance, reasons };
  if (p.isNewBuilding || addr.street || addr.house || named) return { level: "suggest", confidence, distanceM: distance, reasons };
  return { level: "none", confidence: 0, distanceM: distance, reasons: [] };
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
