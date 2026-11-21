import { describe, expect, it } from "vitest";
import { audioClock, audioSpeedLabel, nextAudioSpeed, usableDuration } from "./rhAudio";

describe("плеер: время и длительность", () => {
  it("«0:12», «12:05», «1:02:03»", () => {
    expect(audioClock(12.9)).toBe("0:12");
    expect(audioClock(725)).toBe("12:05");
    expect(audioClock(3723)).toBe("1:02:03");
  });
  it("Infinity, NaN, минус и пусто не показываются как «NaN:NaN»", () => {
    for (const bad of [Infinity, NaN, -5, null, undefined]) expect(audioClock(bad)).toBe("0:00");
    for (const bad of [Infinity, NaN, 0, -1, null, undefined]) expect(usableDuration(bad)).toBeNull();
    expect(usableDuration(27.4)).toBe(27.4);
  });
  it("скорость по кругу 1× → 1,5× → 2× → 1×", () => {
    expect(nextAudioSpeed(1)).toBe(1.5);
    expect(nextAudioSpeed(1.5)).toBe(2);
    expect(nextAudioSpeed(2)).toBe(1);
    expect(audioSpeedLabel(1.5)).toBe("1,5×");
  });
});
