import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * TikTok Content Posting API (17.09.2026) — lib/socialPublish.ts::publishTikTokVideo.
 * По образцу social-publish-youtube.test.ts: подменяем global.fetch, настоящий
 * API не дёргается. db.js замокан — ротация refresh_token (единственное место,
 * которое реально пишет в БД) проверяется через вызов мока, без живой БД.
 */

// SETTINGS_ENCRYPTION_KEY здесь тестовый и локальный этому файлу: точечный
// прогон без БД (см. docstring выше) не гарантирует, что .env агента задаёт
// его (найдено 17.09.2026 — encryptSecret() бросал в этом самом тесте без
// него), а тест ротации обязан реально зашифровать/расшифровать значение,
// не заглушкой.
// tests/setup.ts восстанавливает process.env после каждого файла (свой afterAll) —
// перезаписать здесь безопасно, соседних файлов правка не переживёт.
process.env.SETTINGS_ENCRYPTION_KEY = "7e58774a6ca3f8f094b302efc65290b09ba8d51dacebdb60e8e693452f1ab810"; // gitleaks:allow -- reviewed synthetic test value or non-secret identifier

const settingsUpdate = vi.fn().mockResolvedValue({});
vi.mock("../src/db.js", () => ({
  prisma: { settings: { update: (...args: unknown[]) => settingsUpdate(...args) } as unknown, $disconnect: async () => {} },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));

const { publishTikTokVideo, tiktokChunkPlan } = await import("../src/lib/socialPublish.js");
const { decryptSecret } = await import("../src/crypto.js");

let videoPath: string;

beforeEach(async () => {
  videoPath = path.join(os.tmpdir(), `tt-smoke-${Date.now()}.mp4`);
  await fs.writeFile(videoPath, "fake mp4 bytes"); // 14 байт — один чанк
});

afterEach(async () => {
  await fs.rm(videoPath, { force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  settingsUpdate.mockClear();
});

const BASE_PREFS = { privacyLevel: "SELF_ONLY", allowComments: false, allowDuet: false, allowStitch: false, brandMode: "NONE" as const };
const BASE_CREDS = { clientKey: "ckey", clientSecret: "csecret", refreshToken: "rtoken-1" };

describe("tiktokChunkPlan — расчёт чанков (чистая функция, без сети/файлов)", () => {
  const MB = 1024 * 1024;

  it("3 МБ — один чанк", () => {
    expect(tiktokChunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, totalChunkCount: 1 });
  });

  it("59 МБ — один чанк (меньше 64 МБ при любом прочтении «МБ»)", () => {
    expect(tiktokChunkPlan(59_000_000)).toEqual({ chunkSize: 59_000_000, totalChunkCount: 1 });
  });

  /** Поломка 23.09.2026: 64–128 МБ уходили ОДНИМ чанком > 64 МБ, TikTok отвечал
   *  «The chunk size is invalid». Ролик больше 64 МБ обязан идти несколькими. */
  it("100 МБ — несколько чанков, ни один не больше 64 МБ", () => {
    const size = 100 * MB;
    const plan = tiktokChunkPlan(size);
    expect(plan.totalChunkCount).toBeGreaterThan(1);
    const last = size - (plan.totalChunkCount - 1) * plan.chunkSize;
    expect(plan.chunkSize).toBeLessThanOrEqual(64_000_000);
    expect(last).toBeLessThanOrEqual(64_000_000);
  });

  it("любой размер: правила TikTok соблюдены (5–64 МБ, последний ≤128 МБ, ≤1000 чанков)", () => {
    for (const size of [60_000_001, 64 * MB, 65 * MB, 127 * MB, 150 * MB, 1024 * MB, 4096 * MB]) {
      const { chunkSize, totalChunkCount } = tiktokChunkPlan(size);
      expect(totalChunkCount).toBe(Math.floor(size / chunkSize));
      expect(totalChunkCount).toBeGreaterThanOrEqual(2);
      expect(totalChunkCount).toBeLessThanOrEqual(1000);
      expect(chunkSize).toBeGreaterThanOrEqual(5 * MB);
      expect(chunkSize).toBeLessThanOrEqual(64_000_000);
      expect(size - (totalChunkCount - 1) * chunkSize).toBeLessThanOrEqual(128_000_000);
    }
  });
});

describe("publishTikTokVideo", () => {
  it("не настроен — честная ошибка, ни один запрос не уходит", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo({}, BASE_PREFS, videoPath, "Подпись");
    expect(result).toMatchObject({ channel: "TIKTOK", ok: false });
    expect(result.error).toContain("не настроен");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("не выбран уровень приватности — понятная ошибка, ни один запрос не уходит", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, { ...BASE_PREFS, privacyLevel: null }, videoPath, "Подпись");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Не выбран уровень приватности");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Общий мок сети для сценариев «после creator_info»: обмен токена и
   *  creator_info одинаковы во всех тестах ниже, различается только init/status. */
  function baseFetchMock(overrides: {
    privacyLevelOptions?: string[];
    initResponse?: () => Response;
    statusSequence?: (() => Response)[];
    refreshTokenOut?: string;
  }) {
    const calls: string[] = [];
    let statusCallIndex = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes("/oauth/token/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "acc-1", refresh_token: overrides.refreshTokenOut ?? BASE_CREDS.refreshToken }),
        } as unknown as Response;
      }
      if (url.includes("/creator_info/query/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              creator_username: "royal.home.tjk",
              creator_nickname: "Royal Home",
              privacy_level_options: overrides.privacyLevelOptions ?? ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
              comment_disabled: false,
              duet_disabled: false,
              stitch_disabled: false,
              max_video_post_duration_sec: 60,
            },
          }),
        } as unknown as Response;
      }
      if (url.includes("/video/init/")) {
        return overrides.initResponse
          ? overrides.initResponse()
          : ({
              ok: true,
              status: 200,
              json: async () => ({ data: { publish_id: "pub-1", upload_url: "https://upload.tiktok.example/session-1" } }),
            } as unknown as Response);
      }
      if (url === "https://upload.tiktok.example/session-1") {
        expect(init?.method).toBe("PUT");
        expect(init?.headers).toMatchObject({ "Content-Range": expect.stringMatching(/^bytes 0-13\/14$/) });
        // Часть — ленивый Blob с диска, а не срез буфера всего ролика (аудит 23.09.2026, №80).
        expect(init?.body).toBeInstanceOf(Blob);
        expect(Buffer.isBuffer(init?.body)).toBe(false);
        expect((init?.body as Blob).size).toBe(14);
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes("/status/fetch/")) {
        const seq = overrides.statusSequence;
        const resFn = seq?.[Math.min(statusCallIndex, seq.length - 1)];
        statusCallIndex++;
        if (resFn) return resFn();
        return { ok: true, status: 200, json: async () => ({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["v-1"] } }) } as unknown as Response;
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
  }

  it("успех — обмен токена, init, PUT с верным Content-Range, опрос до PUBLISH_COMPLETE, permalink", async () => {
    const fetchMock = baseFetchMock({});
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "2-комн. за $45 000 · Сино");
    expect(result).toMatchObject({
      channel: "TIKTOK",
      ok: true,
      postId: "v-1",
      permalink: "https://www.tiktok.com/@royal.home.tjk/video/v-1",
    });
  });

  it("уровень приватности вне privacy_level_options — отказ до init", async () => {
    const fetchMock = baseFetchMock({ privacyLevelOptions: ["PUBLIC_TO_EVERYONE"] });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, { ...BASE_PREFS, privacyLevel: "SELF_ONLY" }, videoPath, "Подпись");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("не разрешает уровень");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/video/init/"))).toBe(false);
  });

  it("unaudited_client_can_only_post_to_private_accounts — переведён на русский", async () => {
    const fetchMock = baseFetchMock({
      initResponse: () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "not audited" } }),
        }) as unknown as Response,
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("не прошло ревью");
    expect(result.error).not.toContain("unaudited_client_can_only_post_to_private_accounts_RAW");
  });

  it("статус FAILED — ok:false с понятным текстом", async () => {
    const fetchMock = baseFetchMock({
      statusSequence: [() => ({ ok: true, status: 200, json: async () => ({ data: { status: "FAILED", fail_reason: "video_too_short" } }) }) as unknown as Response],
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("video_too_short");
  });

  it("PUBLISH_COMPLETE без publicaly_available_post_id — ok:true без ссылки (не отказ)", async () => {
    const fetchMock = baseFetchMock({
      statusSequence: [() => ({ ok: true, status: 200, json: async () => ({ data: { status: "PUBLISH_COMPLETE" } }) }) as unknown as Response],
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result.ok).toBe(true);
    expect(result.postId).toBeUndefined();
  });

  it("ротация refresh_token — TikTok вернул новый токен, он сохранён (зашифрованным) в Settings", async () => {
    const fetchMock = baseFetchMock({ refreshTokenOut: "rtoken-ROTATED" });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result.ok).toBe(true);
    expect(settingsUpdate).toHaveBeenCalledTimes(1);
    const [arg] = settingsUpdate.mock.calls[0] as [{ where: { id: string }; data: { tiktokRefreshToken: string } }];
    expect(arg.where).toEqual({ id: "singleton" });
    expect(decryptSecret(arg.data.tiktokRefreshToken)).toBe("rtoken-ROTATED");
  });

  it("refresh_token не изменился — Settings не трогаем лишний раз", async () => {
    const fetchMock = baseFetchMock({ refreshTokenOut: BASE_CREDS.refreshToken });
    vi.stubGlobal("fetch", fetchMock);
    await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(settingsUpdate).not.toHaveBeenCalled();
  });
});

