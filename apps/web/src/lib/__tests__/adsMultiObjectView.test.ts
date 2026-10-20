import { describe, expect, it } from "vitest";
import {
  agoRu,
  formatPct,
  LEAD_VS_META_HINT,
  parseWeight,
  pickLeaderboard,
  SHARE_SUM_TOLERANCE,
  sharesToWeights,
  splitEvenly,
  weightToField,
} from "../adsView";

/**
 * Чистая логика экрана «Реклама» для нескольких объектов в одном объявлении
 * (03.10.2026): доли «поровну», разбор поля ввода, подпись «проверено N минут
 * назад» и два рейтинга по цене обращения.
 */
describe("splitEvenly", () => {
  it("делит ровно на 100, остаток уходит первым", () => {
    expect(splitEvenly(3)).toEqual([33.34, 33.33, 33.33]);
    expect(splitEvenly(4)).toEqual([25, 25, 25, 25]);
    expect(splitEvenly(1)).toEqual([100]);
    expect(splitEvenly(0)).toEqual([]);
  });
  it("сумма всегда 100", () => {
    for (let n = 1; n <= 20; n++) {
      const sum = splitEvenly(n).reduce((a, b) => a + b, 0);
      expect(Math.round(sum * 100)).toBe(10000);
    }
  });
});

describe("sharesToWeights — начальные доли окна", () => {
  const sum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100;

  it("равные доли дают те же числа, что «Поровну», и сумму ровно 100 (3, 6, 7)", () => {
    for (const n of [1, 2, 3, 4, 6, 7, 9, 20]) {
      const w = sharesToWeights(Array.from({ length: n }, () => 1 / n));
      expect(w).toEqual(splitEvenly(n));
      expect(sum(w)).toBe(100);
    }
    expect(sharesToWeights([1 / 3, 1 / 3, 1 / 3])).toEqual([33.34, 33.33, 33.33]);
    expect(sharesToWeights(Array(6).fill(1 / 6))).toEqual([16.67, 16.67, 16.67, 16.67, 16.66, 16.66]);
    expect(sharesToWeights(Array(7).fill(1 / 7))).toEqual([14.29, 14.29, 14.29, 14.29, 14.28, 14.28, 14.28]);
  });

  it("доли сервера с округлением (0,3333 × 3) тоже складываются в 100", () => {
    const w = sharesToWeights([0.3333, 0.3333, 0.3333]);
    expect(sum(w)).toBe(100);
    expect(Math.abs(sum(w) - 100)).toBeLessThan(SHARE_SUM_TOLERANCE);
  });

  it("ручные доли не трогает: 70/30 остаются 70/30", () => {
    expect(sharesToWeights([0.7, 0.3])).toEqual([70, 30]);
    expect(sharesToWeights([0.5, 0.25, 0.25])).toEqual([50, 25, 25]);
  });

  it("неровные доли: лишняя сотая идёт к наибольшему остатку, сумма 100", () => {
    const w = sharesToWeights([0.123456, 0.376544, 0.5]);
    expect(sum(w)).toBe(100);
    expect(w[2]).toBe(50);
  });

  it("пустой список и нулевая сумма не дают NaN", () => {
    expect(sharesToWeights([])).toEqual([]);
    expect(sharesToWeights([0, 0])).toEqual([0, 0]);
    expect(sharesToWeights([Number.NaN, 0.5])).toEqual([0, 100]);
  });
});

describe("подпись про цену клиента", () => {
  it("не утверждает «всегда выше»", () => {
    expect(LEAD_VS_META_HINT).not.toMatch(/всегда выше/);
    expect(LEAD_VS_META_HINT).toMatch(/обычно выше/);
  });
});

describe("parseWeight", () => {
  it("принимает запятую и точку", () => {
    expect(parseWeight("33,5")).toBe(33.5);
    expect(parseWeight(" 25 ")).toBe(25);
  });
  it("отвергает пусто, ноль, минус, текст и выше предела", () => {
    for (const bad of ["", "0", "-5", "abc", "1001"]) expect(parseWeight(bad)).toBeNull();
  });
  it("weightToField убирает хвост", () => {
    expect(weightToField(25)).toBe("25");
    expect(weightToField(33.3333)).toBe("33,33");
  });
});

describe("formatPct и agoRu", () => {
  it("процент с запятой", () => {
    expect(formatPct(0.3)).toMatch(/^0,3\s%$/);
    expect(formatPct(25)).toMatch(/^25\s%$/);
  });
  it("минуты и часы по-русски", () => {
    const now = Date.UTC(2026, 9, 3, 12, 0, 0);
    const ago = (min: number) => agoRu(new Date(now - min * 60_000).toISOString(), now);
    expect(ago(0)).toBe("только что");
    expect(ago(1)).toBe("1 минуту назад");
    expect(ago(5)).toBe("5 минут назад");
    expect(ago(22)).toBe("22 минуты назад");
    expect(ago(120)).toBe("2 часа назад");
  });
});

describe("pickLeaderboard", () => {
  const row = (id: string, spend: number, conv: number) => ({
    propertyId: id,
    spendTjs: spend,
    conversations: conv,
    costPerConversationTjs: conv > 0 ? spend / conv : null,
  });
  it("«дешёвые» — только с обращениями, по возрастанию цены", () => {
    const { cheap } = pickLeaderboard([row("a", 100, 0), row("b", 100, 10), row("c", 100, 2)]);
    expect(cheap.map((r) => r.propertyId)).toEqual(["b", "c"]);
  });
  it("объект без обращений не получает цену 0 и не бывает «дешёвым»", () => {
    const { cheap, costly } = pickLeaderboard([row("z", 50, 0), row("a", 100, 5)]);
    expect(cheap.map((r) => r.propertyId)).toEqual(["a"]);
    expect(costly.map((r) => r.propertyId)).toEqual(["z"]);
  });
  it("«дорогие»: сначала без обращений по трате, затем дорогие, без повторов с «дешёвыми»", () => {
    const rows = [
      row("a", 10, 10),
      row("b", 20, 10),
      row("c", 30, 10),
      row("d", 40, 10),
      row("e", 50, 10),
      row("f", 600, 10), // дорогое обращение
      row("g", 90, 0), // денег ушло, обращений нет
      row("h", 5, 0),
    ];
    const { cheap, costly } = pickLeaderboard(rows);
    expect(cheap.map((r) => r.propertyId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(costly.map((r) => r.propertyId)).toEqual(["g", "h", "f"]);
  });
  it("без трат в «дорогие» не попадает", () => {
    expect(pickLeaderboard([row("x", 0, 0)]).costly).toEqual([]);
  });
});
