/**
 * Выбор вакансии для старой анкеты без привязки (разовая привязка 22.10.2026).
 * Чистая функция: без базы, без ИИ — чтобы правило можно было проверить тестом.
 *
 * Старый бот набирал агентов по недвижимости, поэтому по умолчанию анкета —
 * «Агент по недвижимости». Слова про видео/SMM/контент уводят в «SMM / видеограф».
 * Слова из таблицы RecruitmentKeyword (кодовые слова рекламных постов) главнее,
 * если указывают ровно на одну вакансию.
 */

export const DEFAULT_VACANCY_KEY = "real-estate-agent";
export const SMM_VACANCY_KEY = "smm-videographer";

/** Подстроки (без регистра), по которым анкета считается заявкой на SMM/видео.
 *  Подстрока, а не \b: границы слов в JS не работают с кириллицей. */
export const SMM_WORDS = [
  "smm", "смм", "видео", "видеограф", "монтаж", "рилс", "reels",
  "контент", "дизайн", "таргет", "съёмк", "съемк", "сним",
] as const;

export interface VacancyKeyword {
  word: string;
  positionKey: string;
}

export function pickVacancyKey(text: string, keywords: readonly VacancyKeyword[] = []): string {
  const hay = text.toLowerCase().replace(/ё/g, "е");
  const hits = new Set<string>();
  for (const k of keywords) {
    const w = k.word.trim().toLowerCase().replace(/ё/g, "е");
    if (w && hay.includes(w)) hits.add(k.positionKey);
  }
  if (hits.size === 1) return [...hits][0];
  const smm = SMM_WORDS.some((w) => hay.includes(w.replace(/ё/g, "е")));
  if (smm) return SMM_VACANCY_KEY;
  if (hits.size > 1) return [...hits][0];
  return DEFAULT_VACANCY_KEY;
}

/** Слова продавца/покупателя/услуги: анкета, скорее всего, заведена по ошибке.
 *  Только для отчёта — статус скрипт не меняет. */
const NON_CANDIDATE_WORDS = [
  "продаю", "продам", "продается", "продаётся", "куплю", "хочу купить", "купить",
  "сдаю", "сдам", "сниму", "снять квартир", "аренд", "ипотек", "застройщик",
  "стоимость услуг", "ваши услуги", "сколько стоит", "цена за", "кв.м", "квадрат",
] as const;

const JOB_WORDS = ["вакан", "работ", "резюме", "стажир", "устро", "кор ", "ҷои кор"] as const;

export function looksLikeNonCandidate(text: string): boolean {
  const hay = text.toLowerCase().replace(/ё/g, "е");
  if (JOB_WORDS.some((w) => hay.includes(w))) return false;
  return NON_CANDIDATE_WORDS.some((w) => hay.includes(w.replace(/ё/g, "е")));
}
