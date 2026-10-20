import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Запасная копия мастера не должна стираться, пока ответ сервера про черновик
 * не пришёл (находка Codex №12, 04.10.2026).
 *
 * jsdom и Testing Library в проекте не установлены (vitest.config.ts: окружение
 * "node"), поэтому React подменён минимальным рантаймом хуков: useRef/useEffect
 * с зависимостями и уборкой. Этого хватает, чтобы прогнать хук по времени с
 * управляемыми таймерами, ровно как делает мастер.
 */
type Effect = { deps: unknown[] | undefined; cleanup?: void | (() => void) };
const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  idx: 0,
  pending: [] as Array<() => void>,
}));

vi.mock("react", () => ({
  useRef: (init: unknown) => {
    const i = rt.idx++;
    if (!(i in rt.slots)) rt.slots[i] = { current: init };
    return rt.slots[i];
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = rt.idx++;
    const prev = rt.slots[i] as Effect | undefined;
    const changed = !prev || !deps || !prev.deps || deps.some((d, k) => !Object.is(d, prev.deps![k]));
    if (!changed) return;
    rt.pending.push(() => {
      if (prev && typeof prev.cleanup === "function") prev.cleanup();
      const slot: Effect = { deps, cleanup: undefined };
      rt.slots[i] = slot;
      slot.cleanup = fn();
    });
  },
}));

import { loadFormDraft } from "../../../hooks/useFormDraft";
import { EMPTY_WIZARD_VALUES, type WizardValues } from "../types";
import { useWizardLocalDraft } from "../useWizardLocalDraft";

const KEY = "property-wizard:agent-1";
const STORAGE_KEY = `royal-home-draft:${KEY}`;

function useRenderPass(draftKey: string | null, armed: boolean, values: WizardValues): void {
  rt.idx = 0;
  rt.pending = [];
  useWizardLocalDraft(draftKey, armed, values);
  for (const run of rt.pending) run();
}

const store = new Map<string, string>();

beforeEach(() => {
  vi.useFakeTimers();
  rt.slots = [];
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  // Непустой черновик, оставшийся от прошлого захода агента.
  const saved: WizardValues = { ...EMPTY_WIZARD_VALUES, address: "ул. Рудаки 10", price: "85000" };
  store.set(STORAGE_KEY, JSON.stringify({ at: Date.now(), value: saved }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("запасная копия мастера пока ответ сервера в пути", () => {
  it("пустые значения до армирования НЕ стирают копию (ответ дольше 400 мс)", () => {
    useRenderPass(KEY, false, { ...EMPTY_WIZARD_VALUES });
    vi.advanceTimersByTime(500);
    expect(store.has(STORAGE_KEY)).toBe(true);
  });

  it("стартовый снимок только с интейкером до армирования НЕ затирает копию", () => {
    useRenderPass(KEY, false, { ...EMPTY_WIZARD_VALUES, intakeAgentId: "agent-9" });
    vi.advanceTimersByTime(500);
    const kept = loadFormDraft<WizardValues>(KEY);
    expect(kept?.address).toBe("ул. Рудаки 10");
  });

  it("сервер упал: onFailed находит копию и может предложить «продолжить»", () => {
    useRenderPass(KEY, false, { ...EMPTY_WIZARD_VALUES });
    vi.advanceTimersByTime(1000); // «ответ» приходит позже 400 мс
    const local = loadFormDraft<WizardValues>(KEY);
    expect(local).not.toBeNull();
    expect(local?.price).toBe("85000");
  });

  it("после армирования запись возобновляется как раньше", () => {
    useRenderPass(KEY, false, { ...EMPTY_WIZARD_VALUES });
    vi.advanceTimersByTime(1000);
    useRenderPass(KEY, true, { ...EMPTY_WIZARD_VALUES, address: "новый адрес" });
    vi.advanceTimersByTime(500);
    expect(loadFormDraft<WizardValues>(KEY)?.address).toBe("новый адрес");
  });

  it("после армирования пустая форма по-прежнему чистит копию", () => {
    useRenderPass(KEY, true, { ...EMPTY_WIZARD_VALUES });
    vi.advanceTimersByTime(500);
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});
