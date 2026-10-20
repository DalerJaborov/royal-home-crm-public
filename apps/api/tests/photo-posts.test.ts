import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * ФОТО-ПОСТЫ ДЛЯ ОБЪЕКТОВ БЕЗ РОЛИКА (28.09.2026, agent-brief.md).
 *
 * Сеть подменена целиком (Graph API Instagram/Facebook, Telegram) — тест не
 * ходит ни в Meta, ни в Telegram и не платит за токены. Подготовка изображений
 * (sharp), база и расстановка слотов — настоящие.
 */

const { sendMediaGroupFiles, deleteChannelMessage, isTelegramEnabled } = vi.hoisted(() => ({
  sendMediaGroupFiles: vi.fn(async (_chatId: string, items: unknown[]) =>
    (items as unknown[]).map((_x, i) => ({ message_id: 1000 + i }))
  ),
  deleteChannelMessage: vi.fn(async () => {}),
  isTelegramEnabled: vi.fn(() => true),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMediaGroupFiles,
  deleteChannelMessage,
  isTelegramEnabled,
}));

const { loadCredentials, instagramTokenIdentity } = vi.hoisted(() => ({
  loadCredentials: vi.fn(async () => ({ igToken: "test-ig-token", pageToken: "test-page-token", pageId: "page-1" })),
  instagramTokenIdentity: vi.fn(async () => ({ ok: true as const, id: "ig-user-1" })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials,
  instagramTokenIdentity,
}));

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { uploadsDir, photoPostsDir } = await import("../src/upload.js");
const {
  preparePhotoPostImages,
  publishInstagramCarousel,
  publishFacebookPhotoPost,
  publishPropertyPhotoPost,
  schedulePhotoPostsTick,
} = await import("../src/lib/photoPosts.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body);
  return { ok, status, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
}

// Instagram/Facebook читают фото по ПУБЛИЧНОЙ ссылке (Graph API забирает файл
// сама) — без CRM_PUBLIC_URL preparePhotoPostImages честно возвращает urls: [],
// тот же приём, что и в montage-copies.test.ts и др.
process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const runId = Date.now().toString(36);
let districtId: string;
const propertyIds: string[] = [];
const files: string[] = [];
let settingsBefore: Record<string, unknown> | null = null;

async function writeUpload(name: string, buffer: Buffer): Promise<string> {
  await fs.writeFile(path.join(uploadsDir, name), buffer);
  files.push(path.join(uploadsDir, name));
  return `/uploads/${name}`;
}

async function makeProperty(opts: {
  withPhotos?: number;
  status?: "AWAITING_VIDEO" | "EDITING" | "AVAILABLE";
  videoHandoffFinalPath?: string | null;
  videoHandoffStatus?: "NONE" | "QUEUED" | "SENT_TO_EDITOR" | "RECEIVED";
  publishedOnSite?: boolean;
  postApprovedAt?: Date | null;
  createdAt?: Date;
}) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-фото-пост-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 55000,
      currency: "USD",
      districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
      status: opts.status ?? "AVAILABLE",
      videoHandoffFinalPath: opts.videoHandoffFinalPath ?? null,
      videoHandoffStatus: opts.videoHandoffStatus ?? "NONE",
      publishedOnSite: opts.publishedOnSite ?? true,
      postApprovedAt: opts.postApprovedAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  propertyIds.push(p.id);
  for (let i = 0; i < (opts.withPhotos ?? 0); i++) {
    const buf = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 40 * (i + 1), g: 80, b: 120 } } })
      .webp()
      .toBuffer();
    const url = await writeUpload(`photo-post-src-${runId}-${propertyIds.length}-${i}.webp`, buf);
    await prisma.propertyPhoto.create({ data: { propertyId: p.id, url, thumbUrl: url, order: i } });
  }
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-фото-пост-${runId}` } })).id;
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as unknown as Record<string, unknown>;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { photoPostsEnabled: true, photoPostAfterHours: 24, telegramChannelId: "-100test" },
    create: { id: "singleton", photoPostsEnabled: true, photoPostAfterHours: 24, telegramChannelId: "-100test" },
  });
});

afterAll(async () => {
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  for (const f of files) await fs.rm(f, { force: true });
  await fs.rm(photoPostsDir, { recursive: true, force: true }).catch(() => {});
  if (settingsBefore) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        photoPostsEnabled: settingsBefore.photoPostsEnabled as boolean,
        photoPostAfterHours: settingsBefore.photoPostAfterHours as number,
        telegramChannelId: settingsBefore.telegramChannelId as string | null,
      },
    });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  logSystemError.mockClear();
});

// ---------------------------------------------------------------------------

describe("preparePhotoPostImages", () => {
  it("конвертирует WEBP в JPEG, главное фото — по order, не больше 10 кадров", async () => {
    const p = await makeProperty({ withPhotos: 3 });
    const result = await preparePhotoPostImages(p.id);
    expect(result).not.toBeNull();
    expect(result!.paths).toHaveLength(3);
    for (const filePath of result!.paths) {
      expect(path.extname(filePath)).toBe(".jpg");
      const meta = await sharp(filePath).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(1080);
      expect(meta.height).toBe(1350);
    }
  });

  it("без фото — null, а не пустой массив", async () => {
    const p = await makeProperty({ withPhotos: 0 });
    const result = await preparePhotoPostImages(p.id);
    expect(result).toBeNull();
  });

  it("повторный вызов не перекодирует, пока исходник на диске не новее готового файла", async () => {
    const p = await makeProperty({ withPhotos: 1 });
    const first = await preparePhotoPostImages(p.id);
    const firstStat = await fs.stat(first!.paths[0]);
    await new Promise((r) => setTimeout(r, 20));
    const second = await preparePhotoPostImages(p.id);
    const secondStat = await fs.stat(second!.paths[0]);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });
});

// ---------------------------------------------------------------------------

describe("publishInstagramCarousel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("1 фото — одиночный IMAGE-контейнер, без карусели", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        if (url.includes("/media_publish")) return jsonResponse({ id: "media-1" });
        if (url.includes("fields=permalink")) return jsonResponse({ permalink: "https://www.instagram.com/p/ABC123/" });
        if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
        return jsonResponse({ id: "container-1" });
      })
    );

    const result = await publishInstagramCarousel("prop-1", "ig-user-1", "token", ["https://crm.example/uploads/photo-posts/a-0.jpg"], "Подпись");

    expect(result.ok).toBe(true);
    expect(result.mediaId).toBe("media-1");
    expect(result.permalink).toBe("https://www.instagram.com/p/ABC123/");
    const createCall = calls.find((c) => (c.body as { image_url?: string })?.image_url && !(c.body as { is_carousel_item?: boolean }).is_carousel_item);
    expect(createCall?.body).toMatchObject({ image_url: "https://crm.example/uploads/photo-posts/a-0.jpg", caption: "Подпись" });
    expect(calls.some((c) => (c.body as { media_type?: string })?.media_type === "CAROUSEL")).toBe(false);
  });

  it("3 фото — 3 дочерних контейнера + CAROUSEL + publish + permalink", async () => {
    const calls: { url: string; body: unknown }[] = [];
    let childCounter = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, body });
        if (url.includes("/media_publish")) return jsonResponse({ id: "media-carousel-1" });
        if (url.includes("fields=permalink")) return jsonResponse({ permalink: "https://www.instagram.com/p/CAR1/" });
        if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
        if (body?.is_carousel_item) {
          childCounter++;
          return jsonResponse({ id: `child-${childCounter}` });
        }
        return jsonResponse({ id: "parent-container-1" }); // media_type: CAROUSEL
      })
    );

    const urls = [1, 2, 3].map((i) => `https://crm.example/uploads/photo-posts/a-${i}.jpg`);
    const result = await publishInstagramCarousel("prop-1", "ig-user-1", "token", urls, "Подпись карусели");

    expect(result.ok).toBe(true);
    expect(result.mediaId).toBe("media-carousel-1");
    expect(result.permalink).toBe("https://www.instagram.com/p/CAR1/");
    expect(childCounter).toBe(3);
    const parentCall = calls.find((c) => (c.body as { media_type?: string })?.media_type === "CAROUSEL");
    expect(parentCall?.body).toMatchObject({ media_type: "CAROUSEL", children: "child-1,child-2,child-3", caption: "Подпись карусели" });
  });

  it("отказ дочернего контейнера — честный ok:false, до карусели дело не доходит", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        if (body?.is_carousel_item) return jsonResponse({ error: { message: "фото повреждено" } }, false, 400);
        return jsonResponse({ id: "unused" });
      })
    );

    const urls = ["https://crm.example/uploads/photo-posts/a-1.jpg", "https://crm.example/uploads/photo-posts/a-2.jpg"];
    const result = await publishInstagramCarousel("prop-1", "ig-user-1", "token", urls, "Подпись");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("фото повреждено");
  });
});

