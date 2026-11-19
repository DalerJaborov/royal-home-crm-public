import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * КЛАССИФИКАТОР «META НЕ СМОГЛА СКАЧАТЬ НАШ ФАЙЛ» (18.11.2026, объект №208).
 * Одна функция `isMetaMediaFetchRetriable` решает, повторит ли публикацию
 * jobs/socialPublishRetry.ts через несколько минут. Узко и по первоисточникам
 * Meta: временный отказ скачать — да, токен/права/формат — нет.
 * Без базы: только разбор ответов Graph API.
 */

const { isMetaMediaFetchRetriable, graphErrorInfo, instagramContainerStatusSubcode, waitForInstagramContainerReady, publishThreadsVideo } =
  await import("../src/lib/socialPublish.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isMetaMediaFetchRetriable", () => {
  it("Facebook «Unable to fetch video file from URL» (код 389) — повторить", () => {
    const info = graphErrorInfo({ error: { message: "Unable to fetch video file from URL.", type: "OAuthException", code: 389 } });
    expect(info).toEqual({ code: 389, message: "Unable to fetch video file from URL." });
    expect(isMetaMediaFetchRetriable(info)).toBe(true);
  });

  it("тот же текст без кода (код потерялся по дороге) — тоже повторить", () => {
    expect(isMetaMediaFetchRetriable({ message: "Unable to fetch video file from URL." })).toBe(true);
  });

  it("Facebook 6000 «problem uploading your video file, try again» — повторить", () => {
    expect(isMetaMediaFetchRetriable({ code: 6000 })).toBe(true);
  });

  it.each([2207001, 2207003, 2207032, 2207052, 2207053])("Instagram подкод %i («try again» у Meta) — повторить", (subcode) => {
    expect(isMetaMediaFetchRetriable({ subcode })).toBe(true);
  });

  it("Threads FAILED_DOWNLOADING_VIDEO — повторить", () => {
    expect(isMetaMediaFetchRetriable({ message: "FAILED_DOWNLOADING_VIDEO" })).toBe(true);
  });

  it("недействительный токен (190) — НЕ повторять, даже если текст про скачивание", () => {
    expect(isMetaMediaFetchRetriable({ code: 190, message: "Error validating access token" })).toBe(false);
    expect(isMetaMediaFetchRetriable({ code: 190, message: "Unable to fetch video file from URL." })).toBe(false);
  });

  it("нет прав (10, 200) — НЕ повторять", () => {
    expect(isMetaMediaFetchRetriable({ code: 10, message: "Application does not have permission" })).toBe(false);
    expect(isMetaMediaFetchRetriable({ code: 200, message: "Permissions error" })).toBe(false);
  });

  it("неподходящий формат (2207026), лимит постов (2207042), Threads INVALID_DURATION — НЕ повторять", () => {
    expect(isMetaMediaFetchRetriable({ code: 352, subcode: 2207026, message: "The video format is not supported" })).toBe(false);
    expect(isMetaMediaFetchRetriable({ code: 9, subcode: 2207042 })).toBe(false);
    expect(isMetaMediaFetchRetriable({ message: "INVALID_DURATION" })).toBe(false);
  });

  it("пустой ответ — НЕ повторять (узкое правило, а не «любая ошибка»)", () => {
    expect(isMetaMediaFetchRetriable({})).toBe(false);
    expect(isMetaMediaFetchRetriable(graphErrorInfo({}))).toBe(false);
  });

  it("подкод из статуса контейнера Instagram находится и внутри фразы", () => {
    expect(instagramContainerStatusSubcode("Error: Media upload has failed with error code 2207052")).toBe(2207052);
    expect(instagramContainerStatusSubcode("2207003")).toBe(2207003);
    expect(instagramContainerStatusSubcode("Error")).toBeUndefined();
    expect(instagramContainerStatusSubcode(undefined)).toBeUndefined();
  });
});

describe("Контейнер Instagram в ERROR", () => {
  it("спрашиваем и status (подкод), ERROR «не смогли скачать» — повторить", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ status_code: "ERROR", status: "Error: Media download has failed. (2207052)" }));
    vi.stubGlobal("fetch", fetchMock);

    const ready = await waitForInstagramContainerReady("container-1", "token");

    expect(String(fetchMock.mock.calls[0][0])).toContain("fields=status_code,status");
    expect(ready.ok).toBe(false);
    if (ready.ok) return;
    expect(ready.pending).toBe(false);
    expect(ready.retriable).toBe(true);
    expect(ready.error).toContain("2207052");
  });

  it("ERROR из-за формата ролика — не повторять", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status_code: "ERROR", status: "Error: 2207026" })));

    const ready = await waitForInstagramContainerReady("container-2", "token");

    expect(ready.ok).toBe(false);
    if (ready.ok) return;
    expect(ready.retriable).toBe(false);
  });
});

describe("Threads не скачал ролик", () => {
  it("контейнер ERROR с FAILED_DOWNLOADING_VIDEO — отказ с признаком «повторить позже»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("fields=status")) return jsonResponse({ status: "ERROR", error_message: "FAILED_DOWNLOADING_VIDEO" });
        return jsonResponse({ id: "threads-container-1" });
      })
    );

    const result = await publishThreadsVideo({ userId: "th-user", accessToken: "th-token" }, "https://crm.example/uploads/a.mp4", "Подпись");

    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("контейнер ERROR с INVALID_DURATION — честный отказ без признака", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("fields=status")) return jsonResponse({ status: "ERROR", error_message: "INVALID_DURATION" });
        return jsonResponse({ id: "threads-container-2" });
      })
    );

    const result = await publishThreadsVideo({ userId: "th-user", accessToken: "th-token" }, "https://crm.example/uploads/a.mp4", "Подпись");

    expect(result.ok).toBe(false);
    expect(result.retriable).toBeFalsy();
  });
});
