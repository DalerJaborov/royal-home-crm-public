/**
 * «ПЕРВЫЕ СЕКУНДЫ РОЛИКА» (24.09.2026, Dan: «разбор первых секунд ролика»).
 * Общий договор сервера (lib/firstSeconds.ts) и экрана Маркетинг → Обзор.
 *
 * Две половины одного вопроса «почему листают дальше»:
 *  - цифры площадок: сколько смотрят в среднем и какая доля ушла в первые
 *    3 секунды (Instagram отдаёт это прямо, YouTube и Facebook — среднее время);
 *  - что стоит в начале ролика: ИИ смотрит три кадра первых трёх секунд и
 *    называет первый план словами (фасад, кухня, человек в кадре, надпись).
 */

/** Что показано первым — закрытый список, чтобы ролики можно было сравнивать группами. */
export const OPENING_SHOTS = [
  "FACADE",
  "ENTRANCE",
  "LIVING_ROOM",
  "BEDROOM",
  "KITCHEN",
  "BATHROOM",
  "VIEW",
  "YARD",
  "PERSON",
  "TEXT",
  "OTHER",
] as const;
export type OpeningShot = (typeof OPENING_SHOTS)[number];

export const OPENING_SHOT_LABELS: Record<OpeningShot, string> = {
  FACADE: "дом снаружи",
  ENTRANCE: "подъезд или вход",
  LIVING_ROOM: "гостиная",
  BEDROOM: "спальня",
  KITCHEN: "кухня",
  BATHROOM: "ванная",
  VIEW: "вид из окна",
  YARD: "двор",
  PERSON: "человек в кадре",
  TEXT: "надпись на экране",
  OTHER: "другое",
};

/** Разбор начала одного ролика. */
export interface VideoOpeningView {
  firstShot: OpeningShot;
  hasPerson: boolean;
  hasText: boolean;
  /** 0–10: насколько начало цепляет, по мнению ИИ. */
  hookScore: number;
  /** Одна фраза: что в начале. */
  note: string;
  /** Одна фраза: что поставить в начало вместо этого. */
  tip: string | null;
  durationSec: number | null;
}

export interface FirstSecondsPost {
  propertyId: string;
  shortId: number;
  title: string;
  views: number;
  /** Доля ушедших в первые 3 секунды (Instagram), 0–1. */
  skipRate: number | null;
  /** Среднее время просмотра, секунды — среднее по площадкам, которые его отдают. */
  avgWatchSec: number | null;
  /** Какую часть ролика смотрят в среднем, 0–1. */
  watchedShare: number | null;
  /** null — ролик ещё не разобран (или файла на сервере уже нет — см. openingMissing). */
  opening: VideoOpeningView | null;
  /** Почему разбора нет: "pending" — в очереди, "no-file" — файла ролика нет. */
  openingMissing: "pending" | "no-file" | null;
}

/** Одно сравнение: чем начинаются ролики, которые досматривают дольше. */
export interface FirstSecondsFactor {
  key: "firstShot" | "person" | "text";
  title: string;
  best: string;
  /** Средняя досмотренная доля у лучшей группы и у всех, 0–1. */
  bestShare: number;
  overallShare: number;
  sample: number;
}

export interface FirstSecondsResult {
  posts: FirstSecondsPost[];
  factors: FirstSecondsFactor[];
  /** На скольких роликах есть и разбор начала, и цифра удержания (сравнение — от 6). */
  counted: number;
  /** Сколько роликов ещё ждут разбора ИИ. */
  pending: number;
  /** Нет ни одной цифры удержания — площадки её не отдают (объяснить словами). */
  retentionAvailable: boolean;
}
