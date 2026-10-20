import { describe, expect, it } from "vitest";
import { resolveNextCursor } from "../resolveNextCursor";

/** LOCAL-ONLY-WEB03: после последней догруженной страницы курсор не возвращается к первому (04.10.2026). */
describe("resolveNextCursor", () => {
  it("догрузки ещё не было: курсор первой страницы", () => {
    expect(resolveNextCursor(undefined, "X")).toBe("X");
    expect(resolveNextCursor(undefined, undefined)).toBeNull();
  });

  it("догрузили, есть следующая: её курсор", () => {
    expect(resolveNextCursor("Y", "X")).toBe("Y");
  });

  it("последняя догруженная страница вернула null: больше страниц нет, а не «X» снова", () => {
    expect(resolveNextCursor(null, "X")).toBeNull();
  });
});
