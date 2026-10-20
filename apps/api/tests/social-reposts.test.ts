import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * ПОВТОРНЫЕ ПОКАЗЫ ОБЪЕКТОВ (28.09.2026, agent-brief.md reposts-digests).
 *
 * Сеть подменена целиком (Graph API Instagram/Facebook, Telegram), как в
 * photo-posts.test.ts — этот модуль переиспользует те же функции публикации
 * каналов, поэтому мокается тот же набор.
 */

const { sendMediaGroupFiles, deleteChannelMessage, isTelegramEnabled } = vi.hoisted(() => ({
  sendMediaGroupFiles: vi.fn(async (_chatId: string, items: unknown[]) => (items as unknown[]).map((_x, i) => ({ message_id: 2000 + i }))),
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
const { repostHook, publishPropertyRepost, scheduleRepostsTick, lastSocialShowAt } = await import("../src/lib/socialReposts.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body);
  return { ok, status, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
}

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

async function makeProperty(opts: { withPhotos?: number; status?: string; offSite?: boolean; publishedOnSite?: boolean }) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-повтор-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 55000,
      currency: "USD",
      districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
      status: (opts.status ?? "AVAILABLE") as never,
      offSite: opts.offSite ?? false,
      publishedOnSite: opts.publishedOnSite ?? true,
    },
  });
  propertyIds.push(p.id);
  for (let i = 0; i < (opts.withPhotos ?? 0); i++) {
    const buf = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 20 * (i + 1), g: 60, b: 90 } } })
      .webp()
      .toBuffer();
    const url = await writeUpload(`repost-src-${runId}-${propertyIds.length}-${i}.webp`, buf);
    await prisma.propertyPhoto.create({ data: { propertyId: p.id, url, thumbUrl: url, order: i } });
  }
  return p;
}

/** «Объект уже показывался» — самый дешёвый источник lastSocialShowAt в тесте:
 *  строка PropertyPhotoPost PUBLISHED с нужной датой (см. её докстринг в
 *  lib/socialReposts.ts::lastSocialShowAt — один из трёх источников). */
