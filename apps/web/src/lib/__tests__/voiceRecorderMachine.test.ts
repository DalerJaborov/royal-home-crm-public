import { describe, expect, it } from "vitest";
import {
  CANCEL_DISTANCE_PX,
  cancelHintOpacity,
  downsampleLevels,
  gestureFromMove,
  isVoiceBusy,
  LOCK_DISTANCE_PX,
  recordedMs,
  VOICE_INITIAL,
  voiceReducer,
  type VoiceEvent,
  type VoiceState,
} from "../voiceRecorderMachine";

const run = (events: VoiceEvent[], from: VoiceState = VOICE_INITIAL) => events.reduce(voiceReducer, from);

describe("жест удержания", () => {
  it("малый сдвиг ничего не значит", () => {
    expect(gestureFromMove(-10, -10)).toBeNull();
    expect(gestureFromMove(0, 0)).toBeNull();
  });
  it("влево до порога — отмена, вверх до порога — замок", () => {
    expect(gestureFromMove(-CANCEL_DISTANCE_PX, 0)).toBe("cancel");
    expect(gestureFromMove(0, -LOCK_DISTANCE_PX)).toBe("lock");
  });
  it("по диагонали побеждает ось, ушедшая дальше от своего порога", () => {
    expect(gestureFromMove(-CANCEL_DISTANCE_PX * 2, -LOCK_DISTANCE_PX)).toBe("cancel");
    expect(gestureFromMove(-CANCEL_DISTANCE_PX, -LOCK_DISTANCE_PX * 2)).toBe("lock");
  });
  it("вправо и вниз жестом не считаются", () => {
    expect(gestureFromMove(200, 200)).toBeNull();
  });
  it("подпись отмены гаснет, но не исчезает совсем", () => {
    expect(cancelHintOpacity(0)).toBe(1);
    expect(cancelHintOpacity(-CANCEL_DISTANCE_PX)).toBeGreaterThan(0);
    expect(cancelHintOpacity(-1000)).toBeLessThan(0.2);
  });
});

describe("переходы записи", () => {
  it("удержание: нажал, разрешили, отпустил — отправка, затем покой", () => {
    const s = run([{ type: "press" }, { type: "granted", locked: false }]);
    expect(s.phase).toBe("holding");
    expect(run([{ type: "send" }], s).phase).toBe("sending");
    expect(run([{ type: "send" }, { type: "sent" }], s)).toEqual(VOICE_INITIAL);
  });
  it("мышь: запись сразу в замке", () => {
    expect(run([{ type: "press" }, { type: "granted", locked: true }]).phase).toBe("locked");
  });
  it("сдвиг вверх на удержании — замок; сдвиг хранится только на удержании", () => {
    const held = run([{ type: "press" }, { type: "granted", locked: false }, { type: "move", dx: -20, dy: -30 }]);
    expect(held).toMatchObject({ phase: "holding", dx: -20, dy: -30 });
    expect(run([{ type: "lock" }], held)).toEqual({ ...VOICE_INITIAL, phase: "locked" });
    // сдвиг вправо/вниз не уходит в плюс
    expect(run([{ type: "move", dx: 50, dy: 50 }], held)).toMatchObject({ dx: 0, dy: 0 });
  });
  it("замок: пауза и продолжение", () => {
    const locked = run([{ type: "press" }, { type: "granted", locked: true }]);
    const paused = run([{ type: "pause" }], locked);
    expect(paused.phase).toBe("paused");
    expect(run([{ type: "resume" }], paused).phase).toBe("locked");
  });
  it("отправка возможна и с паузы", () => {
    const paused = run([{ type: "press" }, { type: "granted", locked: true }, { type: "pause" }]);
    expect(run([{ type: "send" }], paused).phase).toBe("sending");
  });
  it("отказ отправки возвращает на прослушивание: запись цела, продолжить нельзя, отправить заново можно", () => {
    const failed = run([{ type: "press" }, { type: "granted", locked: true }, { type: "send" }, { type: "failed" }]);
    expect(failed).toMatchObject({ phase: "paused", finished: true });
    expect(run([{ type: "resume" }], failed)).toBe(failed);
    expect(run([{ type: "send" }], failed).phase).toBe("sending");
  });
  it("отмена из любой фазы возвращает покой", () => {
    for (const events of [
      [{ type: "press" }],
      [{ type: "press" }, { type: "granted", locked: false }],
      [{ type: "press" }, { type: "granted", locked: true }, { type: "pause" }],
    ] as VoiceEvent[][]) {
      expect(run([...events, { type: "cancel" }])).toEqual(VOICE_INITIAL);
    }
  });
  it("отказ микрофона — покой; лишние события в покое ничего не ломают", () => {
    expect(run([{ type: "press" }, { type: "denied" }])).toEqual(VOICE_INITIAL);
    for (const type of ["lock", "pause", "resume", "send", "failed"] as const) {
      expect(run([{ type }])).toEqual(VOICE_INITIAL);
    }
  });
  it("повторное нажатие во время записи не перезапускает её", () => {
    const locked = run([{ type: "press" }, { type: "granted", locked: true }]);
    expect(run([{ type: "press" }], locked)).toBe(locked);
  });
  it("занятость строки ввода", () => {
    expect(isVoiceBusy(VOICE_INITIAL)).toBe(false);
    expect(isVoiceBusy(run([{ type: "press" }]))).toBe(true);
  });
});

describe("время и волна", () => {
  it("накопленное плюс текущий отрезок; на паузе отрезка нет", () => {
    expect(recordedMs(3000, 10_000, 12_500)).toBe(5500);
    expect(recordedMs(3000, null, 99_999)).toBe(3000);
    expect(recordedMs(0, 10_000, 9_000)).toBe(0);
  });
  it("волна сводится к нужному числу столбиков по максимуму", () => {
    expect(downsampleLevels([], 4)).toEqual([0, 0, 0, 0]);
    expect(downsampleLevels([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
    expect(downsampleLevels([0.5], 3)).toHaveLength(3);
  });
});
