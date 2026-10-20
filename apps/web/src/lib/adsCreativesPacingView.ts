import {
  PACING_MIN_RANGE_DAYS,
  PACING_MIN_USUAL_TJS,
  type AdCreativeLowDataReason,
  type AdCreativeMark,
  type AdCreativeRow,
  type AdPacingDayPoint,
  type AdPacingForecast,
  type AdPacingForecastState,
} from "@royal-home/shared";
import { formatMoneyExact, pluralizeRu } from "./format";

/**
 * ПОДПИСИ И ГЕОМЕТРИЯ ДВУХ БЛОКОВ «РЕКЛАМЫ» (03.10.2026): «Креативы: что работает» и
 * «Темп расхода». Живут отдельно от компонентов — тот же приём, что у lib/adsView.ts:
 * правила «не показывать ноль ценой», «≈ у приблизительного» и «диапазон, а не одна
 * цифра» проверяются тестом, а не глазами.
 */

/* ───────── Креативы ───────── */

/**
 * Цена или честное «нет»: null — результата нет, и «0,00 с.» читалось бы как «бесплатно».
 * Экран печатает пустое слово вместо цены, цвет не несёт смысла один.
 */
export function costOrNone(cost: number | null, none: string): { text: string; none: boolean } {
  return cost == null ? { text: none, none: true } : { text: formatMoneyExact(cost, "TJS"), none: false };
}

/**
 * Частота показов — ПРИБЛИЗИТЕЛЬНАЯ (охват Meta считается по дням, сервер складывает
 * дневные охваты), поэтому всегда с «≈». Нет охвата — нет и числа.
 */
export function describeFrequency(freq: number | null): string | null {
  if (freq == null || !Number.isFinite(freq)) return null;
  return `≈ ${(Math.round(freq * 10) / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}`;
}

/** Метка строки рейтинга: слово несёт смысл, цвет — только подкрашивает (`tone` → класс chip). */
export function describeMark(
  mark: AdCreativeMark,
  position: number | null
): { label: string; tone: "ok" | "crit" | "" } {
  switch (mark) {
    case "best":
      return { label: position ? `Лучше всего · №${position}` : "Лучше всего", tone: "ok" };
    case "worst":
      return { label: position ? `Хуже всего · №${position}` : "Хуже всего", tone: "crit" };
    case "lowData":
      return { label: "Мало данных", tone: "" };
    default:
      return { label: "", tone: "" };
  }
}

/** Что именно не дотянуло до порога значимости. Пороги — с сервера, а не выдуманные здесь. */
export function describeLowData(
  reason: AdCreativeLowDataReason | null,
  thresholds: { minSpendTjs: number; minImpressions: number }
): string {
  const spend = `расход меньше ${formatMoneyExact(thresholds.minSpendTjs, "TJS")}`;
  const impressions = `показов меньше ${thresholds.minImpressions.toLocaleString("ru-RU")}`;
  if (reason === "both") return `${spend} и ${impressions}`;
  if (reason === "spend") return spend;
  if (reason === "impressions") return impressions;
  return "данных мало";
}

/** «12 дней с тратами · на 4 объекта» — одной строкой под названием. */
export function describeCreativeMeta(row: Pick<AdCreativeRow, "activeDays" | "objectsCount">): string {
  const days = `${row.activeDays} ${pluralizeRu(row.activeDays, ["день", "дня", "дней"])} с тратами`;
  if (row.objectsCount > 1) {
    return `${days} · на ${row.objectsCount} ${pluralizeRu(row.objectsCount, ["объект", "объекта", "объектов"])}, расход один`;
  }
  if (row.objectsCount === 1) return `${days} · на 1 объект`;
  return `${days} · без объекта`;
}

/** Три группы, которые рисует экран; порядок внутри групп уже задал сервер. */
export function groupCreatives(rows: AdCreativeRow[]): {
  best: AdCreativeRow[];
  worst: AdCreativeRow[];
  rest: AdCreativeRow[];
} {
  return {
    best: rows.filter((r) => r.mark === "best"),
    worst: rows.filter((r) => r.mark === "worst"),
    rest: rows.filter((r) => r.mark === "middle" || r.mark === "lowData"),
  };
}

/* ───────── Темп расхода ───────── */

/**
 * «в 2,1 раза выше обычного» / «как обычно» / «ниже обычного». null — обычного дня нет
 * (нулевой или нет данных): сравнивать не с чем, экран пишет «обычного дня пока нет».
 */