async function markShown(propertyId: string, publishedAt: Date) {
  await prisma.propertyPhotoPost.create({
    data: { propertyId, channel: "INSTAGRAM", status: "PUBLISHED", publishedAt, mediaId: "old-media" },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-повтор-${runId}` } })).id;
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as unknown as Record<string, unknown>;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { repostsEnabled: true, repostAfterDays: 21, repostMaxRounds: 3, telegramChannelId: "-100test" },
    create: { id: "singleton", repostsEnabled: true, repostAfterDays: 21, repostMaxRounds: 3, telegramChannelId: "-100test" },
  });
});

afterAll(async () => {
  await prisma.propertySocialRepost.deleteMany({ where: { propertyId: { in: propertyIds } } });
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
        repostsEnabled: settingsBefore.repostsEnabled as boolean,
        repostAfterDays: settingsBefore.repostAfterDays as number,
        repostMaxRounds: settingsBefore.repostMaxRounds as number,
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

describe("repostHook", () => {
  it("без снижения цены — по кругу, три разных текста", () => {
    const h1 = repostHook(1, null);
    const h2 = repostHook(2, null);
    const h3 = repostHook(3, null);
    expect(new Set([h1, h2, h3]).size).toBe(3);
    expect(h1).not.toMatch(/Цена снижена/);
  });

  it("круг больше длины списка — оборачивается (round 4 = round 1)", () => {
    expect(repostHook(4, null)).toBe(repostHook(1, null));
  });

  it("со снижением цены — крючок «Цена снижена», старая/новая цена в тексте", () => {
    const hook = repostHook(2, { fromDisplay: "было 60 000 $", toDisplay: "55 000 $" });
    expect(hook).toContain("Цена снижена");
    expect(hook).toContain("было 60 000 $");
    expect(hook).toContain("55 000 $");
  });
});

// ---------------------------------------------------------------------------

describe("lastSocialShowAt", () => {
  it("никогда не показывался — null", async () => {
    const p = await makeProperty({ withPhotos: 1 });
    expect(await lastSocialShowAt(p.id)).toBeNull();
  });

  it("был фото-пост — та дата", async () => {
    const p = await makeProperty({ withPhotos: 1 });
    const at = new Date(Date.now() - 10 * 86_400_000);
    await markShown(p.id, at);
    expect((await lastSocialShowAt(p.id))?.getTime()).toBe(at.getTime());
  });
});

// ---------------------------------------------------------------------------

describe("publishPropertyRepost — на стенде", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubMeta() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/media_publish")) return jsonResponse({ id: "media-repost-1" });
        if (url.includes("fields=permalink")) return jsonResponse({ permalink: "https://www.instagram.com/p/RP1/" });
        if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
        if (url.includes("/feed")) return jsonResponse({ id: "fb-repost-1" });
        if (url.includes("graph.facebook.com") && !url.includes("/feed")) return jsonResponse({ id: "fb-photo-repost-1" });
        return jsonResponse({ id: "container-repost-1" });
      })
    );
  }

  it("публикует круг по трём каналам, пишет СВОЮ таблицу, PropertyPhotoPost не трогает", async () => {
    stubMeta();
    const p = await makeProperty({ withPhotos: 2 });
    const photoPostCountBefore = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } });

    const summary = await publishPropertyRepost(p.id, 1, { force: true });

    expect(summary.ok).toBe(true);
    expect(summary.results.INSTAGRAM?.ok).toBe(true);
    expect(summary.results.FACEBOOK?.ok).toBe(true);
    expect(summary.results.TELEGRAM?.ok).toBe(true);

    const reposts = await prisma.propertySocialRepost.findMany({ where: { propertyId: p.id } });
    expect(reposts.map((r) => r.channel).sort()).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM"]);
    expect(reposts.every((r) => r.status === "PUBLISHED" && r.round === 1 && r.hook)).toBe(true);

    const photoPostCountAfter = await prisma.propertyPhotoPost.count({ where: { propertyId: p.id } });
    expect(photoPostCountAfter).toBe(photoPostCountBefore);
  });

  it("круг превышает repostMaxRounds — честный отказ, ничего не пишет", async () => {
    stubMeta();
    const p = await makeProperty({ withPhotos: 1 });
    const summary = await publishPropertyRepost(p.id, 5, { force: true });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("лимит");
    const reposts = await prisma.propertySocialRepost.count({ where: { propertyId: p.id } });
    expect(reposts).toBe(0);
  });

  it("гейт repostsEnabled — без force публикация не запускается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { repostsEnabled: false } });
    const p = await makeProperty({ withPhotos: 1 });
    const summary = await publishPropertyRepost(p.id, 1);
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("выключены");
    await prisma.settings.update({ where: { id: "singleton" }, data: { repostsEnabled: true } });
  });

  it("объект не в продаже — отказ", async () => {
    stubMeta();
    const p = await makeProperty({ withPhotos: 1, status: "SOLD" });
    const summary = await publishPropertyRepost(p.id, 1, { force: true });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("продаж");
  });
});

// ---------------------------------------------------------------------------

describe("scheduleRepostsTick", () => {
  it("объект, показанный давно — получает слот и SCHEDULED-записи по трём каналам, круг 1", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const p = await makeProperty({ withPhotos: 1 });
    await markShown(p.id, old);

    const { scheduled } = await scheduleRepostsTick();
    expect(scheduled).toBeGreaterThanOrEqual(1);

    const reposts = await prisma.propertySocialRepost.findMany({ where: { propertyId: p.id } });
    expect(reposts).toHaveLength(3);
    expect(reposts.every((r) => r.status === "SCHEDULED" && r.scheduledAt && r.round === 1)).toBe(true);

    const job = await prisma.backgroundJob.findFirst({ where: { dedupeKey: `social-repost-publish:${p.id}:1` } });
    expect(job).not.toBeNull();
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `social-repost-publish:${p.id}:1` } });
  });

  it("свежий объект (moложе repostAfterDays) — не кандидат", async () => {
    const p = await makeProperty({ withPhotos: 1 });
    await markShown(p.id, new Date());
    await scheduleRepostsTick();
    const reposts = await prisma.propertySocialRepost.count({ where: { propertyId: p.id } });
    expect(reposts).toBe(0);
  });

  it("никогда не показывался — не кандидат (repostAfterDays не с чего считать)", async () => {
    const p = await makeProperty({ withPhotos: 1 });
    await scheduleRepostsTick();
    const reposts = await prisma.propertySocialRepost.count({ where: { propertyId: p.id } });
    expect(reposts).toBe(0);
  });

  it("round ограничен repostMaxRounds — объект с 3 опубликованными кругами не берётся кандидатом", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const p = await makeProperty({ withPhotos: 1 });
    await markShown(p.id, old);
    for (let round = 1; round <= 3; round++) {
      await prisma.propertySocialRepost.create({
        data: { propertyId: p.id, round, hook: "тест", channel: "INSTAGRAM", status: "PUBLISHED", publishedAt: old },
      });
    }
    await scheduleRepostsTick();
    const scheduled = await prisma.propertySocialRepost.count({ where: { propertyId: p.id, status: "SCHEDULED" } });
    expect(scheduled).toBe(0);
  });

  it("занятый слот (фото-пост/видео) учитывается — повтор не встаёт на то же время", async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const busyAt = new Date(Date.now() + 60_000);
    const occupied = await makeProperty({ withPhotos: 0 });
    await prisma.property.update({ where: { id: occupied.id }, data: { scheduledPublishAt: busyAt } });

    const p = await makeProperty({ withPhotos: 1 });
    await markShown(p.id, old);
    await scheduleRepostsTick();

    const reposts = await prisma.propertySocialRepost.findMany({ where: { propertyId: p.id, status: "SCHEDULED" } });
    expect(reposts.length).toBeGreaterThan(0);
    expect(reposts[0].scheduledAt?.getTime()).not.toBe(busyAt.getTime());

    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: [`social-repost-publish:${p.id}:1`] } } });
  });
});
