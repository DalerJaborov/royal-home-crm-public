import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ОПОЗНАНИЕ ПОСТА ПОД КОММЕНТАРИЯМИ И ЛИДЫ ПО ССЫЛКЕ — ФОТО-ПОСТЫ (28.09.2026,
 * agent-brief.md). Объект без ролика, опубликованный каруселью в Instagram,
 * ищется в `messengers/comments.ts::loadMediaContext` по `PropertyPhotoPost`
 * (mediaId/permalink), а не по `Property.instagramUrl` — то поле у такого
 * объекта пусто и обязано остаться пустым: фото-пост не Reels и не должен
 * снимать блокер продажи «нет ссылки на Reels» (см. lib/photoPosts.ts).
 *
 * Сеть (Graph API) подменена — тест не ходит в Meta. ИИ подменён — тест не
 * платит за токены и проверяет только то, что промт получил карточку объекта.
 */

const { decide } = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: decide }));

const { sleep } = vi.hoisted(() => ({ sleep: vi.fn(async (_ms: number) => {}) }));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()),
  sleep,
}));

import type { QueuedComment } from "../src/messengers/comments.js";
import { waitFor } from "./helpers/waitFor.js";

const { prisma } = await import("../src/db.js");
const { handleComment } = await import("../src/messengers/comments.js");
const { findAgentByInstagramPost } = await import("../src/lib/instagramPostLead.js");

const runId = Date.now().toString(36);
const SHORTCODE = `PP${runId}`;
const MEDIA_ID = `photopost-media-${runId}`;

let districtId = "";
let propertyId = "";
let propertyShortId = 0;
let agentId = "";

let graphCalls: { url: string; body?: Record<string, unknown> }[] = [];

function jsonResponse(data: unknown): Response {
  const text = JSON.stringify(data);
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
}

let instagram: CustomerMessengerFixture;

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  districtId = (await prisma.district.create({ data: { name: `Тест-район-фотопост-${runId}` } })).id;
  const bcrypt = await import("bcrypt");
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент фото-поста", phone: `+992952${runId}`, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 10) },
    })
  ).id;
  const property = await prisma.property.create({
    data: {
      title: `Тест-объект-фотопост-${runId}`,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 70,
      price: 58000,
      currency: "USD",
      districtId,
      address: "Тестовая, 21",
      condition: "GOOD",
      // ВАЖНО: instagramUrl намеренно пуст — объект без ролика, фото-пост
      // не пишет сюда ничего (см. докстринг lib/photoPosts.ts).
      instagramUrl: null,
      publishedOnSite: true,
      intakeAgentId: agentId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
  await prisma.propertyPhotoPost.create({
    data: {
      propertyId,
      channel: "INSTAGRAM",
      status: "PUBLISHED",
      mediaId: MEDIA_ID,
      permalink: `https://www.instagram.com/p/${SHORTCODE}/`,
      publishedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: `c-pp-${runId}` } } });
  await instagram.dispose();
  await prisma.propertyExposure.deleteMany({ where: { propertyId } });
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  graphCalls = [];
  decide.mockReset();
  sleep.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown; method?: string }) => {
      const address = String(url);
      graphCalls.push({ url: address, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
      if (address.includes("fields=permalink")) {
        return jsonResponse({ permalink: `https://www.instagram.com/p/${SHORTCODE}/`, caption: "Двушка у парка, без ролика" });
      }
      return jsonResponse({ id: `our-reply-${graphCalls.length}` });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function queueComment(suffix: string, text = "Салом! Нархаш чанд?"): Promise<QueuedComment> {
  await prisma.instagramComment.deleteMany({ where: { commentId: `c-pp-${runId}-${suffix}` } });
  return (await prisma.instagramComment.create({
    data: {
      commentId: `c-pp-${runId}-${suffix}`,
      accountExternalId: instagram.turnInput(`author-pp-${runId}`).accountExternalId,
      mediaId: MEDIA_ID,
      authorId: `author-pp-${runId}`,
      authorName: "sardor",
      text,
      replyDueAt: new Date(),
    },
  })) as QueuedComment;
}

describe("loadMediaContext находит фото-пост, без правки instagramUrl", () => {
  it("публичный ответ называет цену и район объекта, найденного по PropertyPhotoPost.mediaId", async () => {
    decide.mockResolvedValue({ action: "reply", reply: "Салом! Ин хона 58 000 $ аст." });
    const row = await queueComment("reply");

    expect(await handleComment(row)).toBe("replied");

    const system = decide.mock.calls[0][0].system as string;
    expect(system).toContain(`объект №${propertyShortId}`);

    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved?.propertyId).toBe(propertyId);

    // ГЛАВНАЯ ПРОВЕРКА: instagramUrl объекта остался пустым — фото-пост не
    // Reels, healInstagramUrl по нему вызываться не должен (иначе блокер
    // продажи «нет ссылки на Reels» снялся бы для объекта без ролика).
    const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { instagramUrl: true } });
    expect(property?.instagramUrl).toBeNull();
  });

  it("интерес под постом записан на пару (канал, автор) — директ того же человека потом пойдёт агенту объекта", async () => {
    decide.mockResolvedValue({ action: "reply", reply: "Салом! Ин хона 58 000 $ аст." });
    const row = await queueComment("exposure");
    expect(await handleComment(row)).toBe("replied");
    const exposure = await waitFor(
      () =>
        prisma.propertyExposure.findFirst({
          where: { channel: "INSTAGRAM", recipientId: `author-pp-${runId}`, propertyId, kind: "CLIENT_SHARED" },
        }),
      { label: "экспозиция из комментария" }
    );
    expect(exposure?.shortId).toBe(propertyShortId);
  });
});

describe("findAgentByInstagramPost — ссылка на фото-пост", () => {
  it("находит объект и агента по permalink PropertyPhotoPost (после основного поиска по instagramUrl)", async () => {
    const match = await findAgentByInstagramPost(`Смотрел вот эту квартиру https://www.instagram.com/p/${SHORTCODE}/ можно узнать подробнее?`);
    expect(match).not.toBeNull();
    expect(match?.propertyId).toBe(propertyId);
    expect(match?.propertyShortId).toBe(propertyShortId);
    expect(match?.agentId).toBe(agentId);
  });
});
