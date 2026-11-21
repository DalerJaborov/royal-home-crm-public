import { describe, expect, it } from "vitest";
import { blockOrder, compareDelta, defaultPeriod, minutesLabel, sharePct, percentLabel, planRemainder, sortRows } from "./directorFormat";

describe("compareDelta", () => {
  it("рост хорошего — зелёный, рост плохого — не зелёный", () => {
    expect(compareDelta(15, 10, "up")?.tone).toBe("good");
    expect(compareDelta(15, 10, "down")?.tone).toBe("bad");
    expect(compareDelta(5, 10, "down")?.tone).toBe("good");
  });
  it("текст со склонением; нет базы — null", () => {
    expect(compareDelta(15, 10, "up", ["заявка", "заявки", "заявок"])?.text).toBe("на 5 заявок больше, чем в прошлом периоде");
    expect(compareDelta(5, null)).toBeNull();
    expect(compareDelta(Number.NaN, 1)).toBeNull();
    expect(compareDelta(3, 3)?.arrow).toBe("flat");
  });
});

describe("проценты и время", () => {
  it("sharePct без деления на ноль", () => {
    expect(sharePct(1, 3)).toBe(33);
    expect(sharePct(1, 0)).toBeNull();
    expect(percentLabel(null)).toBe("—");
  });
  it("minutesLabel", () => {
    expect(minutesLabel(45)).toBe("45 мин");
    expect(minutesLabel(130)).toBe("2 ч 10 мин");
    expect(minutesLabel(60 * 27)).toBe("1 д 3 ч");
    expect(minutesLabel(null)).toBe("—");
  });
  it("planRemainder", () => {
    expect(planRemainder(7, 10)).toBe("осталось 3");
    expect(planRemainder(12, 10)).toBe("план перевыполнен на 2");
    expect(planRemainder(10, 10)).toBe("план выполнен");
  });
});

describe("sortRows", () => {
  const rows = [{ n: "Бобур", v: 3 }, { n: "Алишер", v: null }, { n: "Ёдгор", v: 9 }];
  it("пустые внизу в обоих направлениях", () => {
    expect(sortRows(rows, (r) => r.v, "desc").map((r) => r.n)).toEqual(["Ёдгор", "Бобур", "Алишер"]);
    expect(sortRows(rows, (r) => r.v, "asc").map((r) => r.n)).toEqual(["Бобур", "Ёдгор", "Алишер"]);
  });
  it("имена по-русски, исходник не меняется", () => {
    expect(sortRows(rows, (r) => r.n, "asc").map((r) => r.n)).toEqual(["Алишер", "Бобур", "Ёдгор"]);
    expect(rows[0].n).toBe("Бобур");
  });
});

describe("роли", () => {
  it("период по умолчанию", () => {
    expect(defaultPeriod("HEAD_OF_SALES")).toBe("week");
    expect(defaultPeriod("DIRECTOR")).toBe("month");
  });
  it("порядок блоков и деньги", () => {
    expect(blockOrder("DIRECTOR", true)[0]).toBe("plan");
    expect(blockOrder("HEAD_OF_SALES", true)[0]).toBe("speed");
    expect(blockOrder("DIRECTOR", false)).not.toContain("plan");
  });
});