describe("publishTikTokVideo — запасной путь через черновики (fail_reason internal)", () => {
  /** Прямая публикация (video/init/, publish_id pub-1) доходит до FAILED с
   *  заданным fail_reason; если это internal, следом идёт inbox/video/init/
   *  (publish_id pub-2) с собственными PUT и опросом статуса. Различаем запросы
   *  по publish_id в теле — тот же приём, что различает direct/inbox init по URL. */
  function fallbackFetchMock(opts: { directFailReason: string; inboxStatus?: "SEND_TO_USER_INBOX" | "FAILED" }) {
    const directStatusCalls = { count: 0 };
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token/")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "acc-1", refresh_token: BASE_CREDS.refreshToken }) } as unknown as Response;
      }
      if (url.includes("/creator_info/query/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              creator_username: "royal.home.tjk",
              privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
              comment_disabled: false,
              duet_disabled: false,
              stitch_disabled: false,
              max_video_post_duration_sec: 60,
            },
          }),
        } as unknown as Response;
      }
      // Прямая публикация — с post_info в теле.
      if (url.includes("/video/init/") && !url.includes("/inbox/")) {
        return { ok: true, status: 200, json: async () => ({ data: { publish_id: "pub-1", upload_url: "https://upload.tiktok.example/direct" } }) } as unknown as Response;
      }
      // Черновики — без post_info, отдельный URL.
      if (url.includes("/inbox/video/init/")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.post_info).toBeUndefined();
        expect(body.source_info?.source).toBe("FILE_UPLOAD");
        return { ok: true, status: 200, json: async () => ({ data: { publish_id: "pub-2", upload_url: "https://upload.tiktok.example/inbox" } }) } as unknown as Response;
      }
      if (url === "https://upload.tiktok.example/direct" || url === "https://upload.tiktok.example/inbox") {
        expect(init?.method).toBe("PUT");
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes("/status/fetch/")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.publish_id === "pub-1") {
          directStatusCalls.count++;
          return { ok: true, status: 200, json: async () => ({ data: { status: "FAILED", fail_reason: opts.directFailReason } }) } as unknown as Response;
        }
        if (body.publish_id === "pub-2") {
          const status = opts.inboxStatus ?? "SEND_TO_USER_INBOX";
          return {
            ok: true,
            status: 200,
            json: async () =>
              status === "FAILED" ? { data: { status: "FAILED", fail_reason: "video_too_short" } } : { data: { status } },
          } as unknown as Response;
        }
        throw new Error(`неизвестный publish_id в тесте: ${body.publish_id}`);
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
  }

  it("FAILED/internal на прямой публикации → инбокс проходит → ok:true с note, без postId/permalink", async () => {
    const fetchMock = fallbackFetchMock({ directFailReason: "internal" });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result).toMatchObject({ channel: "TIKTOK", ok: true });
    expect(result.note).toContain("черновики TikTok");
    expect(result.postId).toBeUndefined();
    expect(result.permalink).toBeUndefined();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/inbox/video/init/"))).toBe(true);
  });

  it("FAILED/internal, но инбокс тоже отклоняет — ok:false с текстом инбокса", async () => {
    const fetchMock = fallbackFetchMock({ directFailReason: "internal", inboxStatus: "FAILED" });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("черновики");
    expect(result.error).toContain("video_too_short");
  });

  it("FAILED по другой причине — БЕЗ повтора через инбокс, обычный отказ", async () => {
    const fetchMock = fallbackFetchMock({ directFailReason: "video_too_short" });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("video_too_short");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/inbox/"))).toBe(false);
  });
});

