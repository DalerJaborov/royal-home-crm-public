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
