import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Аудит 23.09.2026, круг 3, №74: готовый ролик от монтажёра (до 2 ГБ) маршрут
 * читал целиком в память (`fs.readFile(file.path)`), а процесс API живёт в
 * 768 МБ — одна загрузка большого ролика роняла всю CRM. Файл уже на диске
 * (multer diskStorage), его надо переносить (`receiveEditedVideoFromFile`),
 * а не читать. Поведение маршрута проверяет tests/video-handoff.test.ts; этот
 * тест сторожит сам механизм, чтобы чтение целиком не вернулось при правке.
 */
function routeBody(file: string, marker: string, router = "videosRouter"): string {
  const src = readFileSync(fileURLToPath(new URL(`../src/routes/${file}`, import.meta.url)), "utf8");
  const start = src.indexOf(marker);
  expect(start, `маршрут ${marker} не найден в ${file}`).toBeGreaterThan(-1);
  const next = src.indexOf(`\n${router}.`, start + marker.length);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("загрузка ролика монтажёра не читает файл в память целиком", () => {
  it("POST /:id/video-handoff/upload переносит файл, а не читает его", () => {
    const body = routeBody("properties/videos.ts", '"/:id/video-handoff/upload"');
    expect(body).not.toMatch(/readFile\(/);
    expect(body).toMatch(/receiveEditedVideoFromFile\(/);
  });
});

describe("фото/видео клиенту из переписки не читается в память целиком (№74, остаток)", () => {
  it("POST /:id/reply-media передаёт файл путём, а не буфером", () => {
    const body = routeBody("conversations.ts", '"/:id/reply-media"', "conversationsRouter");
    expect(body).not.toMatch(/readFile\(/);
    expect(body).toMatch(/path: req\.file\.path/);
  });
});
