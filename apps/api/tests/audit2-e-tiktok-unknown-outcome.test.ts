import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * АУДИТ CODEX 04.10.2026, PUB02: неизвестный исход TikTok терял сохранённый publish_id.
 *
 * Ролик уже загружен, TikTok опубликует его сам. Если опрос статуса не дал
 * определённого ответа (40 попыток «в обработке», сеть, 5xx) либо упал исключением
 * ПОСЛЕ onUploadAccepted, обёртка публикации стирала метку TIKTOK_PENDING, и
 * следующая попытка загружала ролик заново, а первый мог позже стать публичным:
 * второй живой пост в TikTok, который нельзя удалить. Метка теперь остаётся
 * (срок годности час уже есть), и следующая попытка продолжает опрос.
 *
 * TikTok подменён целиком, реальный API не вызывается.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY ?? "7e58774a6ca3f8f094b302efc65290b09ba8d51dacebdb60e8e693452f1ab810";

const { prisma } = await import("../src/db.js");
const { publishApprovedPost } = await import("../src/lib/socialPublish.js");
const { encryptSecret } = await import("../src/crypto.js");
const { uploadsDir } = await import("../src/upload.js");

const runId = Date.now();
const VIDEO_PUBLIC_PATH = `/uploads/handoff/tiktok-unknown-${runId}.mp4`;
const videoDiskPath = path.join(uploadsDir, VIDEO_PUBLIC_PATH.slice("/uploads/".length));

let districtId: string;
let propertyId: string;
let savedSettings: Record<string, unknown>;
const realSetTimeout = globalThis.setTimeout;

async function marker(): Promise<string | undefined> {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { publishedPostIds: true } });
  return ((p.publishedPostIds ?? {}) as Record<string, string>).TIKTOK_PENDING;
}

type StatusBehavior = "no-status" | "network-error" | "complete";

function tiktokFetchMock(statusBehavior: StatusBehavior) {
  return vi.fn(async (url: string) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.includes("/oauth/token/")) return json({ access_token: "acc-1", refresh_token: "rtoken-1" });
    if (url.includes("/creator_info/query/")) {
      return json({
        data: {
          creator_username: "royal.home.tjk",
          privacy_level_options: ["SELF_ONLY"],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: 60,
        },
      });
    }
    if (url.includes("/video/init/")) return json({ data: { publish_id: "pub-unknown-1", upload_url: "https://upload.tiktok.example/direct" } });
    if (url.startsWith("https://upload.tiktok.example/")) return json({});
    if (url.includes("/status/fetch/")) {
      if (statusBehavior === "network-error") throw new Error("fetch failed: socket hang up");
      if (statusBehavior === "no-status") return json({ data: { status: "PROCESSING_UPLOAD" } });
      return json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["tt-post-9"] } });
    }
    throw new Error(`неожиданный URL в тесте: ${url}`);
  });
}

const publish = () => publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: "Подпись" });
const tiktokResult = async () => (await publish()).find((r) => r.channel === "TIKTOK");

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-tiktok-unknown-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: { title: `Объект TikTok unknown ${runId}`, type: "APARTMENT", areaSqm: 50, price: 40000, currency: "TJS", districtId, address: "Тестовая, 1", condition: "GOOD" },
    })
  ).id;
  await fs.mkdir(path.dirname(videoDiskPath), { recursive: true });
  await fs.writeFile(videoDiskPath, "fake mp4 bytes");

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaIgToken: current.metaIgToken,
    metaPageToken: current.metaPageToken,
    metaPageId: current.metaPageId,
    telegramChannelId: current.telegramChannelId,
    youtubeRefreshToken: current.youtubeRefreshToken,
    tiktokRefreshToken: current.tiktokRefreshToken,
    tiktokClientKey: current.tiktokClientKey,
    tiktokClientSecret: current.tiktokClientSecret,
    tiktokPrivacyLevel: current.tiktokPrivacyLevel,
  };
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaIgToken: null,
      metaPageToken: null,
      metaPageId: null,
      telegramChannelId: null,
      youtubeRefreshToken: null,
      tiktokClientKey: "ckey",
      tiktokClientSecret: encryptSecret("csecret"),
      tiktokRefreshToken: encryptSecret("rtoken-1"),
      tiktokPrivacyLevel: "SELF_ONLY",
    },
  });
});

