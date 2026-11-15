import { describe, expect, it } from "vitest";
import { normalizeDictationMime } from "../src/lib/dictationMime.js";

describe("normalizeDictationMime: тип записи диктовки из браузера", () => {
  it("Chrome/Firefox: убирает параметры кодека", () => {
    expect(normalizeDictationMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeDictationMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
  });
  it("Safari/iPhone: audio/mp4 проходит, x-m4a приводится к audio/mp4", () => {
    expect(normalizeDictationMime("audio/mp4")).toBe("audio/mp4");
    expect(normalizeDictationMime("audio/x-m4a")).toBe("audio/mp4");
  });
  it("звук в видеоконтейнере принимается как звук", () => {
    expect(normalizeDictationMime("video/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeDictationMime("video/mp4")).toBe("audio/mp4");
  });
  it("не звук — отказ", () => {
    expect(normalizeDictationMime("image/png")).toBeNull();
    expect(normalizeDictationMime("")).toBeNull();
    expect(normalizeDictationMime(undefined)).toBeNull();
  });
});