describe("publishTikTokVideo — unaudited_client на init → черновики", () => {
  /** До аудита с ОТКРЫТЫМ аккаунтом TikTok отказывает уже на video/init/
   *  (17.09.2026, прод). Черновики от приватности не зависят — ролик уходит
   *  туда, а не теряется с ошибкой. */
  it("init отвечает unaudited_client_can_only_post_to_private_accounts → inbox → ok:true с note", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token/")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "acc-1", refresh_token: BASE_CREDS.refreshToken }) } as unknown as Response;
      }
      if (url.includes("/creator_info/query/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { creator_username: "royal.home.tjk", privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 60 },
          }),
        } as unknown as Response;
      }
      if (url.includes("/video/init/") && !url.includes("/inbox/")) {
        return { ok: false, status: 403, json: async () => ({ error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "not audited" } }) } as unknown as Response;
      }
      if (url.includes("/inbox/video/init/")) {
        return { ok: true, status: 200, json: async () => ({ data: { publish_id: "pub-2", upload_url: "https://upload.tiktok.example/inbox" } }) } as unknown as Response;
      }
      if (url === "https://upload.tiktok.example/inbox") {
        expect(init?.method).toBe("PUT");
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes("/status/fetch/")) {
        return { ok: true, status: 200, json: async () => ({ data: { status: "SEND_TO_USER_INBOX" } }) } as unknown as Response;
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись");
    expect(result).toMatchObject({ channel: "TIKTOK", ok: true });
    expect(result.note).toContain("черновики TikTok");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/inbox/video/init/"))).toBe(true);
  });
});

