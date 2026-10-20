import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * YouTube Shorts (31.08.2026) — lib/socialPublish.ts::publishYouTubeShort.
 * В отличие от Instagram/Telegram, Google САМ файл по ссылке не качает —
 * сервер шлёт байты сам (resumable upload: init → PUT). Настоящий API здесь
 * не дёргается — подменяем global.fetch тем же приёмом, что и остальные
 * тесты внешних вызовов этого файла.
 */

const { publishYouTubeShort } = await import("../src/lib/socialPublish.js");

let videoPath: string;

beforeEach(async () => {
  videoPath = path.join(os.tmpdir(), `yt-smoke-${Date.now()}.mp4`);
  await fs.writeFile(videoPath, "fake mp4 bytes");
});

afterEach(async () => {
  await fs.rm(videoPath, { force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publishYouTubeShort", () => {
  it("без ключей — честная ошибка, ни один запрос не уходит", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishYouTubeShort({}, videoPath, "Заголовок");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("не настроен");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("успешная загрузка — обмен токена, init, PUT байтов, ссылка на Shorts", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok-1" }) } as unknown as Response;
      }
      if (url.includes("uploadType=resumable")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer tok-1" });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ location: "https://upload.example/session-1" }),
          json: async () => ({}),
        } as unknown as Response;
      }
      if (url === "https://upload.example/session-1") {
        expect(init?.method).toBe("PUT");
        // Ролик — ленивый Blob с диска, не буфер целиком в памяти (аудит 23.09.2026, №80).
        expect(init?.body).toBeInstanceOf(Blob);
        expect((init?.body as Blob).size).toBe(14);
        return { ok: true, status: 200, json: async () => ({ id: "video-123" }) } as unknown as Response;
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishYouTubeShort(
      { clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" },
      videoPath,
      "2-комн. за $45 000 · Сино"
    );

    expect(result).toMatchObject({ channel: "YOUTUBE", ok: true, postId: "video-123", permalink: "https://youtube.com/shorts/video-123" });
    expect(calls).toHaveLength(3);
  });

  it("Google не вернул Location — понятная ошибка, а не молчаливый провал", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok-1" }) } as unknown as Response;
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishYouTubeShort({ clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" }, videoPath, "Заголовок");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Location");
  });
});

/**
 * ОБРЫВ ПОСРЕДИ ЗАГРУЗКИ НЕ ДОЛЖЕН ДАВАТЬ ВТОРОЙ SHORTS (22.09.2026, класс
 * «страховка ставится ПОСЛЕ окна, которое должна страховать»). Байты едут в
 * сессию до пяти минут, а рестарт контейнера идёт по каждому мержу в main.
 * Раньше следующая попытка заводила НОВУЮ сессию и грузила ролик второй раз —
 * первая могла к тому времени дойти, и на канале оказывалось два одинаковых
 * ролика. Адрес сессии — сама ручка повтора: сколько раз в неё ни лей, видео
 * выйдет одно.
 */
describe("publishYouTubeShort — продолжение оборвавшейся загрузки", () => {
  const creds = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" };

  function tokenOnly(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok-1" }) } as unknown as Response;
      }
      return handler(url, init);
    });
  }

  it("адрес сессии запоминается ДО того, как поедут байты", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      tokenOnly(async (url) => {
        if (url.includes("uploadType=resumable")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ location: "https://upload.example/session-1" }),
            json: async () => ({}),
          } as unknown as Response;
        }
        seen.push("PUT");
        return { ok: true, status: 200, json: async () => ({ id: "video-1" }) } as unknown as Response;
      })
    );

    const order: string[] = [];
    const result = await publishYouTubeShort(creds, videoPath, "Заголовок", {
      onUploadStarted: async (uploadUrl) => {
        order.push(`start:${uploadUrl}`);
      },
      onAnswered: async () => {
        order.push("answered");
      },
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual(["start:https://upload.example/session-1", "answered"]);
  });

  it("сессия уже приняла ролик целиком — берём готовое видео, второй раз не грузим", async () => {
    const fetchMock = tokenOnly(async (url, init) => {
      if (url === "https://upload.example/session-1") {
        expect((init?.headers as Record<string, string>)["Content-Range"]).toMatch(/^bytes \*\//);
        return { ok: true, status: 200, json: async () => ({ id: "video-ready" }) } as unknown as Response;
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishYouTubeShort(creds, videoPath, "Заголовок", {
      resumeUploadUrl: "https://upload.example/session-1",
    });

    expect(result).toMatchObject({ ok: true, postId: "video-ready" });
    // Вот ради этой строки всё и сделано: новой сессии не заводили.
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("uploadType=resumable"))).toBe(false);
  });

  it("сессия приняла не всё (308) — доливаем в неё же, а не начинаем новую", async () => {
    let puts = 0;
    const fetchMock = tokenOnly(async (url) => {
      if (url === "https://upload.example/session-1") {
        puts += 1;
        if (puts === 1) return { ok: false, status: 308, json: async () => ({}) } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({ id: "video-resumed" }) } as unknown as Response;
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishYouTubeShort(creds, videoPath, "Заголовок", {
      resumeUploadUrl: "https://upload.example/session-1",
    });

    expect(result).toMatchObject({ ok: true, postId: "video-resumed" });
    expect(puts).toBe(2);
  });

  it("сессия протухла (404) — грузим заново обычным путём", async () => {
    const fetchMock = tokenOnly(async (url) => {
      if (url === "https://upload.example/session-dead") {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes("uploadType=resumable")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ location: "https://upload.example/session-2" }),
          json: async () => ({}),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: "video-fresh" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishYouTubeShort(creds, videoPath, "Заголовок", {
      resumeUploadUrl: "https://upload.example/session-dead",
    });

    expect(result).toMatchObject({ ok: true, postId: "video-fresh" });
  });

  it("сессия жива, но доливка отказала — честный отказ, а не молчаливый успех", async () => {
    let puts = 0;
    vi.stubGlobal(
      "fetch",
      tokenOnly(async (url) => {
        if (url === "https://upload.example/session-1") {
          puts += 1;
          if (puts === 1) return { ok: false, status: 308, json: async () => ({}) } as unknown as Response;
          return { ok: false, status: 400, json: async () => ({ error: { message: "плохой файл" } }) } as unknown as Response;
        }
        throw new Error(`неожиданный URL в тесте: ${url}`);
      })
    );

    const result = await publishYouTubeShort(creds, videoPath, "Заголовок", {
      resumeUploadUrl: "https://upload.example/session-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("плохой файл");
  });
});
