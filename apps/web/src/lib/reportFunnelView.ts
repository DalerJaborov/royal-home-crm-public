/**
 * Воронка отчёта пуста, только если в ней нет ничего: ни людей на ступенях, ни
 * комиссии. Даты каждого события считаются отдельно, поэтому в первый день
 * месяца новых лидов может не быть, а показ старому клиенту и его сделка есть, и
 * воронка с комиссией обязана показываться (аудит 04.10.2026, WEB-PAGES17).
 */
export function isFunnelEmpty(funnel: { count: number; commission?: number | null }[]): boolean {
  return funnel.length === 0 || funnel.every((s) => s.count === 0 && !s.commission);
}

/** Stable API keys, not array positions: an absent stage must not become another metric. */
export function selectFunnelStages<T extends { key: string }>(funnel: readonly T[]) {
  return {
    leads: funnel.find((stage) => stage.key === "leads"),
    showings: funnel.find((stage) => stage.key === "showings"),
    negotiations: funnel.find((stage) => stage.key === "negotiations"),
    deals: funnel.find((stage) => stage.key === "deals"),
  };
}

/**
 * ВОРОНКА ЗАЯВОК ПЕРИОДА (20.11.2026): доля каждого шага — от числа заявок
 * периода. Сервер считает шаг «дошёл сюда или дальше», поэтому шаг не больше
 * предыдущего; округление и предел 100 % здесь — вторая защита на случай
 * старого или кривого ответа, чтобы на экран никогда не вышло «больше 100 %».
 */
export function cohortFunnelView(cohort: readonly { key: string; label: string; count: number }[]) {
  const leads = cohort.find((s) => s.key === "leads")?.count ?? 0;
  const pct = (n: number) => (leads > 0 ? Math.min(100, Math.round((n / leads) * 100)) : null);
  const steps = cohort.map((s) => ({ ...s, share: leads > 0 ? Math.min(1, s.count / leads) : 0, percent: pct(s.count) }));
  const dealsStep = cohort.find((s) => s.key === "deals");
  return { leads, steps, toDeal: dealsStep ? pct(dealsStep.count) : null };
}
