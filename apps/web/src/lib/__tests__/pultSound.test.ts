import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PULT_SOUND_MAX_PER_HOUR,
  PULT_SOUND_MIN_GAP_MS,
  PultSoundThrottle,
  isPultSoundworthyKind,
  pultSoundEnvironmentAllows,
} from "../pultSound";

/**
 * Троттлинг звука пульта (spec-pult-v8-07-09.md §7): не чаще 1 раз/3 мин,
 * не более 8/час. Логика чистая (без DOM) — тестируем классом напрямую,
 * тем же приёмом, что `store/undoToast.ts` (environment: "node").
 */
describe("PultSoundThrottle: троттлинг §7", () => {
  let throttle: PultSoundThrottle;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    throttle = new PultSoundThrottle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("разрешает первый звук сразу", () => {
    expect(throttle.canPlay(Date.now())).toBe(true);
  });

  it("не чаще раза в 3 минуты — блокирует второй звук раньше окна", () => {
    throttle.record(Date.now());
    vi.advanceTimersByTime(PULT_SOUND_MIN_GAP_MS - 1);
    expect(throttle.canPlay(Date.now())).toBe(false);
  });

  it("разрешает следующий звук ровно по истечении 3 минут", () => {
    throttle.record(Date.now());
    vi.advanceTimersByTime(PULT_SOUND_MIN_GAP_MS);
    expect(throttle.canPlay(Date.now())).toBe(true);
  });

  it("не более 8 звуков в час, даже с соблюдением 3-минутного зазора", () => {
    // 8 звуков ровно по 3 минуты друг за другом укладываются в 21 минуту — все внутри часа.
    for (let i = 0; i < PULT_SOUND_MAX_PER_HOUR; i++) {
      expect(throttle.canPlay(Date.now())).toBe(true);
      throttle.record(Date.now());
      vi.advanceTimersByTime(PULT_SOUND_MIN_GAP_MS);
    }
    // 9-й звук — тот же зазор соблюдён, но лимит в час исчерпан.
    expect(throttle.canPlay(Date.now())).toBe(false);
  });

  it("лимит в час освобождается, когда старые звуки выходят из скользящего окна", () => {
    for (let i = 0; i < PULT_SOUND_MAX_PER_HOUR; i++) {
      throttle.record(Date.now());
      vi.advanceTimersByTime(PULT_SOUND_MIN_GAP_MS);
    }
    expect(throttle.canPlay(Date.now())).toBe(false);
    // Проходит остаток часа с момента самого первого звука (t=0).
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(throttle.canPlay(Date.now())).toBe(true);
  });

  it("reset() возвращает троттл в чистое состояние", () => {
    throttle.record(Date.now());
    expect(throttle.canPlay(Date.now())).toBe(false);
    throttle.reset();
    expect(throttle.canPlay(Date.now())).toBe(true);
  });
});

describe("isPultSoundworthyKind: только «ждёт вас» / «вопрос ко мне» (§7)", () => {
  it("awaitsYou и question — да", () => {
    expect(isPultSoundworthyKind("awaitsYou")).toBe(true);
    expect(isPultSoundworthyKind("question")).toBe(true);
  });

  it("остальные виды (лента, звонки, сообщения клиентов) — нет", () => {
    expect(isPultSoundworthyKind("audit")).toBe(false);
    expect(isPultSoundworthyKind("interaction")).toBe(false);
    expect(isPultSoundworthyKind("lead")).toBe(false);
    expect(isPultSoundworthyKind("")).toBe(false);
  });
});

describe("pultSoundEnvironmentAllows: гейты document.hidden / reduced-motion", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("разрешает, если document/window недоступны (SSR)", () => {
    // @ts-expect-error — намеренно убираем глобали для теста окружения без DOM
    delete globalThis.document;
    // @ts-expect-error
    delete globalThis.window;
    expect(pultSoundEnvironmentAllows()).toBe(true);
  });

  it("блокирует, когда вкладка скрыта", () => {
    (globalThis as { document?: unknown }).document = { hidden: true };
    expect(pultSoundEnvironmentAllows()).toBe(false);
  });

  it("блокирует при prefers-reduced-motion: reduce", () => {
    (globalThis as { document?: unknown }).document = { hidden: false };
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    };
    expect(pultSoundEnvironmentAllows()).toBe(false);
  });

  it("разрешает, когда вкладка видна и reduced-motion выключен", () => {
    (globalThis as { document?: unknown }).document = { hidden: false };
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: false }),
    };
    expect(pultSoundEnvironmentAllows()).toBe(true);
  });
});
