import { pluralizeRu, type OwnerReportPeriod, type OwnerReportTopic, type OwnerReportWeek } from "@royal-home/shared";

/**
 * Чистая часть публичной страницы «Отчёт владельцу» (pages/PublicOwnerReport.tsx):
 * плитки с числами, столбики по неделям, ширина полос тем. Без React и без сети —
 * проверяется тестом (lib/__tests__/ownerReportView.test.ts).
 */

export interface ReportTile {
  key: string;
  value: number;
  label: string;
}

const n = (value: number, forms: [string, string, string]) => pluralizeRu(value, forms);

/**
 * Плитки периода. Канал без данных (`null`: объект не на сайте, реклама не шла) не
 * рисуется вовсе — «0» там читался бы как «ничего не вышло», а на деле показывать нечего.
 */
export function periodTiles(p: OwnerReportPeriod): ReportTile[] {
  const tiles: ReportTile[] = [
    { key: "shown", value: p.shownToClients, label: `${n(p.shownToClients, ["раз", "раза", "раз"])} показали клиентам` },
    { key: "contacts", value: p.contacts, label: `${n(p.contacts, ["контакт", "контакта", "контактов"])} по объекту` },
    { key: "showings", value: p.showings, label: `${n(p.showings, ["показ", "показа", "показов"])} проведено` },
    { key: "comments", value: p.comments, label: `${n(p.comments, ["комментарий", "комментария", "комментариев"])} под публикациями` },
  ];
  if (p.siteViews != null) {
    tiles.push({ key: "site", value: p.siteViews, label: `${n(p.siteViews, ["просмотр", "просмотра", "просмотров"])} на сайте` });
  }
  if (p.ads) {
    tiles.push({ key: "adShows", value: p.ads.impressions, label: `${n(p.ads.impressions, ["показ", "показа", "показов"])} рекламы` });
    tiles.push({ key: "adInquiries", value: p.ads.inquiries, label: `${n(p.ads.inquiries, ["обращение", "обращения", "обращений"])} из рекламы` });
  }
  return tiles;
}

export interface WeekBar {
  weekStart: string;
  events: number;
  /** Высота столбика в долях 0..1; ноль — «ничего не происходило», рисуется тонкой чертой. */
  ratio: number;
  /** «ДД.ММ» понедельника. */
  label: string;
}

/** «ГГГГ-ММ-ДД» → «ДД.ММ». */
export function weekShortLabel(weekStart: string): string {
  return `${weekStart.slice(8, 10)}.${weekStart.slice(5, 7)}`;
}

export function weekBars(weekly: OwnerReportWeek[]): { bars: WeekBar[]; total: number; peak: number } {
  const peak = Math.max(0, ...weekly.map((w) => w.events));
  return {
    bars: weekly.map((w) => ({
      weekStart: w.weekStart,
      events: w.events,
      ratio: peak > 0 ? w.events / peak : 0,
      label: weekShortLabel(w.weekStart),
    })),
    total: weekly.reduce((sum, w) => sum + w.events, 0),
    peak,
  };
}

/** Текст для скринридера вместо картинки графика. */
export function weekChartSummary(weekly: OwnerReportWeek[]): string {
  const { total, peak } = weekBars(weekly);
  if (weekly.length === 0 || total === 0) return "За последние недели откликов по объекту не было.";
  return `Динамика интереса за ${weekly.length} ${n(weekly.length, ["неделю", "недели", "недель"])}: всего ${total} ${n(total, ["событие", "события", "событий"])}, пик за неделю — ${peak}.`;
}

/** Доля полосы темы от самой частой темы, в процентах (самая частая — 100). */
export function topicBarPercent(topics: OwnerReportTopic[], topic: OwnerReportTopic): number {
  const max = Math.max(0, ...topics.map((t) => t.count));
  return max > 0 ? Math.max(6, Math.round((topic.count / max) * 100)) : 0;
}

/** «7 октября 2026 г., 15:30» по Душанбе — отчёт показывает время города владельца, а не браузера. */
export function reportDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Dushanbe", dateStyle: "long", timeStyle: "short" }).format(d);
}
