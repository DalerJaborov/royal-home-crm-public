/**
 * Месяц, который экран «Финансы» показывает на самом деле. Выбранный стрелками
 * месяц мог выпасть из нового, более короткого диапазона сводки (был «2 года»,
 * выбрали «6 месяцев»): `current` становился undefined и вместе с ним исчезали
 * прибыль, плитки и обе стрелки, а расходы и прогноз продолжали считаться за
 * старый месяц (аудит 04.10.2026, WEB-PAGES12). Пока сводка не пришла, выбор не
 * трогаем; когда пришла и выбранного месяца в ней нет, берём ближайший к нему.
 * Ключи «YYYY-MM» сравниваются как строки.
 */
export function effectiveMonth(selected: string, months: { month: string }[]): string {
  if (months.length === 0 || months.some((m) => m.month === selected)) return selected;
  const first = months[0].month;
  const last = months[months.length - 1].month;
  return selected < first ? first : last;
}
