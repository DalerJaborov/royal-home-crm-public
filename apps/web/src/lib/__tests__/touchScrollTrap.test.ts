import { describe, expect, it } from "vitest";
import { shouldBlockTouchMove, touchFromOwnDom, type ScrollBox } from "../touchScrollTrap";

/** Прокрутка под открытым окном не «проваливается» (21.11.2026, владелец с iPhone). */
const feed = (top: number, maxTop = 1000): ScrollBox => ({ y: true, x: false, top, maxTop, left: 0, maxLeft: 0 });
const strip = (left: number, maxLeft = 300): ScrollBox => ({ y: false, x: true, top: 0, maxTop: 0, left, maxLeft });

describe("shouldBlockTouchMove", () => {
  it("лента посередине — палец двигает ленту", () => {
    expect(shouldBlockTouchMove(0, 12, [feed(400)])).toBe(false);
    expect(shouldBlockTouchMove(0, -12, [feed(400)])).toBe(false);
  });
  it("лента в самом верху, палец вниз — гасим (иначе тянется весь экран)", () => {
    expect(shouldBlockTouchMove(0, 12, [feed(0)])).toBe(true);
  });
  it("лента в самом низу, палец вверх — гасим", () => {
    expect(shouldBlockTouchMove(0, -12, [feed(1000)])).toBe(true);
  });
  it("палец по шапке или полю ввода (прокручивать нечего) — гасим: при клавиатуре это двигало бы видимую область", () => {
    expect(shouldBlockTouchMove(0, 20, [])).toBe(true);
    expect(shouldBlockTouchMove(0, -20, [])).toBe(true);
  });
  it("вертикальный жест на ленте вкладок внутри ленты сообщений решает лента сообщений", () => {
    expect(shouldBlockTouchMove(2, 15, [strip(0), feed(300)])).toBe(false);
  });
  it("горизонтальный жест по ленте вкладок — вкладки едут, у края гасим", () => {
    expect(shouldBlockTouchMove(-15, 2, [strip(100), feed(300)])).toBe(false);
    expect(shouldBlockTouchMove(15, 2, [strip(0), feed(300)])).toBe(true);
  });
  it("неподвижный палец не трогаем", () => {
    expect(shouldBlockTouchMove(0, 0, [])).toBe(false);
  });
});

describe("touchFromOwnDom", () => {
  const node = (children: unknown[] = []) => ({ contains: (n: unknown) => n === node || children.includes(n) });
  it("касание в своём DOM — наше, из портала поверх — чужое", () => {
    class FakeNode {}
    (globalThis as unknown as { Node: unknown }).Node ??= FakeNode;
    const N = (globalThis as unknown as { Node: new () => object }).Node;
    const inner = Object.assign(Object.create(N.prototype), {});
    const portal = Object.assign(Object.create(N.prototype), {});
    const own = Object.assign(Object.create(N.prototype), node([inner]));
    expect(touchFromOwnDom({ currentTarget: own, target: inner })).toBe(true);
    expect(touchFromOwnDom({ currentTarget: own, target: portal })).toBe(false);
    expect(touchFromOwnDom({ currentTarget: null, target: inner })).toBe(false);
  });
});
