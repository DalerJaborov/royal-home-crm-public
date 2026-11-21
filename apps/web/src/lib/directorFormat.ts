import { pluralizeRu } from "@royal-home/shared";

/**
 * ДАШБОРД РУКОВОДИТЕЛЯ — чистые функции показа (сравнение, проценты, сортировка).
 * Без запросов и React: на них держатся тесты и обе раскладки (директор / РОП).
 */

/** Что считать хорошим при росте числа: заявки и сделки — рост, просрочка и отказы — падение. */
export type GoodDirection = "up" | "down";

export type DeltaView = {
  /** Короткая фраза: «на 12 больше, чем в прошлом периоде». */
  text: string;
  arrow: "up" | "down" | "flat";
  /** Цвет по смыслу: рост плохого — не зелёный. */
  tone: "good" | "bad" | "neutral";
};

/** Сравнение с прошлым периодом. Нет базы для сравнения — честно молчим (null), без выдуманных процентов. */
export function compareDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  good: GoodDirection = "up",
  noun: [string, string, string] | null = null,
): DeltaView | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const diff = current - previous;
  if (diff === 0) return { text: "столько же, сколько в прошлом периоде", arrow: "flat", tone: "neutral" };
  const abs = Math.abs(diff);
  const absText = Number.isInteger(abs) ? abs.toLocaleString("ru-RU") : abs.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const more = diff > 0;
  const word = noun && Number.isInteger(abs) ? ` ${pluralizeRu(abs, noun)}` : "";
  const tone = (more && good === "up") || (!more && good === "down") ? "good" : "bad";
  return { text: `на ${absText}${word} ${more ? "больше" : "меньше"}, чем в прошлом периоде`, arrow: more ? "up" : "down", tone };
}

/** Доля в процентах, целым; ноль в знаменателе — null (прочерк), а не «0 %» или «NaN». */
export function sharePct(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part === null || part === undefined || whole === null || whole === undefined) return null;
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export function percentLabel(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toLocaleString("ru-RU")} %`;
}

/** Минуты по-человечески: «45 мин», «2 ч 10 мин», «1 д 3 ч»; нет данных — «—». */
export function minutesLabel(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min) || min < 0) return "—";
  const total = Math.round(min);
  if (total < 60) return `${total} мин`;
  if (total < 60 * 24) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  const d = Math.floor(total / (60 * 24));
  const h = Math.floor((total % (60 * 24)) / 60);
  return h ? `${d} д ${h} ч` : `${d} д`;
}

/** Остаток до плана: «осталось 12», «план перевыполнен на 3». */
export function planRemainder(fact: number, plan: number, unit = ""): string {
  const tail = unit ? ` ${unit}` : "";
  const diff = plan - fact;
  if (diff > 0) return `осталось ${Math.round(diff).toLocaleString("ru-RU")}${tail}`;
  if (diff < 0) return `план перевыполнен на ${Math.round(-diff).toLocaleString("ru-RU")}${tail}`;
  return "план выполнен";
}

export type SortDir = "asc" | "desc";

/** Сортировка таблицы по любому столбцу: пустые значения всегда внизу, имена — по-русски; исходный массив не меняет. */
export function sortRows<T>(rows: readonly T[], key: (row: T) => number | string | null | undefined, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const xn = x === null || x === undefined;
    const yn = y === null || y === undefined;
    if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    return String(x).localeCompare(String(y), "ru") * sign;
  });
}

/** Период по умолчанию зависит от роли: директор смотрит месяц, РОП — неделю. */
export type DashboardPeriod = "day" | "week" | "month" | "quarter" | "year" | "custom";
export function defaultPeriod(role: string | null | undefined): DashboardPeriod {
  return role === "HEAD_OF_SALES" ? "week" : "month";
}

/** Порядок блоков по роли (владелец 21.11): директор — деньги и план сверху, РОП — скорость и агенты. */
export type DashboardBlock = "kpi" | "plan" | "speed" | "agents" | "funnel" | "sources" | "reasons";
export function blockOrder(role: string | null | undefined, seesMoney: boolean): DashboardBlock[] {
  const order: DashboardBlock[] =
    role === "HEAD_OF_SALES"
      ? ["speed", "agents", "funnel", "kpi", "sources", "reasons", "plan"]
      : ["plan", "kpi", "funnel", "reasons", "speed", "agents", "sources"];
  return seesMoney ? order : order.filter((b) => b !== "plan");
}
