import { describe, expect, it } from "vitest";
import { PACING_MIN_USUAL_TJS, type AdCreativeRow } from "@royal-home/shared";
import {
  buildMonthBars,
  costOrNone,
  dayShort,
  describeCreativeMeta,
  describeForecast,
  describeFrequency,
  describeLowData,
  describeMark,
  describeRatio,
  groupCreatives,
} from "../adsCreativesPacingView";

/**
 * Подписи и геометрия блоков «Креативы: что работает» и «Темп расхода» (03.10.2026).
 * Правила, которые нельзя нарушить: ноль не печатается ценой, приблизительное — с «≈»,
 * прогноз — вилкой «от–до», при нехватке данных — «нет данных», а не число.
 */

const row = (extra: Partial<AdCreativeRow> = {}): AdCreativeRow => ({
  adId: "a",
  title: "Креатив",
  campaignName: null,
  thumbnailUrl: null,
  postUrl: null,
  delivery: "RUNNING",
  activeDays: 3,
  spendTjs: 500,
  impressions: 5000,
  conversations: 2,
  leads: 1,
  showings: 0,
  costPerConversationTjs: 250,
  costPerLeadTjs: 500,
  frequencyApprox: 2,
  objectsCount: 1,
  brand: false,
  mark: "middle",
  rankPosition: null,
  lowDataReason: null,
  ...extra,
});

describe("costOrNone", () => {
  it("null — слово вместо цены, а не «0,00 с.»", () => {
    expect(costOrNone(null, "клиентов нет")).toEqual({ text: "клиентов нет", none: true });
  });
  it("число — сомони до дирама", () => {
    const c = costOrNone(120, "нет");
    expect(c.none).toBe(false);
    expect(c.text).toMatch(/120,00/);
    expect(c.text).toMatch(/с\./);
  });
});

describe("describeFrequency", () => {
  it("всегда с «≈» — частота приблизительная", () => {
    expect(describeFrequency(2.04)).toBe("≈ 2");
    expect(describeFrequency(2.46)).toMatch(/^≈ 2,5$/);
  });
  it("нет охвата — нет и числа", () => {
    expect(describeFrequency(null)).toBeNull();
    expect(describeFrequency(Number.NaN)).toBeNull();
  });
});

describe("describeMark", () => {
  it("метка — слово, а цвет только подкрашивает", () => {
    expect(describeMark("best", 1)).toEqual({ label: "Лучше всего · №1", tone: "ok" });
    expect(describeMark("worst", 2)).toEqual({ label: "Хуже всего · №2", tone: "crit" });
    expect(describeMark("lowData", null)).toEqual({ label: "Мало данных", tone: "" });
    expect(describeMark("middle", null).label).toBe("");
  });
});

describe("describeLowData", () => {
  const th = { minSpendTjs: 100, minImpressions: 1000 };
  it("называет, что именно не дотянуло, с порогами сервера", () => {
    expect(describeLowData("spend", th)).toMatch(/расход меньше 100,00/);
    expect(describeLowData("impressions", th)).toMatch(/показов меньше 1\s?000/);
    const both = describeLowData("both", th);
    expect(both).toMatch(/расход/);
    expect(both).toMatch(/показов/);
  });
});

describe("describeCreativeMeta", () => {
  it("объявление на несколько объектов — «расход один»: деньги не размножаются", () => {
    expect(describeCreativeMeta({ activeDays: 5, objectsCount: 4 })).toBe("5 дней с тратами · на 4 объекта, расход один");
    expect(describeCreativeMeta({ activeDays: 3, objectsCount: 2 })).toBe("3 дня с тратами · на 2 объекта, расход один");
    expect(describeCreativeMeta({ activeDays: 3, objectsCount: 5 })).toBe("3 дня с тратами · на 5 объектов, расход один");
    expect(describeCreativeMeta({ activeDays: 3, objectsCount: 21 })).toBe("3 дня с тратами · на 21 объект, расход один");
    expect(describeCreativeMeta({ activeDays: 1, objectsCount: 1 })).toBe("1 день с тратами · на 1 объект");
    expect(describeCreativeMeta({ activeDays: 2, objectsCount: 0 })).toBe("2 дня с тратами · без объекта");
  });
});

describe("groupCreatives", () => {
  it("лучшие, худшие и остальное (середина и «мало данных»)", () => {
    const g = groupCreatives([
      row({ adId: "b", mark: "best" }),
      row({ adId: "m", mark: "middle" }),
      row({ adId: "w", mark: "worst" }),
      row({ adId: "l", mark: "lowData" }),
    ]);
    expect(g.best.map((r) => r.adId)).toEqual(["b"]);
    expect(g.worst.map((r) => r.adId)).toEqual(["w"]);
    expect(g.rest.map((r) => r.adId)).toEqual(["m", "l"]);
  });
});

describe("describeRatio", () => {
  it("выше, как обычно, ниже; нет обычного дня — null", () => {
    expect(describeRatio(2.1)).toMatch(/выше обычного/);
    expect(describeRatio(1)).toBe("как обычно");
    expect(describeRatio(0.5)).toBe("ниже обычного");
    expect(describeRatio(0)).toBe("расхода пока нет");
    expect(describeRatio(null)).toBeNull();
  });
});

