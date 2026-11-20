// @vitest-environment jsdom
import { act, createElement } from "react";
import * as ReactDomClient from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { RhButton, RhNavTabs, RhSegmented, RhTabs, rhButtonVariant, rhStepByKey } from "./ui";

/**
 * ОБЩИЕ ДЕТАЛИ КОНСТИТУЦИИ (пачка C, 20.11.2026): один Segmented, один Tabs, четыре вида кнопки,
 * выключенная кнопка — с причиной. Вид — в theme-look-royal.css (.ry-seg / .ry-tabs / .ry-btn).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactDomClient.Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });
function mount(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = ReactDomClient.createRoot(host);
  act(() => root!.render(node));
  return host;
}
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

describe("rhStepByKey — одно правило клавиш на переключатели", () => {
  const ids = ["a", "b", "c"] as const;
  it("стрелки по кругу, Home/End, прочее — ничего", () => {
    expect(rhStepByKey(ids, "a", "ArrowRight")).toBe("b");
    expect(rhStepByKey(ids, "c", "ArrowRight")).toBe("a");
    expect(rhStepByKey(ids, "a", "ArrowLeft")).toBe("c");
    expect(rhStepByKey(ids, "b", "ArrowDown")).toBe("c");
    expect(rhStepByKey(ids, "b", "Home")).toBe("a");
    expect(rhStepByKey(ids, "a", "End")).toBe("c");
    expect(rhStepByKey(ids, "a", "x")).toBeUndefined();
  });
  it("значение вне вариантов: вправо — первый, влево — последний", () => {
    expect(rhStepByKey(ids, "zz" as never, "ArrowRight")).toBe("a");
    expect(rhStepByKey(ids, undefined, "ArrowLeft")).toBe("c");
  });
});

describe("RhSegmented", () => {
  const options = [{ id: "s", label: "Продавцы" }, { id: "b", label: "Покупатели" }] as const;
  it("радиогруппа: выбран один, в Tab-порядке — он", () => {
    const html = renderToStaticMarkup(createElement(RhSegmented<"s" | "b">, { value: "b", options, onChange: () => {}, label: "Кого показать" }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Кого показать"');
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*data-rh-choice="b"[^>]*aria-checked="true"[^>]*tabindex="0"/);
    expect(html).toContain('class="ry-seg"');
  });
  it("значение вне вариантов — ничего не выбрано, в Tab-порядке первый", () => {
    const html = renderToStaticMarkup(createElement(RhSegmented<string>, { value: "paused", options, onChange: () => {}, label: "x" }));
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toMatch(/<button[^>]*data-rh-choice="s"[^>]*tabindex="0"/);
  });
  it("стрелка переключает и переводит фокус", () => {
    let value = "s";
    const el = mount(createElement(RhSegmented<string>, { value, options, onChange: (v) => { value = v; }, label: "x" }));
    key(el.querySelector('[data-rh-choice="s"]')!, "ArrowRight");
    expect(value).toBe("b");
  });
});

describe("RhTabs и RhNavTabs", () => {
  it("список вкладок связан с панелями, выбранная одна", () => {
    const html = renderToStaticMarkup(createElement(RhTabs<"short" | "hist">, {
      value: "hist", idPrefix: "card", label: "Разделы", onChange: () => {},
      tabs: [{ id: "short", label: "Кратко" }, { id: "hist", label: "История" }],
    }));
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="card-tab-hist"');
    expect(html).toContain('aria-controls="card-panel-hist"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('class="ry-tabs"');
  });
  it("клавиша End выбирает последнюю вкладку", () => {
    let value = "short";
    const el = mount(createElement(RhTabs<string>, {
      value, idPrefix: "t", label: "x", onChange: (v) => { value = v; },
      tabs: [{ id: "short", label: "А" }, { id: "props", label: "Б" }, { id: "hist", label: "В" }],
    }));
    key(el.querySelector("#t-tab-short")!, "End");
    expect(value).toBe("hist");
    expect(document.activeElement?.id).toBe("t-tab-hist");
  });
  it("вкладки-ссылки: текущая страница помечена aria-current", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RhNavTabs, {
      label: "Разделы обращений", items: [{ to: "/messages", label: "Чаты", current: true }, { to: "/calls", label: "Звонки", current: false }],
    })));
    expect(html).toContain('<nav aria-label="Разделы обращений" class="ry-tabs">');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

describe("RhButton — четыре вида, выключенная с причиной", () => {
  it("прежние имена — синонимы четырёх видов", () => {
    expect(rhButtonVariant("soft")).toBe("secondary");
    expect(rhButtonVariant("gray")).toBe("secondary");
    expect(rhButtonVariant("dark")).toBe("primary");
    expect(rhButtonVariant()).toBe("secondary");
    const html = renderToStaticMarkup(createElement(RhButton, { variant: "gray" }, "Повторить"));
    expect(html).toContain('data-variant="secondary"');
  });
  it("есть причина — кнопка выключена, причина видна и связана с кнопкой", () => {
    const html = renderToStaticMarkup(createElement(RhButton, { variant: "primary", disabledReason: "Выберите объекты — 0 из 5" }, "Отправить"));
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('title="Выберите объекты — 0 из 5"');
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<span id="${id}" class="ry-btn-reason">Выберите объекты — 0 из 5</span>`);
  });
  it("без причины — обычная кнопка без обёртки", () => {
    const html = renderToStaticMarkup(createElement(RhButton, { variant: "danger" }, "Удалить"));
    expect(html).toBe('<button type="button" class="ry-btn" data-variant="danger">Удалить</button>');
  });
});
