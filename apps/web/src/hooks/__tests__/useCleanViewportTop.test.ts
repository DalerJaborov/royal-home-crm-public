import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as (() => (() => void) | undefined)[] }));
vi.mock("react", () => ({
  useLayoutEffect: (effect: () => (() => void) | undefined) => { hooks.effects.push(effect); },
}));
import { useCleanViewport } from "../useCleanViewport";
const callHook = useCleanViewport as (enabled: boolean) => void;

/**
 * Safari при открытой клавиатуре сдвигает ВИДИМУЮ область вниз (offsetTop > 0), а переписка
 * на весь экран — `position: fixed; top: 0` — уезжала за верх экрана: поле ввода под шапкой,
 * под ним пустота (кадр 12, 20.11.2026). Хук отдаёт CSS высоту И верх видимой области.
 */
describe("useCleanViewport: верх видимой области", () => {
  const props = new Map<string, string>();
  const vv = { height: 448, offsetTop: 396 };
  const dataset: Record<string, string> = {};
let focused = true;
let field: unknown = null;

  beforeEach(() => {
    hooks.effects.length = 0; props.clear(); focused = true;
    for (const key of Object.keys(dataset)) delete dataset[key];
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
    class Field { matches() { return true; } isContentEditable = false; }
    vi.stubGlobal("HTMLElement", Field);
    field = new Field();
    vi.stubGlobal("window", {
      innerHeight: 844, setTimeout: () => 0, clearTimeout: () => undefined, requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      visualViewport: { get height() { return vv.height; }, get offsetTop() { return vv.offsetTop; }, addEventListener: () => undefined, removeEventListener: () => undefined },
    });
    vi.stubGlobal("document", {
      body: {}, get activeElement() { return focused ? field : null; }, querySelector: () => null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      documentElement: { dataset, style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("высота и верх видимой области уходят в переменные, при закрытии убираются", () => {
    callHook(true);
    const cleanup = hooks.effects.pop()!()!;
    expect(props.get("--clean-viewport-height")).toBe("448px");
    expect(props.get("--clean-viewport-top")).toBe("396px");
    cleanup();
    expect(props.has("--clean-viewport-top")).toBe(false);
  });

  it("клавиатура закрылась (поле без фокуса) — верх строго 0, даже если iOS ещё держит offsetTop", () => {
    focused = false;
    callHook(true);
    const cleanup = hooks.effects.pop()!()!;
    expect(props.get("--clean-viewport-top")).toBe("0px");
    cleanup();
  });

  it("без клавиатуры верх — 0px, отрицательный (резиновая прокрутка) не уходит в минус", () => {
    vv.height = 844; vv.offsetTop = -12;
    callHook(true);
    const cleanup = hooks.effects.pop()!()!;
    expect(props.get("--clean-viewport-top")).toBe("0px");
    cleanup();
    vv.offsetTop = 396; vv.height = 448;
  });
});
