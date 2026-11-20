import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as (() => (() => void) | undefined)[] }));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => { hooks.effects.push(effect); },
}));
import { useScrollLock } from "../useScrollLock";

/**
 * Серая полоса под нижней шторкой на iPhone (20.11.2026, три шторки на кадрах владельца):
 * низ layout viewport выше низа экрана. Хук должен отдать расхождение в `--rh-vv-over`,
 * пока шторка открыта, и убрать переменную при закрытии.
 */
describe("useScrollLock: --rh-vv-over", () => {
  const props = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const vv = { height: 844, offsetTop: 0 };
  const win = {
    innerHeight: 844, scrollY: 0, visualViewport: {
      get height() { return vv.height; }, get offsetTop() { return vv.offsetTop; },
      addEventListener: (t: string, cb: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(cb); },
      removeEventListener: (t: string, cb: () => void) => { listeners.get(t)?.delete(cb); },
    },
    addEventListener: () => undefined, removeEventListener: () => undefined, scrollTo: () => undefined,
  };

  beforeEach(() => {
    hooks.effects.length = 0; props.clear(); listeners.clear();
    vv.height = 844; vv.offsetTop = 0; win.innerHeight = 844;
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      body: { style: {} },
      documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  // Хук зовётся как обычная функция (react подменён): eslint рассматривает это как нарушение правил хуков.
  const callHook = useScrollLock as (enabled: boolean) => void;
  function open() {
    callHook(true);
    return hooks.effects.pop()!()!;
  }

  it("видимая область больше layout viewport на 62 px — переменная 62px, при закрытии убирается", () => {
    vv.height = 906;
    const close = open();
    expect(props.get("--rh-vv-over")).toBe("62px");
    close();
    expect(props.has("--rh-vv-over")).toBe(false);
  });

  it("расхождения нет или это шум — 0px", () => {
    const close = open();
    expect(props.get("--rh-vv-over")).toBe("0px");
    close();
    vv.height = 845;
    const again = open();
    expect(props.get("--rh-vv-over")).toBe("0px");
    again();
  });

  it("пересчитывается при изменении видимой области", () => {
    const close = open();
    vv.height = 900;
    for (const cb of listeners.get("resize") ?? []) cb();
    expect(props.get("--rh-vv-over")).toBe("56px");
    close();
  });

  it("в стиль <html> пишет только при изменении значения", () => {
    let writes = 0;
    (document.documentElement.style as { setProperty: (k: string, v: string) => void }).setProperty = (k, v) => { writes++; props.set(k, v); };
    vv.height = 906;
    const close = open();
    const afterOpen = writes;
    for (let i = 0; i < 5; i++) for (const cb of listeners.get("scroll") ?? []) cb();
    expect(writes).toBe(afterOpen);
    close();
  });

  it("огромное расхождение (клавиатура и т. п.) шторкой не «лечится»", () => {
    vv.height = 1200;
    const close = open();
    expect(props.get("--rh-vv-over")).toBe("0px");
    close();
  });
});
