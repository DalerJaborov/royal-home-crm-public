// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { blockState } from "../look/ui";
import { OFFLINE_TEXT, Rh2LoadProblem, loadView, type LoadQuery } from "./Rh2ErrorState";

/**
 * ЕДИНАЯ ФУНКЦИЯ «ЧТО С ЗАГРУЗКОЙ» (ревью #346): данные есть — их не прячем; нет данных и запрос на паузе — «Нет связи»;
 * нет данных и ошибка — «Не удалось загрузить»; иначе серые плашки. Запросы остаются в режиме react-query по умолчанию
 * (networkMode "online"): без связи они ждут и сами уходят, когда связь вернулась.
 */
const q = (over: Partial<LoadQuery>): LoadQuery & { refetch: () => unknown; isFetching: boolean } =>
  ({ data: undefined, isError: false, fetchStatus: "fetching", refetch: vi.fn(), isFetching: false, ...over });

describe("loadView", () => {
  it("есть данные — ready при ошибке обновления и при паузе: прежнее не прячем", () => {
    expect(loadView(q({ data: [] }))).toBe("ready");
    expect(loadView(q({ data: { items: [1] }, isError: true }))).toBe("ready");
    expect(loadView(q({ data: 0, fetchStatus: "paused" }))).toBe("ready");
  });
  it("нет данных: пауза — offline, ошибка — error, иначе loading", () => {
    expect(loadView(q({ fetchStatus: "paused" }))).toBe("offline");
    expect(loadView(q({ fetchStatus: "paused", isError: true }))).toBe("offline");
    expect(loadView(q({ isError: true, fetchStatus: "idle" }))).toBe("error");
    expect(loadView(q({}))).toBe("loading");
    expect(loadView(q({ fetchStatus: "idle" }))).toBe("loading");
  });
});

describe("Rh2LoadProblem и blockState", () => {
  const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
  it("нет связи: «Нет связи. Загрузим, как только она появится» и «Повторить»", () => {
    const card = html(createElement(Rh2LoadProblem, { query: q({ fetchStatus: "paused" }) }));
    expect(card).toContain(OFFLINE_TEXT);
    expect(card).toContain("Повторить");
    const block = html(createElement("div", null, blockState(q({ fetchStatus: "paused" }))));
    expect(block).toContain(OFFLINE_TEXT);
    expect(block).toContain("Повторить");
  });
  it("ошибка без данных: «Не удалось загрузить» / «Не загрузилось» и «Повторить»", () => {
    expect(html(createElement(Rh2LoadProblem, { query: q({ isError: true, fetchStatus: "idle" }) }))).toContain("Не удалось загрузить");
    const block = html(createElement("div", null, blockState(q({ isError: true, fetchStatus: "idle" }))));
    expect(block).toContain("Не загрузилось");
    expect(block).toContain("Повторить");
  });
  it("данные есть — ничего не рисуем (экран остаётся как был)", () => {
    expect(html(createElement(Rh2LoadProblem, { query: q({ data: [1], isError: true }) }))).toBe("");
    expect(blockState(q({ data: [1], isError: true }))).toBeNull();
    expect(blockState(q({ data: [1], fetchStatus: "paused" }))).toBeNull();
  });
  it("грузится — серые плашки без кнопки", () => {
    const block = html(createElement("div", null, blockState(q({}))));
    expect(block).toContain("ry-skeleton");
    expect(block).not.toContain("Повторить");
  });
});
