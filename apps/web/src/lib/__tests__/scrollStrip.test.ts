import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STRIP_CLASSES, stripMore } from "../scrollStrip";

describe("stripMore: ряд листается вбок — где ещё есть (аудит К20)", () => {
  it("всё поместилось — признака нет", () => {
    expect(stripMore({ scrollLeft: 0, scrollWidth: 390, clientWidth: 390 })).toBe("none");
    expect(stripMore({ scrollLeft: 0, scrollWidth: 393, clientWidth: 390 })).toBe("none"); // шум округления
  });
  it("в начале ряда дальше есть вправо", () => {
    expect(stripMore({ scrollLeft: 0, scrollWidth: 520, clientWidth: 390 })).toBe("end");
  });
  it("в середине — есть и слева, и справа", () => {
    expect(stripMore({ scrollLeft: 60, scrollWidth: 520, clientWidth: 390 })).toBe("both");
  });
  it("докручен до конца — затухание только слева", () => {
    expect(stripMore({ scrollLeft: 130, scrollWidth: 520, clientWidth: 390 })).toBe("start");
    expect(stripMore({ scrollLeft: 128.5, scrollWidth: 520, clientWidth: 390 })).toBe("start");
  });
  it("RTL (отрицательная прокрутка) считается так же", () => {
    expect(stripMore({ scrollLeft: -60, scrollWidth: 520, clientWidth: 390 })).toBe("both");
  });
});

describe("список рядов в JS совпадает со списком в CSS", () => {
  it("правило `animation: ry-strip-more` и STRIP_CLASSES называют одни и те же классы", () => {
    const css = readFileSync(new URL("../../theme-look-royal.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /([^{}]+)\{[^{}]*animation:\s*ry-strip-more\b/.exec(css);
    expect(rule, "в theme-look-royal.css нет правила затухания рядов").not.toBeNull();
    const inCss = [...rule![1].matchAll(/\.([\w-]+)/g)].map((m) => m[1]).sort();
    expect([...STRIP_CLASSES].sort()).toEqual(inCss);
  });
});
