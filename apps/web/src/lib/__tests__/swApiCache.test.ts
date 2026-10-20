import { describe, expect, it } from "vitest";
import {
  API_CACHE_NAME,
  OFFLINE_API_PATH_PREFIXES,
  isCacheableApiResponse,
  isOfflineCacheableApiRequest,
} from "../swApiCache";

/**
 * Правило runtime-кэша «api-cache» (17.09.2026). Главное свойство — список
 * РАЗРЕШЁННОГО: конфигурация и всё персональное в кэш не попадают, даже если
 * завтра появится новый маршрут. Второе — под разрешёнными разделами кэшируется
 * только JSON, а не архивы, видео и выгрузки.
 */
describe("что service worker кладёт в api-cache", () => {
  it("имя кэша совпадает с тем, которое чистит store/auth.ts при входе", () => {
    expect(API_CACHE_NAME).toBe("api-cache");
  });

  it("разрешённые разделы: списки и карточки целиком, с фильтрами и вложенными путями", () => {
    for (const prefix of OFFLINE_API_PATH_PREFIXES) {
      expect(isOfflineCacheableApiRequest(prefix, "GET")).toBe(true);
      expect(isOfflineCacheableApiRequest(`${prefix}/abc-123`, "GET")).toBe(true);
    }
    expect(isOfflineCacheableApiRequest("/api/v1/clients/abc/interactions", "GET")).toBe(true);
  });

  it("конфигурация и персональное — никогда", () => {
    for (const path of [
      "/api/v1/settings",
      "/api/v1/settings/restore-points",
      "/api/v1/settings/telephony-audio",
      "/api/v1/auth/refresh",
      "/api/v1/me",
      "/api/v1/me/notifications",
      "/api/v1/me/active-call",
      "/api/v1/me/sessions",
    ]) {
      expect(isOfflineCacheableApiRequest(path, "GET"), path).toBe(false);
    }
  });

  it("поток событий и записи разговоров — мимо кэша, как и раньше", () => {
    expect(isOfflineCacheableApiRequest("/api/v1/events", "GET")).toBe(false);
    expect(isOfflineCacheableApiRequest("/api/v1/interactions/x1/recording", "GET")).toBe(false);
  });

  it("префикс совпадает сегментом пути, а не подстрокой", () => {
    expect(isOfflineCacheableApiRequest("/api/v1/clientsXYZ", "GET")).toBe(false);
    expect(isOfflineCacheableApiRequest("/api/v1/dashboard-extra", "GET")).toBe(false);
  });

  it("не-GET не кэшируется никогда", () => {
    expect(isOfflineCacheableApiRequest("/api/v1/clients", "POST")).toBe(false);
    expect(isOfflineCacheableApiRequest("/api/v1/clients", "HEAD")).toBe(false);
  });
});

describe("какой ответ можно положить в api-cache", () => {
  const json = {
    status: 200,
    contentType: "application/json; charset=utf-8",
    cacheControl: null,
    contentDisposition: null,
  };

  it("обычный JSON 200 — да", () => {
    expect(isCacheableApiResponse(json)).toBe(true);
    expect(isCacheableApiResponse({ ...json, cacheControl: "private, max-age=86400" })).toBe(true);
  });

  it("не 200 — нет (ошибка сервера не должна пережить выкат)", () => {
    expect(isCacheableApiResponse({ ...json, status: 502 })).toBe(false);
    expect(isCacheableApiResponse({ ...json, status: 304 })).toBe(false);
  });

  it("сервер запретил хранить (no-store) — нет", () => {
    expect(isCacheableApiResponse({ ...json, cacheControl: "private, no-store, max-age=0" })).toBe(false);
  });

  it("файлы под разрешёнными разделами (zip фото, mp4 видео, выгрузка) — нет", () => {
    expect(isCacheableApiResponse({ ...json, contentType: "application/zip", contentDisposition: 'attachment; filename="photos-12.zip"' })).toBe(false);
    expect(isCacheableApiResponse({ ...json, contentType: "video/mp4" })).toBe(false);
    expect(isCacheableApiResponse({ ...json, contentDisposition: "attachment; filename=export.json" })).toBe(false);
  });
});
