import { afterEach, describe, expect, it, vi } from "vitest";
import { AXIS_LOCK_PX, cursorGesture, gestureAxis, shouldBlockTouchMove, touchFromOwnDom, touchIsExempt, type ScrollLink } from "../touchScrollTrap";

/** Прокрутка под открытым окном не «проваливается» (21.11.2026, владелец с iPhone; ревью #375). */
const feed = (top: number, maxTop = 1000): ScrollLink => ({ el: { scrollTop: top, scrollLeft: 0 }, y: true, x: false, maxTop, maxLeft: 0 });
const strip = (left: number, maxLeft = 300): ScrollLink => ({ el: { scrollTop: 0, scrollLeft: left }, y: false, x: true, maxTop: 0, maxLeft });

describe("shouldBlockTouchMove", () => {
  it("лента посередине — палец двигает ленту", () => {
    expect(shouldBlockTouchMove("y", 12, [feed(400)])).toBe(false);
    expect(shouldBlockTouchMove("y", -12, [feed(400)])).toBe(false);
  });
  it("лента в самом верху, палец вниз — гасим (иначе тянется весь экран)", () => {
    expect(shouldBlockTouchMove("y", 12, [feed(0)])).toBe(true);
  });
  it("лента в самом низу, палец вверх — гасим", () => {
    expect(shouldBlockTouchMove("y", -12, [feed(1000)])).toBe(true);
  });
  it("палец по шапке или полю ввода (прокручивать нечего) — гасим: при клавиатуре это двигало бы видимую область", () => {
    expect(shouldBlockTouchMove("y", 20, [])).toBe(true);
    expect(shouldBlockTouchMove("y", -20, [])).toBe(true);
  });
  it("упёрлось поле ввода или вложенная лента — жест едет к следующему прокручиваемому предку, а не гасится", () => {
    const textarea = feed(0, 80);
    expect(shouldBlockTouchMove("y", 15, [textarea, feed(300)])).toBe(false);
    expect(shouldBlockTouchMove("y", 15, [textarea, feed(0)])).toBe(true);
  });
  it("горизонтальный жест по ленте вкладок — вкладки едут, у края гасим", () => {
    expect(shouldBlockTouchMove("x", -15, [strip(100), feed(300)])).toBe(false);
    expect(shouldBlockTouchMove("x", 15, [strip(0), feed(300)])).toBe(true);
  });
  it("вертикальный жест по ленте вкладок внутри ленты сообщений решает лента сообщений", () => {
    expect(shouldBlockTouchMove("y", 15, [strip(0), feed(300)])).toBe(false);
  });
  it("неподвижный палец не трогаем", () => {
    expect(shouldBlockTouchMove("y", 0, [])).toBe(false);
  });
  it("решение читает текущий scrollTop: лента доехала до верха посреди жеста — дальше гасим", () => {
    const link = feed(5);
    expect(shouldBlockTouchMove("y", 10, [link])).toBe(false);
    (link.el as { scrollTop: number }).scrollTop = 0;
    expect(shouldBlockTouchMove("y", 10, [link])).toBe(true);
  });
});

describe("gestureAxis", () => {
  it(`до ${AXIS_LOCK_PX} px ось не зафиксирована, после — держится до конца жеста`, () => {
    expect(gestureAxis(null, 2, 3)).toEqual({ axis: "y", lock: null });
    expect(gestureAxis(null, 1, AXIS_LOCK_PX)).toEqual({ axis: "y", lock: "y" });
    // Палец ушёл вбок уже после фиксации — ось прежняя.
    expect(gestureAxis("y", 40, 8)).toEqual({ axis: "y", lock: "y" });
    expect(gestureAxis(null, -9, 2)).toEqual({ axis: "x", lock: "x" });
  });
});

describe("touchIsExempt и курсор", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ev = (touches: number) => ({ touches: { length: touches }, target: null }) as unknown as TouchEvent;
  it("щипок двумя пальцами и увеличенная страница не гасятся (увеличенное фото не застревает)", () => {
    vi.stubGlobal("window", { getSelection: () => ({ isCollapsed: true }) });
    vi.stubGlobal("Element", class {});
    vi.stubGlobal("HTMLTextAreaElement", class {});
    vi.stubGlobal("HTMLInputElement", class {});
    expect(touchIsExempt(ev(2), 1)).toBe(true);
    expect(touchIsExempt(ev(1), 2.5)).toBe(true);
    expect(touchIsExempt(ev(1), 1.005)).toBe(false);
  });
  it("идёт выделение текста — не трогаем", () => {
    vi.stubGlobal("window", { getSelection: () => ({ isCollapsed: false }) });
    vi.stubGlobal("Element", class {});
    vi.stubGlobal("HTMLTextAreaElement", class {});
    vi.stubGlobal("HTMLInputElement", class {});
    expect(touchIsExempt(ev(1), 1)).toBe(true);
  });
  it("горизонтальный жест по полю ввода — курсор, не трогаем; вертикальный — решает ловушка", () => {
    class El {}
    class TA extends El {}
    vi.stubGlobal("Element", El);
    vi.stubGlobal("HTMLTextAreaElement", TA);
    vi.stubGlobal("HTMLInputElement", class extends El {});
    vi.stubGlobal("HTMLElement", El);
    const field = new TA() as unknown as EventTarget;
    expect(cursorGesture(field, "x")).toBe(true);
    expect(cursorGesture(field, "y")).toBe(false);
    expect(cursorGesture(new El() as unknown as EventTarget, "x")).toBe(false);
  });
});

describe("touchFromOwnDom", () => {
  it("касание в своём DOM — наше, из портала поверх — чужое", () => {
    class FakeNode {}
    (globalThis as unknown as { Node: unknown }).Node ??= FakeNode;
    const N = (globalThis as unknown as { Node: new () => object }).Node;
    const inner = Object.create(N.prototype);
    const portal = Object.create(N.prototype);
    const own = Object.assign(Object.create(N.prototype), { contains: (n: unknown) => n === inner });
    expect(touchFromOwnDom({ currentTarget: own, target: inner })).toBe(true);
    expect(touchFromOwnDom({ currentTarget: own, target: portal })).toBe(false);
    expect(touchFromOwnDom({ currentTarget: null, target: inner })).toBe(false);
  });
});