/**
 * ПРОДОЛЖЕНИЕ ПОСЛЕ ОБРЫВА (22.09.2026, класс «страховка ставится ПОСЛЕ окна,
 * которое должна страховать»). Загрузка ролика кусками плюс опрос статуса до
 * двух минут — окно, внутри которого автовыкат перезапускает контейнер. Точка
 * невозврата — конец загрузки: TikTok опубликует ролик сам, чем бы ни кончился
 * наш опрос. Не запомнив `publish_id` в этой точке, повтор задания грузил тот
 * же ролик заново и вешал ВТОРОЙ живой пост.
 */
describe("publishTikTokVideo — обрыв внутри опроса не приводит ко второй загрузке", () => {
  function fetchMockFor(statusByPublishId: Record<string, unknown>) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token/")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "acc-1", refresh_token: BASE_CREDS.refreshToken }) } as unknown as Response;
      }
      if (url.includes("/creator_info/query/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              creator_username: "royal.home.tjk",
              privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
              comment_disabled: false,
              duet_disabled: false,
              stitch_disabled: false,
              max_video_post_duration_sec: 60,
            },
          }),
        } as unknown as Response;
      }
      if (url.includes("/video/init/")) {
        return { ok: true, status: 200, json: async () => ({ data: { publish_id: "pub-1", upload_url: "https://upload.tiktok.example/direct" } }) } as unknown as Response;
      }
      if (url === "https://upload.tiktok.example/direct") {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes("/status/fetch/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { publish_id: string };
        const data = statusByPublishId[body.publish_id];
        if (!data) throw new Error(`неизвестный publish_id в тесте: ${body.publish_id}`);
        return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
  }

  it("publish_id отдаётся ДО опроса статуса — иначе обрыв стёр бы память о загрузке", async () => {
    const seen: { publishId: string | null; statusCallsBefore: number } = { publishId: null, statusCallsBefore: -1 };
    let statusCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/status/fetch/")) statusCalls++;
      return fetchMockFor({ "pub-1": { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["post-1"] } })(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись", {
      onUploadAccepted: async (publishId) => {
        seen.publishId = publishId;
        seen.statusCallsBefore = statusCalls;
      },
    });

    expect(result.ok).toBe(true);
    expect(seen.publishId).toBe("pub-1");
    expect(seen.statusCallsBefore).toBe(0);
  });

  it("продолжение по сохранённому publish_id — ни init, ни загрузки, только опрос", async () => {
    const fetchMock = fetchMockFor({ "pub-1": { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["post-1"] } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись", { resumePublishId: "pub-1" });

    expect(result).toMatchObject({ channel: "TIKTOK", ok: true, postId: "post-1" });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/video/init/"))).toBe(false);
    expect(urls.some((u) => u.includes("upload.tiktok.example"))).toBe(false);
    expect(urls.filter((u) => u.includes("/status/fetch/"))).toHaveLength(1);
  });

  it("продолжение застало отказ TikTok — честная ошибка, а не молчаливый успех", async () => {
    vi.stubGlobal("fetch", fetchMockFor({ "pub-1": { status: "FAILED", fail_reason: "video_too_short" } }));

    const result = await publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись", { resumePublishId: "pub-1" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("video_too_short");
  });
  it("продолжение застало молчание TikTok — честный отказ, а не тихий успех", async () => {
    // На обычном пути «опрос истёк» — успех: ролик мы только что загрузили сами
    // и знаем, что он у TikTok. В продолжении мы знаем лишь чужой publish_id, и
    // молчание с тем же успехом означает, что он протух: счесть это успехом
    // значило бы отметить канал опубликованным без поста.
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", fetchMockFor({ "pub-1": { status: "PROCESSING_UPLOAD" } }));

      const promise = publishTikTokVideo(BASE_CREDS, BASE_PREFS, videoPath, "Подпись", { resumePublishId: "pub-1" });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const result = await promise;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("заново");
    } finally {
      vi.useRealTimers();
    }
  });
});