describe("describeForecast", () => {
  it("с данными — «≈ X» и вилка «от–до», а не одна цифра", () => {
    const f = describeForecast("ok", { expectedTjs: 310, lowTjs: 225, highTjs: 395, remainingDays: 16 });
    expect(f.headline).toMatch(/^≈ 310,00/);
    expect(f.range).toMatch(/от 225,00/);
    expect(f.range).toMatch(/до 395,00/);
    expect(f.note).toMatch(/16 дней/);
  });
  it("мало данных — «нет данных» без числа", () => {
    const f = describeForecast("insufficient", null);
    expect(f.headline).toBe("нет данных");
    expect(f.range).toBeNull();
    expect(f.headline).not.toMatch(/\d/);
  });
  it("нулевой расход — число без вилки и честное объяснение", () => {
    const f = describeForecast("no_spend", { expectedTjs: 0, lowTjs: 0, highTjs: 0, remainingDays: 10 });
    expect(f.range).toBeNull();
    expect(f.note).toMatch(/расхода не было/);
  });
  it("вилка по типичным дням — подпись объясняет, чем она построена", () => {
    const f = describeForecast("ok", { expectedTjs: 310, lowTjs: 293, highTjs: 327, remainingDays: 16, rangeState: "percentile" });
    expect(f.range).toMatch(/от 293,00/);
    expect(f.note).toMatch(/типичным дням/);
  });
  it("мало дней данных — вилки нет, есть точечная цифра и причина", () => {
    const f = describeForecast("ok", { expectedTjs: 2000, lowTjs: 2000, highTjs: 2000, remainingDays: 16, rangeState: "too_few_days" });
    expect(f.headline).toMatch(/^≈ 2/);
    expect(f.range).toBeNull();
    expect(f.note).toMatch(/Вилку не строим/);
  });
  it("последний день месяца — без «× 0 дней»", () => {
    const f = describeForecast("ok", { expectedTjs: 100, lowTjs: 90, highTjs: 110, remainingDays: 0 });
    expect(f.note).toBe("Месяц заканчивается сегодня.");
  });
});

describe("buildMonthBars", () => {
  const series = [
    { date: "2024-07-01", spendTjs: 10 },
    { date: "2024-07-02", spendTjs: 0 },
    { date: "2024-07-03", spendTjs: 30 },
    { date: "2024-07-04", spendTjs: 0.2 },
  ];

  it("высота по самому дорогому дню, ноль — пустое место, копейки не пропадают", () => {
    const g = buildMonthBars(series, 10);
    expect(g.max).toBe(30);
    expect(g.width).toBe(40);
    expect(g.bars[1].h).toBe(0);
    expect(g.bars[2].h).toBeGreaterThan(g.bars[0].h);
    expect(g.bars[3].h).toBeGreaterThanOrEqual(2);
    // Основание столбца — внизу области.
    for (const b of g.bars) expect(b.y + b.h).toBe(g.height);
  });

  it("флаги: последний — «сегодня»; день вдвое выше обычного — «high»", () => {
    const g = buildMonthBars(series, 10);
    expect(g.bars[3].flag).toBe("today");
    expect(g.bars[2].flag).toBe("high");
    expect(g.bars[0].flag).toBeNull();
  });

  it("красный столбик не рисуется, пока обычный день меньше порога сервера (PACING_MIN_USUAL_TJS)", () => {
    const tiny = [
      { date: "2024-07-01", spendTjs: 1 },
      { date: "2024-07-02", spendTjs: 5 },
      { date: "2024-07-03", spendTjs: 2 },
    ];
    // обычный 2 сомони < 10: пять — не событие, а шум (сервер флаг тоже не поднимает)
    expect(buildMonthBars(tiny, 2).bars[1].flag).toBeNull();
    // ровно на пороге — рисуется
    const edge = [
      { date: "2024-07-01", spendTjs: 25 },
      { date: "2024-07-02", spendTjs: 5 },
    ];
    expect(buildMonthBars(edge, PACING_MIN_USUAL_TJS).bars[0].flag).toBe("high");
  });

  it("линия «обычный день» лежит на высоте обычного расхода; нет обычного дня — линии нет", () => {
    const g = buildMonthBars(series, 15);
    expect(g.usualY).toBeCloseTo(g.height - (15 / 30) * (g.height - 4), 5);
    expect(buildMonthBars(series, 0).usualY).toBeNull();
  });

  it("весь месяц без расхода и пустой ряд — без NaN и деления на ноль", () => {
    const zero = buildMonthBars([{ date: "2024-07-01", spendTjs: 0 }], 0);
    expect(zero.bars[0].h).toBe(0);
    expect(Number.isFinite(zero.bars[0].y)).toBe(true);
    const empty = buildMonthBars([], 0);
    expect(empty.bars).toEqual([]);
    expect(empty.width).toBe(10);
  });
});

describe("dayShort", () => {
  it("календарная дата без сдвига пояса", () => {
    expect(dayShort("2024-07-01")).toMatch(/1/);
    expect(dayShort("2024-07-01")).toMatch(/июл/);
    expect(dayShort("не дата")).toBe("не дата");
  });
});