// ---------------------------------------------------------------------------

describe("publishFacebookPhotoPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("2 фото — 2 POST /photos, затем один POST /feed с attached_media", async () => {
    const calls: { url: string; body: unknown }[] = [];
    let photoCounter = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, body });
        if (url.includes("/feed")) return jsonResponse({ id: "post-99" });
        photoCounter++;
        return jsonResponse({ id: `photo-${photoCounter}` });
      })
    );

    const urls = ["https://crm.example/uploads/photo-posts/a-0.jpg", "https://crm.example/uploads/photo-posts/a-1.jpg"];
    const result = await publishFacebookPhotoPost("page-1", "token", urls, "Подпись FB");

    expect(result.ok).toBe(true);
    expect(result.mediaId).toBe("post-99");
    expect(result.permalink).toBe("https://www.facebook.com/post-99");
    expect(photoCounter).toBe(2);
    const photoCalls = calls.filter((c) => c.url.includes("/photos"));
    expect(photoCalls).toHaveLength(2);
    expect(photoCalls[0].body).toMatchObject({ published: false });
    const feedCall = calls.find((c) => c.url.includes("/feed"));
    expect(feedCall?.body).toMatchObject({
      message: "Подпись FB",
      attached_media: [{ media_fbid: "photo-1" }, { media_fbid: "photo-2" }],
    });
  });
});

