import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * FACEBOOK: ОБРЫВ ОТВЕТА НЕ ДОЛЖЕН ДАВАТЬ ВТОРОЙ ПОСТ НА СТРАНИЦЕ
 * (22.09.2026, класс «страховка ставится ПОСЛЕ окна, которое должна
 * страховать»).
 *
 * `POST /{page-id}/videos` не идемпотентен, поэтому у него намеренно нет
 * повтора. Но повтор есть выше: задание публикации живёт до шести попыток, а
 * сторож догоняет оборвавшиеся публикации сам. Таймаут или рестарт контейнера
 * (автовыкат идёт по каждому мержу в main) не означают «не дошло» — Meta могла
 * принять запрос и доварить его уже без нас. Канал не попадал в
 * publishedChannels, и следующая попытка вешала на публичную страницу
 * агентства второе такое же видео.
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
const { uploadsDir } = await import("../src/upload.js");

const runId = Date.now();
const CAPTION = `Подпись объекта ${runId}`;
const VIDEO_PUBLIC_PATH = `/uploads/handoff/fb-pending-${runId}.mp4`;
const videoDiskPath = path.join(uploadsDir, VIDEO_PUBLIC_PATH.slice("/uploads/".length));

let districtId: string;
let propertyId: string;
let savedSettings: Record<string, unknown>;

async function postIds(): Promise<Record<string, string>> {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { publishedPostIds: true } });
  return (p.publishedPostIds ?? {}) as Record<string, string>;
}

/** Ответы Meta: список видео страницы задаётся тестом, публикация — по флагу. */
function metaFetchMock(opts: { recent?: Array<{ id: string; description: string; created_time: string }>; onPublish?: () => void | Promise<void> }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const address = String(url);
    if (address.includes("/videos?fields=id,description,created_time")) return json({ data: opts.recent ?? [] });
    if (address.endsWith("/videos") && init?.method === "POST") {
      await opts.onPublish?.();
      return json({ id: "fb-new-1" });
    }
    if (address.includes("fields=post_id")) return json({ post_id: `page_${address.split("/").pop()?.split("?")[0]}` });
    throw new Error(`неожиданный URL в тесте: ${address}`);
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-fb-pending-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект FB pending ${runId}`,
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
  };
  // Настроен ТОЛЬКО Facebook — остальные каналы молча пропускаются.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaIgToken: null,
      metaPageToken: "page-token",
      metaPageId: "111",
      telegramChannelId: null,
      youtubeRefreshToken: null,
      tiktokRefreshToken: null,
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

describe("publishApprovedPost — метка незавершённой публикации в Facebook", () => {
  it("обычная публикация: метка стоит в момент отправки и стёрта после ответа", async () => {
    let markerDuringPost: string | undefined;
    vi.stubGlobal(
      "fetch",
      metaFetchMock({
        onPublish: async () => {
          markerDuringPost = (await postIds()).FACEBOOK_PENDING;
        },
      })
    );

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    expect(results.find((r) => r.channel === "FACEBOOK")?.ok).toBe(true);
    // Вот ради этой строки всё и сделано: оборвись процесс здесь, метка
    // осталась бы в карточке и следующая попытка сперва спросила бы страницу.
    expect(markerDuringPost).toBeTruthy();
    const ids = await postIds();
    expect(ids.FACEBOOK_PENDING).toBeUndefined();
    expect(ids.FACEBOOK_PENDING_AT).toBeUndefined();
  });

  it("метка от оборвавшейся попытки, а видео на странице уже есть — берём его, второе не постим", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { FACEBOOK_PENDING: new Date().toISOString(), FACEBOOK_PENDING_AT: new Date().toISOString() } },
    });
    let published = false;
    const fetchMock = metaFetchMock({
      recent: [{ id: "fb-already-1", description: CAPTION, created_time: new Date().toISOString() }],
      onPublish: () => {
        published = true;
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    const fb = results.find((r) => r.channel === "FACEBOOK");
    expect(fb?.ok).toBe(true);
    expect(fb?.postId).toBe("fb-already-1");
    // Вот ради этой строки всё и сделано.
    expect(published).toBe(false);
    expect((await postIds()).FACEBOOK_PENDING).toBeUndefined();
  });

  it("метка есть, а на странице чужая подпись — публикуем как обычно", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { FACEBOOK_PENDING: new Date().toISOString(), FACEBOOK_PENDING_AT: new Date().toISOString() } },
    });
    let published = false;
    vi.stubGlobal(
      "fetch",
      metaFetchMock({
        recent: [{ id: "fb-other-1", description: "Подпись соседнего объекта", created_time: new Date().toISOString() }],
        onPublish: () => {
          published = true;
        },
      })
    );

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    expect(results.find((r) => r.channel === "FACEBOOK")?.postId).toBe("fb-new-1");
    expect(published).toBe(true);
  });

  it("метке больше срока годности — страницу не опрашиваем вовсе, публикуем", async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { FACEBOOK_PENDING: old, FACEBOOK_PENDING_AT: old } },
    });
    const fetchMock = metaFetchMock({
      recent: [{ id: "fb-already-1", description: CAPTION, created_time: old }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    expect(results.find((r) => r.channel === "FACEBOOK")?.postId).toBe("fb-new-1");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("fields=id,description,created_time"))).toBe(false);
  });

  it("страница не ответила на вопрос — отказ в журнале, публикация не висит", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { FACEBOOK_PENDING: new Date().toISOString(), FACEBOOK_PENDING_AT: new Date().toISOString() } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const address = String(url);
        if (address.includes("/videos?fields=id,description,created_time")) {
          return { ok: false, status: 500, json: async () => ({ error: { message: "страница недоступна" } }) } as unknown as Response;
        }
        if (address.endsWith("/videos") && init?.method === "POST") {
          return { ok: true, status: 200, json: async () => ({ id: "fb-new-1" }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      })
    );

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    // Отказ проверки не роняет публикацию, но и не остаётся немым.
    expect(results.find((r) => r.channel === "FACEBOOK")?.ok).toBe(true);
    expect(logSystemError.mock.calls.some((c) => String(c[1]).includes("не удалось спросить страницу"))).toBe(true);
  });

  it("видео со старой датой не засчитывается за наше — публикуем заново", async () => {
    await prisma.property.update({
      where: { id: propertyId },
      data: { publishedPostIds: { FACEBOOK_PENDING: new Date().toISOString(), FACEBOOK_PENDING_AT: new Date().toISOString() } },
    });
    vi.stubGlobal(
      "fetch",
      metaFetchMock({
        recent: [{ id: "fb-yesterday", description: CAPTION, created_time: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }],
      })
    );

    const results = await publishApprovedPost({ propertyId, localVideoPath: VIDEO_PUBLIC_PATH, caption: CAPTION });

    expect(results.find((r) => r.channel === "FACEBOOK")?.postId).toBe("fb-new-1");
  });
});
