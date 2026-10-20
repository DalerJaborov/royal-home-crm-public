import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FACEBOOK REELS — добавлено ПОВЕРХ видеопоста (решение владельца 26.09.2026,
 * publishFacebookVideo не тронут). Покрывает две новые вещи в
 * lib/socialPublish.ts: `facebookFormatFor` (чистая функция выбора формата по
 * probeMediaInfo) и `publishFacebookReel` (три шага Reels Publishing API +
 * опрос готовности).
 *
 * БД подменена ЦЕЛИКОМ (не реальный Postgres) — ни facebookFormatFor, ни
 * publishFacebookReel не трогают Prisma, мок нужен только затем, что модуль
 * импортирует ../db.js на верхнем уровне (тот же приём, что
 * social-publish-instagram-pending.test.ts). Таймеры — фейковые:
 * CONTAINER_POLL_INTERVALS_MS суммарно ждёт реальные ~4м42с.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

vi.mock("../src/db.js", () => ({
  prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) },
}));

const { publishFacebookReel, facebookFormatFor } = await import("../src/lib/socialPublish.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

// Суммарно окно ожидания в socialPublish.ts ~282с — с запасом прокручиваем
// фейковые часы на полчаса (тот же приём, что у Instagram-теста).
const FULL_WAIT_WINDOW_MS = 30 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  logSystemError.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("facebookFormatFor — выбор REEL/VIDEO по факту содержимого файла", () => {
  it("вертикаль 1080×1920, 30 с — REEL", () => {
    expect(facebookFormatFor({ width: 1080, height: 1920, durationSec: 30, hasVideo: true, hasAudio: true, videoCodec: "h264", audioCodec: "aac", rotation: 0, sizeBytes: 1 })).toBe(
      "REEL"
    );
  });

  it("горизонталь 3840×2160 (случай, уже бывший на проде) — VIDEO", () => {
    expect(
      facebookFormatFor({ width: 3840, height: 2160, durationSec: 30, hasVideo: true, hasAudio: true, videoCodec: "h264", audioCodec: "aac", rotation: 0, sizeBytes: 1 })
    ).toBe("VIDEO");
  });

  it("вертикаль, но длиннее 90 с (1080×1920, 120 с) — VIDEO", () => {
    expect(
      facebookFormatFor({ width: 1080, height: 1920, durationSec: 120, hasVideo: true, hasAudio: true, videoCodec: "h264", audioCodec: "aac", rotation: 0, sizeBytes: 1 })
    ).toBe("VIDEO");
  });

  it("probeMediaInfo вернул null (ffprobe недоступен/битый файл) — VIDEO, как раньше", () => {
    expect(facebookFormatFor(null)).toBe("VIDEO");
  });
});

describe("publishFacebookReel — три шага + опрос готовности", () => {
  it("start → upload → finish → status ready — ok:true, postId=video_id, onAttemptStarted/onAnswered вызваны по одному разу", async () => {
    const onAttemptStarted = vi.fn(async () => {});
    const onAnswered = vi.fn(async () => {});
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address.includes("/video_reels") && typeof init?.body === "string" && init.body.includes("upload_phase\":\"start\"")) {
        return jsonResponse({ video_id: "reel-1", upload_url: "https://rupload.facebook.com/video-upload/v23.0/reel-1" });
      }
      if (address.startsWith("https://rupload.facebook.com/")) {
        return jsonResponse({ success: true });
      }
      if (address.includes("/video_reels") && typeof init?.body === "string" && init.body.includes("upload_phase\":\"finish\"")) {
        return jsonResponse({ success: true });
      }
      if (address.includes("fields=status")) {
        return jsonResponse({ status: { video_status: "ready" } });
      }
      if (address.includes("fields=post_id")) {
        return jsonResponse({ post_id: "page_post_1" });
      }
      throw new Error(`неожиданный URL в тесте: ${address}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishFacebookReel("page-1", "page-token", "https://crm.example/uploads/handoff/a.mp4", "Подпись", {
      onAttemptStarted,
      onAnswered,
    });
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result).toMatchObject({ channel: "FACEBOOK", ok: true, postId: "reel-1", secondaryPostId: "page_post_1", note: "опубликовано как Reels" });
    expect(onAttemptStarted).toHaveBeenCalledTimes(1);
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it("контейнер не успел обработаться за окно ожидания — ok:true с note «ещё обрабатывает», не отказ", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address.includes("/video_reels") && typeof init?.body === "string" && init.body.includes("\"start\"")) {
        return jsonResponse({ video_id: "reel-pending-1", upload_url: "https://rupload.facebook.com/video-upload/v23.0/reel-pending-1" });
      }
      if (address.startsWith("https://rupload.facebook.com/")) return jsonResponse({});
      if (address.includes("/video_reels") && typeof init?.body === "string" && init.body.includes("\"finish\"")) return jsonResponse({ success: true });
      if (address.includes("fields=status")) return jsonResponse({ status: { video_status: "processing" } });
      if (address.includes("fields=post_id")) return jsonResponse({ post_id: null });
      throw new Error(`неожиданный URL в тесте: ${address}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishFacebookReel("page-1", "page-token", "https://crm.example/uploads/handoff/b.mp4", "Подпись");
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.postId).toBe("reel-pending-1");
    expect(result.note).toBe("Reels принят, Facebook ещё обрабатывает");
  });

  it("отказ на шаге start (upload_phase=start) — ok:false, onAnswered вызван (исход известен сразу)", async () => {
    const onAnswered = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "Invalid OAuth access token" } }, false, 401));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookReel("page-1", "bad-token", "https://crm.example/uploads/handoff/c.mp4", "Подпись", { onAnswered });

    expect(result).toMatchObject({ channel: "FACEBOOK", ok: false, error: "Invalid OAuth access token" });
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // без ретрая — /video_reels не идемпотентен
  });

  it("video_status: error после finish — честный отказ, ok:false", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address.includes("/video_reels") && typeof init?.body === "string" && init.body.includes("\"start\"")) {
        return jsonResponse({ video_id: "reel-err-1", upload_url: "https://rupload.facebook.com/video-upload/v23.0/reel-err-1" });
      }
      if (address.startsWith("https://rupload.facebook.com/")) return jsonResponse({});
      if (address.includes("/video_reels") && typeof init?.body === "string" && init.body.includes("\"finish\"")) return jsonResponse({ success: true });
      if (address.includes("fields=status")) return jsonResponse({ status: { video_status: "error" } });
      throw new Error(`неожиданный URL в тесте: ${address}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishFacebookReel("page-1", "page-token", "https://crm.example/uploads/handoff/d.mp4", "Подпись");
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("video_status: error");
  });
});