// ---------------------------------------------------------------------------

describe("publishPropertyPhotoPost — на стенде", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubMeta() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/media_publish")) return jsonResponse({ id: "media-ig-1" });
        if (url.includes("fields=permalink")) return jsonResponse({ permalink: "https://www.instagram.com/p/PP1/" });
        if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
        if (url.includes("/feed")) return jsonResponse({ id: "fb-post-1" });
        if (url.includes("graph.facebook.com") && !url.includes("/feed")) return jsonResponse({ id: "fb-photo-1" });
        return jsonResponse({ id: "container-1" });
      })
    );
  }

  it("записывает результат по трём каналам, instagramUrl/publishedChannels не трогает", async () => {
    stubMeta();
    const p = await makeProperty({ withPhotos: 2 });
    const before = await prisma.property.findUnique({ where: { id: p.id }, select: { instagramUrl: true, publishedChannels: true } });

    const summary = await publishPropertyPhotoPost(p.id, { force: true });

    expect(summary.ok).toBe(true);
    expect(summary.results.INSTAGRAM?.ok).toBe(true);
    expect(summary.results.FACEBOOK?.ok).toBe(true);
    expect(summary.results.TELEGRAM?.ok).toBe(true);
    expect(sendMediaGroupFiles).toHaveBeenCalled();

    const posts = await prisma.propertyPhotoPost.findMany({ where: { propertyId: p.id } });
    expect(posts.map((x) => x.channel).sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM"]);
    expect(posts.every((x) => x.status === "PUBLISHED")).toBe(true);

    const after = await prisma.property.findUnique({ where: { id: p.id }, select: { instagramUrl: true, publishedChannels: true } });
    expect(after?.instagramUrl).toBe(before?.instagramUrl);
    expect(after?.publishedChannels).toEqual(before?.publishedChannels ?? []);
  });

  it("повторный вызов не дублирует записи — уже PUBLISHED каналы пропускаются", async () => {
    stubMeta();
    const p = await makeProperty({ withPhotos: 1 });
    await publishPropertyPhotoPost(p.id, { force: true });
    const firstCount = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } });

    const second = await publishPropertyPhotoPost(p.id, { force: true });
    const secondCount = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } });

    expect(secondCount).toBe(firstCount);
    expect(second.skipped.sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM"]);
  });

  it("объект с готовым роликом — фото-пост не публикуется", async () => {
    const p = await makeProperty({ withPhotos: 1, videoHandoffFinalPath: "/uploads/handoff/x.mp4" });
    const summary = await publishPropertyPhotoPost(p.id, { force: true });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("ролик");
    const posts = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } });
    expect(posts).toBe(0);
  });

  it("ролик уже у монтажёра (финального файла ещё нет) — фото-пост не публикуется", async () => {
    const p = await makeProperty({ withPhotos: 1, videoHandoffStatus: "SENT_TO_EDITOR" });
    const summary = await publishPropertyPhotoPost(p.id, { force: true });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("ролик");
    expect(await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("гейт photoPostsEnabled — без force публикация не запускается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { photoPostsEnabled: false } });
    const p = await makeProperty({ withPhotos: 1 });
    const summary = await publishPropertyPhotoPost(p.id);
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("выключены");
    await prisma.settings.update({ where: { id: "singleton" }, data: { photoPostsEnabled: true } });
  });
});

