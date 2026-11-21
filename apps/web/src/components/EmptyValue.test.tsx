// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_VALUE_TEXT, EmptyValue, valueOrEmpty } from "./EmptyValue";
import badgeSrc from "./ads/PropertyAdBadge.tsx?raw";
import tilesSrc from "./ads/AdsDirectorTiles.tsx?raw";

/**
 * ПУСТОЕ ЗНАЧЕНИЕ — ОДНО СЛОВО (К10.9 аудита 20.11): «нет», а не «0,00 с.» / «—» / «нет данных».
 */
describe("EmptyValue — пустое значение одним словом", () => {
  it("печатает «нет» обычным шрифтом, причина — в подсказке", () => {
    const { container } = render(<EmptyValue reason="расхода не было" />);
    const el = container.querySelector(".rh-empty")!;
    expect(el.textContent).toBe(EMPTY_VALUE_TEXT);
    expect(el.getAttribute("title")).toBe("расхода не было");
    expect(el.getAttribute("aria-label")).toBeNull();
  });
  it("valueOrEmpty: null, undefined и пустая строка — «нет»; ноль остаётся числом", () => {
    for (const empty of [null, undefined, ""]) {
      const { container } = render(<>{valueOrEmpty(empty)}</>);
      expect(container.textContent).toBe("нет");
    }
    const { container } = render(<>{valueOrEmpty("0")}</>);
    expect(container.textContent).toBe("0");
  });
  it("плитки рекламы не пишут «нет данных», «—» и «0,00 с.» вместо пустого значения", () => {
    for (const [file, source] of [["PropertyAdBadge.tsx", badgeSrc], ["AdsDirectorTiles.tsx", tilesSrc]] as const) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, file).not.toMatch(/(?<!!== )"нет данных"|"—"|"клиентов в CRM нет"/);
    }
  });
});
