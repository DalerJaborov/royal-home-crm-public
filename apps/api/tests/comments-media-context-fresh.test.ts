import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * КОНТЕКСТ ПУБЛИКАЦИИ ДЛЯ ОТВЕТА НА КОММЕНТАРИЙ (аудит Codex, 04.10.2026).
 *
 * CHANNEL-NEW-35: кэш `mediaCache` живёт 30 минут и замораживал вместе с ответом Graph API
 * и карточку объекта: после смены цены или статуса следующий комментарий под тем же
 * постом получал прежние цену и статус, а промт требует назвать их публично.
 * CHANNEL-NEW-36: запасной поиск через PUBLISHED-фотопост брал объект по id без
 * `deletedAt: null`, и объект из Корзины попадал в ответ как действующий.
 *
 * Сеть (Graph API) и ИИ подменены; проверяем, что промт получил свежую карточку.
 */

const { decide } = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: decide,
}));

const { sleep } = vi.hoisted(() => ({ sleep: vi.fn(async (_ms: number) => {}) }));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()),
  sleep,
}));

import type { QueuedComment } from "../src/messengers/comments.js";

const { prisma } = await import("../src/db.js");
const { handleComment } = await import("../src/messengers/comments.js");

// Цена в промте печатается describeProperty через toLocaleString("ru-RU") ("58 111" с неразрывным пробелом).
const fmt = (n: number) => n.toLocaleString("ru-RU");
const runId = Date.now().toString(36);
const MEDIA_FRESH = `fresh-media-${runId}`;
const MEDIA_DELETED = `deleted-media-${runId}`;

let districtId = "";
let freshPropertyId = "";
let deletedPropertyId = "";
let fetchMediaCalls = 0;

function jsonResponse(data: unknown): Response {
  const text = JSON.stringify(data);
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
}

const savedIgToken = process.env.META_IG_TOKEN;

async function makeProperty(suffix: string, price: number) {
  return prisma.property.create({
    data: {
      title: `Тест-объект-свежесть-${suffix}-${runId}`,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 70,
      price,
      currency: "USD",
      districtId,
      address: "Тестовая, 21",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
    },
  });
}

beforeAll(async () => {
  process.env.META_IG_TOKEN = "test-ig-token";
  districtId = (await prisma.district.create({ data: { name: `Тест-район-свежесть-${runId}` } })).id;
  const fresh = await makeProperty("fresh", 58111);
  freshPropertyId = fresh.id;
  await prisma.propertyPhotoPost.create({
    data: { propertyId: fresh.id, channel: "INSTAGRAM", status: "PUBLISHED", mediaId: MEDIA_FRESH, publishedAt: new Date() },
  });
  const deleted = await makeProperty("deleted", 47222);
  deletedPropertyId = deleted.id;
  await prisma.propertyPhotoPost.create({
    data: { propertyId: deleted.id, channel: "INSTAGRAM", status: "PUBLISHED", mediaId: MEDIA_DELETED, publishedAt: new Date() },
  });
});

afterAll(async () => {
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: `c-fresh-${runId}` } } });
  await prisma.propertyExposure.deleteMany({ where: { propertyId: { in: [freshPropertyId, deletedPropertyId] } } });
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId: { in: [freshPropertyId, deletedPropertyId] } } });
  await prisma.property.deleteMany({ where: { id: { in: [freshPropertyId, deletedPropertyId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  if (savedIgToken === undefined) delete process.env.META_IG_TOKEN;
  else process.env.META_IG_TOKEN = savedIgToken;
  await prisma.$disconnect();
});

beforeEach(() => {
  decide.mockReset();
  sleep.mockClear();
  fetchMediaCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const address = String(url);
      if (address.includes("fields=permalink")) {
        fetchMediaCalls++;
        return jsonResponse({ permalink: `https://www.instagram.com/p/NOMATCH${runId}/`, caption: "Двушка у парка" });
      }
      return jsonResponse({ id: `our-reply-${Math.random()}` });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function queueComment(mediaId: string, suffix: string): Promise<QueuedComment> {
  return (await prisma.instagramComment.create({
    data: {
      commentId: `c-fresh-${runId}-${suffix}`,
      mediaId,
      authorId: `author-fresh-${runId}-${suffix}`,
      authorName: "sardor",
      text: "Салом! Нархаш чанд?",
      replyDueAt: new Date(),
    },
  })) as QueuedComment;
}

describe("CHANNEL-NEW-35: кэш публикации не замораживает карточку объекта", () => {
  it("второй комментарий под тем же постом видит новую цену и статус, а Graph API зовётся один раз", async () => {
    decide.mockResolvedValue({ action: "reply", reply: "Салом!" });
    await handleComment(await queueComment(MEDIA_FRESH, "a"));
    const first = decide.mock.calls[0][0].system as string;
    expect(first).toContain(fmt(58111));
    expect(first).not.toContain("УЖЕ НЕ В ПРОДАЖЕ");
    expect(fetchMediaCalls).toBe(1);

    await prisma.property.update({ where: { id: freshPropertyId }, data: { price: 61333, status: "SOLD" } });
    decide.mockClear();

    await handleComment(await queueComment(MEDIA_FRESH, "b"));
    const second = decide.mock.calls[0][0].system as string;
    expect(second).toContain(fmt(61333));
    expect(second).not.toContain(fmt(58111));
    expect(second).toContain("УЖЕ НЕ В ПРОДАЖЕ");
    expect(fetchMediaCalls).toBe(1);
  });
});

describe("CHANNEL-NEW-36: объект из Корзины не возвращается через фотопост", () => {
  it("фотопост опубликован, объект в Корзине: промт без карточки, а не с ценой удалённого", async () => {
    await prisma.property.update({ where: { id: deletedPropertyId }, data: { deletedAt: new Date() } });
    decide.mockResolvedValue({ action: "reply", reply: "Салом!" });

    await handleComment(await queueComment(MEDIA_DELETED, "c"));

    const system = decide.mock.calls[0][0].system as string;
    expect(system).not.toContain(fmt(47222));
    expect(system).toContain("Публикация не привязана к объекту в базе");
  });
});