beforeEach(async () => {
  await prisma.property.update({ where: { id: propertyId }, data: { publishedChannels: [], publishedPostIds: {}, status: "EDITING" } });
  logSystemError.mockClear();
  // Пауза опроса статуса 3 с (40 попыток) в тесте не нужна: обнуляем только её.
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn, ms === 3000 ? 0 : ms, ...args)) as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(videoDiskPath, { force: true });
  await prisma.$disconnect();
});

describe("TikTok: неизвестный исход не стирает publish_id", () => {
  it("продолжение: опрос ничего не сказал — ok:false, метка остаётся, следующая попытка опрашивает, а не грузит заново", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { TIKTOK_PENDING: "pub-unknown-1", TIKTOK_PENDING_AT: new Date().toISOString() } },
    });
    vi.stubGlobal("fetch", tiktokFetchMock("no-status"));

    const first = await tiktokResult();
    expect(first?.ok).toBe(false);
    expect(first?.outcomeUnknown).toBe(true);
    expect(await marker()).toBe("pub-unknown-1");

    // TikTok наконец ответил — вторая попытка продолжает опрос и получает пост.
    const fetchMock = tiktokFetchMock("complete");
    vi.stubGlobal("fetch", fetchMock);
    const second = await tiktokResult();
    expect(second?.ok).toBe(true);
    expect(second?.postId).toBe("tt-post-9");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/video/init/"))).toBe(false);
    expect(urls.some((u) => u.startsWith("https://upload.tiktok.example/"))).toBe(false);
    expect(await marker()).toBeUndefined();
  });

  it("свежая загрузка: исключение опроса ПОСЛЕ принятия файла — метка остаётся", async () => {
    vi.stubGlobal("fetch", tiktokFetchMock("network-error"));

    const result = await tiktokResult();

    expect(result?.ok).toBe(false);
    expect(result?.outcomeUnknown).toBe(true);
    expect(await marker()).toBe("pub-unknown-1");

    // Следующая попытка — опрос по сохранённому id, без второго init и загрузки.
    const fetchMock = tiktokFetchMock("complete");
    vi.stubGlobal("fetch", fetchMock);
    const second = await tiktokResult();
    expect(second?.ok).toBe(true);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/video/init/"))).toBe(false);
    expect(await marker()).toBeUndefined();
  });

  it("определённый отказ TikTok (FAILED) метку стирает, как и раньше", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { TIKTOK_PENDING: "pub-unknown-1", TIKTOK_PENDING_AT: new Date().toISOString() } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
        if (url.includes("/oauth/token/")) return json({ access_token: "acc-1", refresh_token: "rtoken-1" });
        if (url.includes("/status/fetch/")) return json({ data: { status: "FAILED", fail_reason: "file_format_check_failed" } });
        throw new Error(`неожиданный URL в тесте: ${url}`);
      })
    );

    const result = await tiktokResult();

    expect(result?.ok).toBe(false);
    expect(result?.outcomeUnknown).toBeUndefined();
    expect(await marker()).toBeUndefined();
  });

  it("сбой ДО загрузки (init отказал) — метки нет и неизвестного исхода нет", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;
        if (url.includes("/oauth/token/")) return json({ access_token: "acc-1", refresh_token: "rtoken-1" });
        if (url.includes("/creator_info/query/")) {
          return json({ data: { creator_username: "x", privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 60 } });
        }
        if (url.includes("/video/init/")) return json({ error: { code: "invalid_param", message: "bad" } }, false, 400);
        throw new Error(`неожиданный URL в тесте: ${url}`);
      })
    );

    const result = await tiktokResult();

    expect(result?.ok).toBe(false);
    expect(result?.outcomeUnknown).toBeUndefined();
    expect(await marker()).toBeUndefined();
  });
});
