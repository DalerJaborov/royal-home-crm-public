import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLongPress, longPressAllowed } from "../mapLongPress";

// Долгое нажатие на карте (24.09.2026): щипок двумя пальцами открывал мастер
// нового объекта — второй палец перезаписывал таймер первого, не погасив его.
describe("longPressAllowed", () => {
  it("один палец на холсте — можно", () => {
    expect(longPressAllowed({ touchCount: 1, onCanvas: true })).toBe(true);
  });
  it("мышь (касаний 0) на холсте — можно", () => {
    expect(longPressAllowed({ touchCount: 0, onCanvas: true })).toBe(true);
  });
  it("два пальца — нельзя", () => {
    expect(longPressAllowed({ touchCount: 2, onCanvas: true })).toBe(false);
  });
  it("нажатие на плашке цены (не холст) — нельзя", () => {
    expect(longPressAllowed({ touchCount: 1, onCanvas: false })).toBe(false);
  });
});

describe("createLongPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const onFire = vi.fn();
    const lp = createLongPress<string>({ delayMs: 550, moveTolerancePx: 8, onFire });
    return { lp, onFire };
  };

  it("удержание одним пальцем срабатывает через 550 мс", () => {
    const { lp, onFire } = setup();
    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: true }, "A");
    vi.advanceTimersByTime(549);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledWith("A");
    expect(lp.consumeFired()).toBe(true);
    expect(lp.consumeFired()).toBe(false);
  });

  it("щипок: второй палец гасит таймер первого, мастер не открывается", () => {
    const { lp, onFire } = setup();
    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: true }, "первый палец");
    vi.advanceTimersByTime(100);
    lp.start({ x: 60, y: 60, touchCount: 2, onCanvas: true }, "второй палец");
    vi.advanceTimersByTime(2000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("второе касание без отпускания первого не копит таймеры", () => {
    const { lp, onFire } = setup();
    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: true }, "A");
    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: true }, "B");
    vi.advanceTimersByTime(2000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("B");
  });

  it("движение двумя пальцами отменяет жест", () => {
    const { lp, onFire } = setup();
    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: true }, "A");
    lp.move({ x: 10, y: 10, touchCount: 2 });
    vi.advanceTimersByTime(2000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("сдвиг пальца дальше допуска отменяет, дрожание в пределах — нет", () => {
    const { lp, onFire } = setup();
    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: true }, "A");
    lp.move({ x: 14, y: 14, touchCount: 1 });
    vi.advanceTimersByTime(600);
    expect(onFire).toHaveBeenCalledTimes(1);

    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: true }, "B");
    lp.move({ x: 30, y: 10, touchCount: 1 });
    vi.advanceTimersByTime(600);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("удержание на плашке цены не открывает мастер", () => {
    const { lp, onFire } = setup();
    lp.start({ x: 10, y: 10, touchCount: 1, onCanvas: false }, "A");
    vi.advanceTimersByTime(2000);
    expect(onFire).not.toHaveBeenCalled();
  });
});
