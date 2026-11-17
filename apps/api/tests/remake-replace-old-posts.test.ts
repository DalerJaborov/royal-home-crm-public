import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * СТАРЫЕ ПОСТЫ УХОДЯТ, КОГДА ВЫХОДИТ НОВЫЙ РОЛИК (30.10.2026, владелец: «когда выйдет
 * новый»). Перемонтаж по новой цене оставляет старый ролик висеть, а задание публикации
 * нового ролика (replaceOldPostsBeforeRemakePublish) снимает его перед своим выходом.
 *
 * Сеть подменена: TikTok не даёт удалять вовсе, поэтому для него проверяется главное —
 * канал вычеркнут из карточки, и новый ролик туда выйдет, а хозяину ушёл пуш.
 */
const { sendPushToAgent } = vi.hoisted(() => ({ sendPushToAgent: vi.fn(async () => 1) }));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { replaceOldPostsBeforeRemakePublish, sendBackToMontajer } = await import("../src/lib/publishedVideoFix.js");

const runId = Date.now();
let districtId = "";
let agentId = "";
const propertyIds: string[] = [];

async function seed(publishedChannels: string[], publishedPostIds: Record<string, string>) {
  const property = await prisma.property.create({
    data: {
      title: `Замена постов ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 58,
      floor: 5,
      price: 450000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
      publishedChannels,
      publishedPostIds,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Замена постов ${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент замены ${runId}`, phone: `+992937${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("replaceOldPostsBeforeRemakePublish", () => {
  it("без отметки замены ничего не трогает", async () => {
    const p = await seed(["TIKTOK"], { TIKTOK: "777" });
    await prisma.videoRemakeRequest.create({
      data: { propertyId: p.id, reason: "POOR_EDIT", requestedById: agentId },
    });
    expect(await replaceOldPostsBeforeRemakePublish(p.id)).toBeNull();
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.publishedChannels).toEqual(["TIKTOK"]);
  });

  it("с отметкой: ручной канал вычеркнут, новый ролик туда выйдет, хозяину пуш, повтор — пусто", async () => {
    sendPushToAgent.mockClear();
    const p = await seed(["TIKTOK"], { TIKTOK: "777" });
    await prisma.videoRemakeRequest.create({
      data: { propertyId: p.id, reason: "CARD_DATA_CHANGED", requestedById: agentId, replaceOldPostsOnPublish: true },
    });

    const res = await replaceOldPostsBeforeRemakePublish(p.id);
    expect(res?.manual.map((m) => m.channel)).toEqual(["TIKTOK"]);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.publishedChannels).toEqual([]);
    expect((after.publishedPostIds as Record<string, unknown>).TIKTOK).toBeUndefined();
    expect(sendPushToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({ tag: `remake-old-posts-${p.id}` }));

    const request = await prisma.videoRemakeRequest.findFirstOrThrow({ where: { propertyId: p.id } });
    expect(request.oldPostsReplacedAt).not.toBeNull();
    // Повтор задания после сбоя сети не снимает уже вышедший новый ролик.
    expect(await replaceOldPostsBeforeRemakePublish(p.id)).toBeNull();
  });

  it("sendBackToMontajer с on-new-video ставит отметку и не снимает посты сразу", async () => {
    const p = await seed(["TIKTOK"], { TIKTOK: "778" });
    // Отказ (нет исходников / выключена передача) — до записи заявки; отметку проверяем
    // только когда возврат прошёл.
    const sent = await sendBackToMontajer(p.id, agentId, "CARD_DATA_CHANGED", "Новая цена", null, {
      removeFromSocial: "on-new-video",
    });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.publishedChannels).toEqual(["TIKTOK"]);
    if (sent.ok) {
      expect(sent.social).toBeUndefined();
      const request = await prisma.videoRemakeRequest.findFirstOrThrow({ where: { propertyId: p.id } });
      expect(request.replaceOldPostsOnPublish).toBe(true);
      expect(request.oldPostsReplacedAt).toBeNull();
    }
  });
});