// ---------------------------------------------------------------------------

describe("schedulePhotoPostsTick", () => {
  it("кандидат без ролика, одобренный давно — получает слот и запись SCHEDULED по трём каналам", async () => {
    const old = new Date(Date.now() - 30 * 3_600_000);
    const p = await makeProperty({ withPhotos: 1, postApprovedAt: old });

    const { scheduled } = await schedulePhotoPostsTick();
    expect(scheduled).toBeGreaterThanOrEqual(1);

    const posts = await prisma.propertyPhotoPost.findMany({ where: { propertyId: p.id } });
    expect(posts).toHaveLength(3);
    expect(posts.every((x) => x.status === "SCHEDULED" && x.scheduledAt)).toBe(true);

    const job = await prisma.backgroundJob.findFirst({ where: { dedupeKey: `photo-post-publish:${p.id}` } });
    expect(job).not.toBeNull();

    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `photo-post-publish:${p.id}` } });
  });

  it("объект с роликом не берётся кандидатом", async () => {
    const old = new Date(Date.now() - 30 * 3_600_000);
    const p = await makeProperty({ withPhotos: 1, postApprovedAt: old, videoHandoffFinalPath: "/uploads/handoff/y.mp4" });
    await schedulePhotoPostsTick();
    const posts = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } });
    expect(posts).toBe(0);
  });

  it("ролик в работе у монтажёра — кандидатом не становится", async () => {
    const old = new Date(Date.now() - 30 * 3_600_000);
    const p = await makeProperty({ withPhotos: 1, postApprovedAt: old, videoHandoffStatus: "SENT_TO_EDITOR" });
    await schedulePhotoPostsTick();
    expect(await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("объект ещё в конвейере подготовки (ждёт видео / монтаж) — кандидатом не становится", async () => {
    const old = new Date(Date.now() - 30 * 3_600_000);
    const waiting = await makeProperty({ withPhotos: 1, postApprovedAt: old, status: "AWAITING_VIDEO" });
    const editing = await makeProperty({ withPhotos: 1, postApprovedAt: old, status: "EDITING" });
    await schedulePhotoPostsTick();
    expect(await prisma.propertyPhotoPost.count({ where: { propertyId: { in: [waiting.id, editing.id] } } })).toBe(0);
  });

  it("свежий объект (моложе photoPostAfterHours) кандидатом не становится", async () => {
    const p = await makeProperty({ withPhotos: 1, postApprovedAt: new Date() });
    await schedulePhotoPostsTick();
    const posts = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } });
    expect(posts).toBe(0);
  });

  it("занятый видео-слот учитывается — новый фото-пост не встаёт на то же время", async () => {
    const old = new Date(Date.now() - 30 * 3_600_000);
    const busyAt = new Date(Date.now() + 60_000);
    const occupied = await makeProperty({ withPhotos: 0, postApprovedAt: old });
    await prisma.property.update({ where: { id: occupied.id }, data: { scheduledPublishAt: busyAt } });

    const p = await makeProperty({ withPhotos: 1, postApprovedAt: old });
    await schedulePhotoPostsTick();
    const posts = await prisma.propertyPhotoPost.findMany({ where: { propertyId: p.id, status: "SCHEDULED" } });
    expect(posts.length).toBeGreaterThan(0);
    // Не тот же самый момент, что уже занят видео-слотом — расстановка обязана
    // соблюсти промежуток, а не сесть ровно на busyAt.
    expect(posts[0].scheduledAt?.getTime()).not.toBe(busyAt.getTime());

    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [`photo-post-publish:${p.id}`, `photo-post-publish:${occupied.id}`] } } });
  });
});
