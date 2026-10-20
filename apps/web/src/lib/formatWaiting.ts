/** Минуты ожидания словами: «45 мин», «3 ч 10 мин», «2 дн». */
export function formatWaiting(min: number): string {
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч${min % 60 ? ` ${min % 60} мин` : ""}`;
  return `${Math.floor(h / 24)} дн`;
}