export function describeRatio(ratio: number | null): string | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio >= 1.1) return `в ${(Math.round(ratio * 10) / 10).toLocaleString("ru-RU")} раза выше обычного`;
  if (ratio <= 0.9) return ratio === 0 ? "расхода пока нет" : "ниже обычного";
  return "как обычно";
}

/**
 * Прогноз ВСЕГДА с вилкой «от–до»: одна цифра изображала бы точность, которой нет.
 * Когда низ и верх совпали (расхода не было) — один раз и честно, без вилки.
 */
export function describeForecast(
  state: AdPacingForecastState,
  forecast: AdPacingForecast | null
): { headline: string; range: string | null; note: string | null } {
  if (state === "insufficient" || !forecast) {
    return {
      headline: "нет данных",
      range: null,
      note: "За последние 7 дней от Meta пришло слишком мало дней — прогноз не выдумываем.",
    };
  }
  if (state === "no_spend") {
    return {
      headline: formatMoneyExact(forecast.expectedTjs, "TJS"),
      range: null,
      note: "За последние 7 дней расхода не было — прогноз равен уже потраченному.",
    };
  }
  const range =
    forecast.lowTjs === forecast.highTjs
      ? null
      : `от ${formatMoneyExact(forecast.lowTjs, "TJS")} до ${formatMoneyExact(forecast.highTjs, "TJS")}`;
  const base =
    forecast.remainingDays > 0
      ? `Темп последних 7 дней × ${forecast.remainingDays} ${pluralizeRu(forecast.remainingDays, ["день", "дня", "дней"])} до конца месяца.`
      : "Месяц заканчивается сегодня.";
  // Вилка — типичные дни недели (25–75 %), без самого тихого и самого дорогого; мало дней — вилки нет.
  const rangeNote =
    forecast.rangeState === "too_few_days"
      ? ` Вилку не строим: данных меньше ${PACING_MIN_RANGE_DAYS} дней из семи.`
      : range && forecast.rangeState === "percentile"
        ? " Вилка — по типичным дням недели, без самого тихого и самого дорогого."
        : "";
  return {
    headline: `≈ ${formatMoneyExact(forecast.expectedTjs, "TJS")}`,
    range,
    note: base + rangeNote,
  };
}

export interface MonthBar {
  date: string;
  value: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** today — сегодняшний день; high — день вдвое выше обычного (красный флаг и на графике). */
  flag: "today" | "high" | null;
}

export interface MonthBars {
  bars: MonthBar[];
  /** Ширина области в условных единицах (по десять на день). */
  width: number;
  height: number;
  /** Высота линии «обычный день»; null — обычного дня нет. */
  usualY: number | null;
  /** Верх шкалы, сомони (самый дорогой день или обычный — что больше). */
  max: number;
}

/** Слот одного дня и зазор между столбцами, условные единицы SVG. */
const SLOT = 10;
const GAP = 2;
/** Минимальная высота ненулевого столбца: день с копеечным расходом не должен пропадать с графика. */
const MIN_BAR = 2;

/**
 * Геометрия мини-графика расхода по дням: чистая функция, чтобы ни масштаб, ни пустые
 * дни, ни «день вдвое выше» не зависели от отрисовки. Нулевой день — нулевая высота
 * (пустое место, а не выдуманный столбик); ненулевой — не ниже MIN_BAR.
 */
export function buildMonthBars(series: AdPacingDayPoint[], usualDayTjs: number, height = 100): MonthBars {
  const top = Math.max(...series.map((p) => p.spendTjs), usualDayTjs, 0);
  const scale = (v: number) => (top > 0 ? (v / top) * (height - 4) : 0);
  const last = series.length - 1;
  const bars = series.map((p, i): MonthBar => {
    const h = p.spendTjs > 0 ? Math.max(MIN_BAR, scale(p.spendTjs)) : 0;
    const isHigh = usualDayTjs >= PACING_MIN_USUAL_TJS && p.spendTjs > usualDayTjs * 2;
    return {
      date: p.date,
      value: p.spendTjs,
      x: i * SLOT + GAP / 2,
      y: height - h,
      w: SLOT - GAP,
      h,
      flag: i === last ? "today" : isHigh ? "high" : null,
    };
  });
  return {
    bars,
    width: Math.max(series.length, 1) * SLOT,
    height,
    usualY: usualDayTjs > 0 ? height - scale(usualDayTjs) : null,
    max: top,
  };
}

/** «3 окт.» из «2024-10-03» — без пересчёта пояса (дата уже календарная). */
export function dayShort(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" });
}
