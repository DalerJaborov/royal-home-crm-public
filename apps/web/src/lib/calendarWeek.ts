/**
 * Неделя календаря. Раньше неделя строилась от `viewDate` (месяц, в котором
 * открыли экран), а не от выбранного дня: открыли 4 октября, выбрали клетку
 * 20 октября, нажали «Неделя» и увидели 28 сентября - 4 октября (аудит
 * 04.10.2026, WEB-PAGES19). Теперь якорь недели - выбранный день; режим
 * «просрочено» дня не выбирает, там по-прежнему `viewDate`.
 */
export type CalendarSelection = { mode: "day"; key: string } | { mode: "overdue" };

/** Ключ суток по локальному календарю сетки (так строятся клетки месяца). */
export function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Понедельник той недели, в которую входит `d` (по локальным суткам сетки). */
export function weekStartOf(d: Date): Date {
  const day = (d.getDay() + 6) % 7; // 0 = пн
  const start = new Date(d);
  start.setDate(d.getDate() - day);
  return start;
}

/** День, от которого строится неделя: выбранный, а без выбора - `viewDate`. */
export function weekAnchorDate(selected: CalendarSelection, viewDate: Date): Date {
  return selected.mode === "day" ? new Date(`${selected.key}T12:00:00`) : new Date(viewDate);
}

/** Семь дней недели с понедельника. */
export function weekDays(selected: CalendarSelection, viewDate: Date): Date[] {
  const start = weekStartOf(weekAnchorDate(selected, viewDate));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** Якорь, сдвинутый на `deltaWeeks` недель (для кнопок «предыдущая/следующая»). */
export function shiftedAnchor(selected: CalendarSelection, viewDate: Date, deltaWeeks: number): Date {
  const d = weekAnchorDate(selected, viewDate);
  d.setDate(d.getDate() + deltaWeeks * 7);
  return d;
}

/**
 * Нужно ли переключить показанный месяц, чтобы запрос задач покрыл `anchor`.
 * Сетка месяца - 42 дня целыми неделями, поэтому любая неделя, содержащая день
 * сетки, лежит в ней целиком.
 */
export function anchorOutsideGrid(anchor: Date, gridFirst: Date, gridLast: Date): boolean {
  const key = localDayKey(anchor);
  return key < localDayKey(gridFirst) || key > localDayKey(gridLast);
}
