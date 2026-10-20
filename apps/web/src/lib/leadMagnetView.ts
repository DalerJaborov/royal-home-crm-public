/**
 * Чистая логика экрана «Воронка» (десктоп FunnelTab и телефон MobileFunnel
 * считают одно и то же, поэтому живёт она здесь, а не в двух копиях).
 */

interface HasId {
  id: string;
}

interface HasStats extends HasId {
  stats: { invited: number; awaitingFollow: number; delivered: number; failed: number };
}

export interface JournalTotals {
  invited: number;
  awaitingFollow: number;
  delivered: number;
  failed: number;
}

/**
 * Счётчики на срезах журнала. Журнал одной кампании показывает числа ЭТОЙ
 * кампании: раньше суммировались все, и бейдж «Не дошло» обещал выдачи, которых
 * в открытом журнале не было (аудит 04.10.2026, WEB-PAGES15). «all» и закрытый
 * журнал считают по всем кампаниям.
 */
export function journalTotals(campaigns: HasStats[], journalOf: string | "all" | null): JournalTotals {
  const scope = journalOf && journalOf !== "all" ? campaigns.filter((c) => c.id === journalOf) : campaigns;
  return scope.reduce<JournalTotals>(
    (acc, c) => ({
      invited: acc.invited + c.stats.invited,
      awaitingFollow: acc.awaitingFollow + c.stats.awaitingFollow,
      delivered: acc.delivered + c.stats.delivered,
      failed: acc.failed + c.stats.failed,
    }),
    { invited: 0, awaitingFollow: 0, delivered: 0, failed: 0 },
  );
}

/**
 * Кампания в открытом редакторе. Редактор получал снимок строки на момент
 * открытия, и после загрузки или удаления PDF (список перечитывается) файловый
 * блок и предпросмотр показывали старое состояние (аудит 04.10.2026,
 * WEB-PAGES14). Берём свежую строку из списка по id; пока её там нет (только что
 * созданная копия) или список не загружен, остаётся снимок.
 */
export function resolveEditingCampaign<T extends HasId>(editing: { campaign: T | null } | null, campaigns: T[] | undefined): T | null {
  if (!editing || !editing.campaign) return null;
  const snapshot = editing.campaign;
  return campaigns?.find((c) => c.id === snapshot.id) ?? snapshot;
}
