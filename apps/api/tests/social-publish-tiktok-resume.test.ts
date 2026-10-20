import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * TIKTOK: ОБРЫВ ПОСЛЕ ЗАГРУЗКИ НЕ ДОЛЖЕН ПРИВОДИТЬ КО ВТОРОЙ ЗАГРУЗКЕ
 * (22.09.2026, класс «страховка ставится ПОСЛЕ окна, которое должна
 * страховать»). Ролик едет в TikTok кусками, а после загрузки идёт опрос
 * статуса до двух минут. Точка невозврата — конец загрузки: дальше TikTok
 * опубликует ролик сам. Перезапуск внутри опроса (автовыкат идёт по каждому
 * мержу в main) означал, что CRM про эту публикацию не знает ничего, и повтор
 * задания вешал ВТОРОЙ живой пост.
 *
 * Сам протокол и продолжение опроса проверены юнит-тестом
 * (tiktok-publish.test.ts); здесь — та часть, которую без базы не проверить:
 * метка `publish_id` реально лежит в карточке В МОМЕНТ опроса и стирается,
 * когда исход определён.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";
process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY ?? "7e58774a6ca3f8f094b302efc65290b09ba8d51dacebdb60e8e693452f1ab810";

const { prisma } = await import("../src/db.js");
const { publishApprovedPost } = await import("../src/lib/socialPublish.js");
const { encryptSecret } = await import("../src/crypto.js");
const { uploadsDir } = await import("../src/upload.js");

const runId = Date.now();
const VIDEO_PUBLIC_PATH = `/uploads/handoff/tiktok-resume-${runId}.mp4`;
const videoDiskPath = path.join(uploadsDir, VIDEO_PUBLIC_PATH.slice("/uploads/".length));

let districtId: string;
let propertyId: string;
let savedSettings: Record<string, unknown>;

/** Что лежит в карточке под меткой незавершённой загрузки. */
async function pendingMarker(): Promise<string | undefined> {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { publishedPostIds: true } });
  return ((p.publishedPostIds ?? {}) as Record<string, string>).TIKTOK_PENDING;
}

function tiktokFetchMock(opts: { onStatusFetch?: () => Promise<void> } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
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
    if (url.includes("/video/init/")) return json({ data: { publish_id: "pub-resume-1", upload_url: "https://upload.tiktok.example/direct" } });
    if (url.startsWith("https://upload.tiktok.example/")) return json({});
    if (url.includes("/status/fetch/")) {
      await opts.onStatusFetch?.();
      const body = JSON.parse(String(init?.body ?? "{}")) as { publish_id: string };
      expect(body.publish_id).toBe("pub-resume-1");
      return json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["tt-post-1"] } });
    }
    throw new Error(`неожиданный URL в тесте: ${url}`);
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-tiktok-resume-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект TikTok resume ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
      },
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
  // Настроен ТОЛЬКО TikTok — остальные каналы молча пропускаются, и в карточку
  // пишет один канал, тот, что проверяем.
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
  await prisma.property.update({
    where: { id: propertyId },
    data: { publishedChannels: [], publishedPostIds: {}, status: "EDITING" },
  });
  logSystemError.mockClear();
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

describe("publishApprovedPost — метка незавершённой загрузки в TikTok", () => {
  it("во время опроса статуса publish_id уже в карточке, после исхода — стёрт", async () => {
    let markerDuringPoll: string | undefined;
    vi.stubGlobal(
      "fetch",
      tiktokFetchMock({
        onStatusFetch: async () => {
          markerDuringPoll = await pendingMarker();
        },
      })
    );

    const results = await publishApprovedPost({
      propertyId,
      localVideoPath: VIDEO_PUBLIC_PATH,
      caption: "Подпись",
    });

    expect(results.find((r) => r.channel === "TIKTOK")?.ok).toBe(true);
    // Вот ради этой строки всё и сделано: оборвись процесс на опросе, метка
    // осталась бы в карточке и повтор продолжил бы опрос, а не загрузку.
    expect(markerDuringPoll).toBe("pub-resume-1");
    expect(await pendingMarker()).toBeUndefined();
  });

  it("метка от прошлой попытки — ролик не грузится второй раз, идёт только опрос", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { TIKTOK_PENDING: "pub-resume-1", TIKTOK_PENDING_AT: new Date().toISOString() } },
    });
    const fetchMock = tiktokFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const results = await publishApprovedPost({
      propertyId,
      localVideoPath: VIDEO_PUBLIC_PATH,
      caption: "Подпись",
    });

    expect(results.find((r) => r.channel === "TIKTOK")?.ok).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/video/init/"))).toBe(false);
    expect(urls.some((u) => u.startsWith("https://upload.tiktok.example/"))).toBe(false);
    expect(await pendingMarker()).toBeUndefined();
  });
});

/**
 * СТАРАЯ МЕТКА — НЕ ПРОДОЛЖЕНИЕ. `publish_id` живёт у TikTok недолго, а метка,
 * оставшаяся от задания, которое исчерпало попытки, лежала бы в карточке
 * неделями. Без срока годности первая же ручная публикация ушла бы опрашивать
 * протухший идентификатор вместо загрузки — и, не получив внятного ответа,
 * отметила бы канал опубликованным без поста.
 */
describe("publishApprovedPost — метка с истёкшим сроком", () => {
  it("метке больше часа — грузим ролик заново, а не опрашиваем мёртвый идентификатор", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: {
        publishedPostIds: {
          TIKTOK_PENDING: "pub-old-1",
          TIKTOK_PENDING_AT: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        },
      },
    });
    const fetchMock = tiktokFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: "Подпись" });

    expect(results.find((r) => r.channel === "TIKTOK")?.ok).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/video/init/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("https://upload.tiktok.example/"))).toBe(true);
    expect(await pendingMarker()).toBeUndefined();
  });

});
