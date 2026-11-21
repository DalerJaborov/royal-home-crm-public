import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readKeyboard, trackKeyboard } from "../keyboardInset";

/**
 * Клавиатура телефона (21.11.2026, аудит К07): нижнее меню оставалось над ней на всех экранах с полем,
 * подвал шторки уходил под неё. Расчёт один — `readKeyboard`; переменные на <html> ставит `trackKeyboard`.
 */
describe("readKeyboard", () => {
  it("клавиатуры нет — всё закрыто, отступ 0", () => {
    expect(readKeyboard(844, { height: 844, offsetTop: 0 })).toEqual({ open: false, inset: 0, height: 844 });
  });
  it("клавиатура 336 px: открыто, отступ 336", () => {
    expect(readKeyboard(844, { height: 508, offsetTop: 0 })).toEqual({ open: true, inset: 336, height: 508 });
  });
  it("Safari сдвинул видимую область вниз: отступ считается от её низа, а не от высоты", () => {
    expect(readKeyboard(844, { height: 448, offsetTop: 300 }).inset).toBe(96);
  });
  it("сдвиг почти на всю клавиатуру: остаток в 56 px поднимаем на настоящие 56 px, не обнуляем", () => {
    const k = readKeyboard(844, { height: 508, offsetTop: 280 });
    expect(k).toEqual({ open: true, inset: 56, height: 508 });
  });
  it("сдвинули ровно на всю клавиатуру: открыто, подъём 0", () => {
    expect(readKeyboard(844, { height: 508, offsetTop: 336 })).toMatchObject({ open: true, inset: 0 });
  });
  it("дрожание адресной строки (60 px) клавиатурой не считается", () => {
    expect(readKeyboard(844, { height: 784, offsetTop: 0 })).toMatchObject({ open: false, inset: 0 });
  });
  it("щипок-масштаб уменьшает видимую область, но это не клавиатура", () => {
    expect(readKeyboard(844, { height: 400, offsetTop: 0, scale: 2.1 }).open).toBe(false);
  });
});

describe("trackKeyboard", () => {
  const props = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const listeners = new Map<string, Set<() => void>>();
  const docFocusOut = new Set<() => void>();
  const vv = { height: 844, offsetTop: 0, scale: 1 };
  const fire = () => { for (const t of ["resize", "scroll"]) for (const cb of listeners.get(t) ?? []) cb(); };

  beforeEach(() => {
    props.clear(); listeners.clear();
    for (const k of Object.keys(dataset)) delete dataset[k];
    vv.height = 844; vv.offsetTop = 0; vv.scale = 1;
    vi.stubGlobal("window", {
      innerHeight: 844,
      visualViewport: {
        get height() { return vv.height; }, get offsetTop() { return vv.offsetTop; }, get scale() { return vv.scale; },
        addEventListener: (t: string, cb: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(cb); },
        removeEventListener: (t: string, cb: () => void) => { listeners.get(t)?.delete(cb); },
      },
    });
    vi.stubGlobal("document", {
      addEventListener: (t: string, cb: () => void) => { if (t === "focusout") docFocusOut.add(cb); },
      removeEventListener: (t: string, cb: () => void) => { if (t === "focusout") docFocusOut.delete(cb); },
      documentElement: { dataset, style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("клавиатура открылась: переменные и признак стоят, закрылась: признак снят, высота убрана, отступ 0", () => {
    const off = trackKeyboard();
    expect(props.get("--rh-kb-inset")).toBe("0px");
    expect(dataset.kbOpen).toBeUndefined();
    vv.height = 508; fire();
    expect(props.get("--rh-kb-inset")).toBe("336px");
    expect(props.get("--rh-vv-h")).toBe("508px");
    expect(dataset.kbOpen).toBe("1");
    vv.height = 844; fire();
    expect(props.get("--rh-kb-inset")).toBe("0px");
    expect(props.has("--rh-vv-h")).toBe(false);
    expect(dataset.kbOpen).toBeUndefined();
    off();
  });

  it("два подписчика (оболочка и шторка): уход одного не снимает переменные у второго", () => {
    const shell = trackKeyboard();
    const sheet = trackKeyboard();
    vv.height = 508; fire();
    sheet();
    expect(dataset.kbOpen).toBe("1");
    expect(props.get("--rh-kb-inset")).toBe("336px");
    shell();
    expect(dataset.kbOpen).toBeUndefined();
    expect(props.has("--rh-kb-inset")).toBe(false);
    expect(listeners.get("resize")?.size ?? 0).toBe(0);
  });

  it("запасной пересчёт: resize пришёл после focusout — через 350 мс отступ всё равно снят", () => {
    vi.useFakeTimers();
    const off = trackKeyboard();
    vv.height = 508; fire();
    expect(dataset.kbOpen).toBe("1");
    vv.height = 844; // клавиатура закрылась, а resize iOS не прислал
    for (const cb of docFocusOut) cb();
    expect(dataset.kbOpen).toBe("1");
    vi.advanceTimersByTime(350);
    expect(dataset.kbOpen).toBeUndefined();
    off();
    expect(docFocusOut.size).toBe(0);
    vi.useRealTimers();
  });

  it("повторная отписка одного и того же подписчика счётчик не портит", () => {
    const a = trackKeyboard();
    const b = trackKeyboard();
    a(); a();
    vv.height = 508; fire();
    expect(dataset.kbOpen).toBe("1");
    b();
  });

  it("в стиль пишет только при изменении значения", () => {
    let writes = 0;
    const doc = document.documentElement.style as { setProperty: (k: string, v: string) => void };
    const orig = doc.setProperty;
    doc.setProperty = (k, v) => { writes++; orig(k, v); };
    const off = trackKeyboard();
    const after = writes;
    for (let i = 0; i < 6; i++) fire();
    expect(writes).toBe(after);
    off();
  });
});
