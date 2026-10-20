import { describe, expect, it } from "vitest";
import { timeoutForPath } from "../api";

/**
 * ПОТОЛОК ОЖИДАНИЯ ВЫБИРАЕТСЯ ПО АДРЕСУ, и ошибка здесь не видна ни сборке, ни
 * глазами: слишком короткий потолок обрывает ЖИВОЙ запрос к модели, сервер при
 * этом досчитывает и списывает деньги, а `queryClient` повторяет обрыв до
 * четырёх раз. Поэтому список долгих роутов закреплён тестом.
 */
describe("timeoutForPath", () => {
  const SLOW = 180_000;

  it.each([
    "/ai/assistant",
    "/ai/parse-note",
    "/ai/generate-listing",
    "/ai/property-draft/abc",
    "/transcribe",
    "/insights/generate",
    "/import/clients",
    "/reports/monthly/generate",
    "/reports/problems/generate",
    "/interactions/abc/translate",
    "/interactions/abc/transcript",
    "/properties/abc/regenerate-caption",
  ])("даёт долгий потолок %s", (path) => {
    expect(timeoutForPath(path)).toBe(SLOW);
  });

  it.each(["/clients", "/properties/1", "/dashboard", "/reports/monthly"])(
    "оставляет обычный потолок %s",
    (path) => {
      expect(timeoutForPath(path)).toBe(30_000);
    }
  );

  it("скачиванию файла даёт свой потолок, а не обычный", () => {
    expect(timeoutForPath("/properties/1/photos/archive.zip", "blob")).toBe(120_000);
  });

  it("не путается в строке запроса", () => {
    expect(timeoutForPath("/ai/cost?conversationId=1")).toBe(SLOW);
    expect(timeoutForPath("/clients?page=2")).toBe(30_000);
  });

  it("запросу с файлом даёт долгий потолок на любом адресе (ролик обрывался на 30-й секунде)", () => {
    expect(timeoutForPath("/properties/abc/video-handoff/upload", "json", true)).toBe(15 * 60_000);
    expect(timeoutForPath("/ai/assistant", "json", true)).toBe(15 * 60_000);
  });
});
