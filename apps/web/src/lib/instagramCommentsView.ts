import type { InstagramCommentStatus } from "@royal-home/shared";

/**
 * Вкладки фильтра экрана «Комментарии» (pages/Comments.tsx, один экран на обе
 * ширины) — порядок несёт смысл: сначала скрытое и то, где бот спасовал.
 */
export const COMMENT_TABS: { status: InstagramCommentStatus | null; label: string; onlyIfAny?: boolean }[] = [
  { status: null, label: "Все" },
  { status: "HIDDEN", label: "Скрытые" },
  { status: "ESCALATED", label: "Бот не знал" },
  { status: "REPLIED", label: "Бот ответил" },
  { status: "PENDING", label: "В очереди" },
  { status: "SKIPPED", label: "Промолчал" },
  // Отказы бывают редко; пустая вкладка «Не удалось» только пугала бы.
  { status: "FAILED", label: "Не удалось", onlyIfAny: true },
];

/** Тона пилюли статуса на телефонной карточке — по блоку vComments прототипа
 *  design_handoff (пилюля 10.5px/700 с тонированной подложкой). Красное всегда
 *  означает «подписчик этого не видит» — тот же смысл, что и на десктопе. */
export const COMMENT_STATUS_PILL: Record<InstagramCommentStatus, string> = {
  HIDDEN: "bg-red-bg text-red",
  DELETED: "bg-red-bg text-red",
  ESCALATED: "bg-amber-bg text-amber",
  REPLIED: "bg-green-bg text-green",
  PENDING: "bg-blue/10 text-blue",
  WORKING: "bg-blue/10 text-blue",
  SKIPPED: "bg-line-soft text-gray-500",
  FAILED: "bg-red-bg text-red",
};

/**
 * Модификатор чипа `.chip` эталона темы «Royal Home 2026» под статус
 * комментария (screens/comments.html): `crit` — подписчик этого не видит,
 * `warn` — бот не знал ответа, `ok` — бот ответил, `mute` — всё остальное.
 * Один словарь на десктоп и телефон: смысл цвета расходиться не должен.
 */
export const RH2_COMMENT_CHIP: Record<InstagramCommentStatus, string> = {
  HIDDEN: "crit",
  DELETED: "crit",
  ESCALATED: "warn",
  REPLIED: "ok",
  PENDING: "mute",
  WORKING: "mute",
  SKIPPED: "mute",
  FAILED: "crit",
};

/** Инициалы для аватара `.av` над карточкой комментария: у автора известен
 *  только ник в Instagram, поэтому берём первые буквы ника без «@». */
export function rh2CommentInitials(authorName: string | null): string {
  const clean = (authorName ?? "").replace(/^@+/, "").replace(/[^\p{L}\p{N}]+/gu, "");
  return clean ? clean.slice(0, 2).toUpperCase() : "?";
}
