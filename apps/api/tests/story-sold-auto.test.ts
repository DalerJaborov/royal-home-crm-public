import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСТОРИЯ «ПРОДАНО» САМА ПРИ ПРОДАЖЕ + ПОДБОРКА РОЛИКОМ БЕЗ ЦЕНЫ (26.11.2026, владелец: «да» на оба пункта).
 *  - дверь продажи (lib/propertyLeftSale.ts) ставит задание: смена статуса карточкой/помощником
 *    (runPropertyStatusEffects) и ночная сверка по закрытой сделке; пауза 10 минут, один раз на объект;
 *  - не ставит: выключатель, автоистории Instagram выключены, объект не был в продаже, частный, «продано» уже было;
 *  - задание перед публикацией перечитывает выключатель, статус, «только для своих» и «уже было»;
 *  - мёртвый ключ (401/190, дверь #432): повтора нет, фото вторым запросом не пробуем; помеченный аккаунт — в Meta
 *    не ходим вовсе;
 *  - кнопка «Продано», пока автоистория ждёт паузу, — та же история сейчас и вручную, без второй;
 *  - карточка подборки поверх ролика — без цены; старый ролик с ценой в кадре — фото-карточка.
 * Сеть Meta, рендер карточки и ffmpeg подменены; решения нашего кода — на настоящей базе.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

type PublishMock = { channel: "INSTAGRAM"; ok: boolean; postId?: string; pending?: boolean; error?: string };
const { publishInstagramStoryImage, publishInstagramStory } = vi.hoisted(() => ({
  publishInstagramStoryImage: vi.fn(async (..._a: unknown[]) => ({ channel: "INSTAGRAM" as const, ok: true, postId: "photo-1" }) as PublishMock),
  publishInstagramStory: vi.fn(async (..._a: unknown[]) => ({ channel: "INSTAGRAM" as const, ok: true, postId: "video-1" }) as PublishMock),
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishInstagramStoryImage,
  publishInstagramStory,
}));

const { instagramTokenIdentity } = vi.hoisted(() => ({
  instagramTokenIdentity: vi.fn(async () => ({ ok: true as const, id: "ig-user-1" })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  instagramTokenIdentity,
}));

const { generateStoryCard, generateStoryCardOverlay } = vi.hoisted(() => ({
  generateStoryCard: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, image: Buffer.from("fake-jpeg"), error: null })),
  generateStoryCardOverlay: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, image: Buffer.from("fake-png"), error: null })),
}));
vi.mock("../src/lib/video/storyCard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/video/storyCard.js")>()),
  generateStoryCard,
  generateStoryCardOverlay,
}));

const { probeVideoDimensions, overlayCardOnVideo } = vi.hoisted(() => ({
  probeVideoDimensions: vi.fn(async (..._a: unknown[]) => ({ width: 1080, height: 1920, durationSec: 30 })),
  overlayCardOnVideo: vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeVideoDimensions,
  overlayCardOnVideo,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const unlink = vi.fn(async (..._a: unknown[]) => {});
  return { ...actual, default: { ...actual, writeFile: vi.fn(async () => {}), unlink }, writeFile: vi.fn(async () => {}), unlink };
});

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const stories = await import("../src/lib/instagramStories.js");
const { propertyStatusStoryJob } = await import("../src/jobs/propertyStatusStory.js");
const { closeWorkAfterLeavingSale } = await import("../src/lib/propertyLeftSale.js");
const { runPropertyStatusEffects } = await import("../src/lib/propertyStatusChange.js");
const { refreshPropertyStatus } = await import("../src/lib/propertyAutoStatus.js");
const { encryptSecret } = await import("../src/crypto.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = `${Date.now()}`;
const FAKE_TOKEN = `fake-ig-token-sold-${runId}`;
let districtId: string;
let agentId: string;
let clientId: string;
const propertyIds: string[] = [];
let savedSettings: {
  metaIgToken: string | null;
  instagramStoriesEnabled: boolean;
  facebookStoriesEnabled: boolean;
  instagramStoryVideoEnabled: boolean;
  storySoldAutoEnabled: boolean;
};

async function makeProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Продано-авто ${propertyIds.length}-${runId}`, type: "APARTMENT", areaSqm: 50, rooms: 2, floor: 3, totalFloors: 9,
      price: 870000, currency: "TJS", districtId, address: "Тестовая, 7", condition: "GOOD", status: "AVAILABLE",
      videoHandoffStatus: "RECEIVED", clipReviewStatus: "APPROVED",
      videoHandoffFinalPath: `/uploads/handoff/sold-auto-${runId}-${propertyIds.length}.mp4`,
      videoHandoffLastFactsText: "Объект №1\nЭтаж: 3",
      narrationOff: true,
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

const jobKey = (propertyId: string) => `${stories.PROPERTY_STATUS_STORY_JOB_TYPE}:SOLD:${propertyId}`;
const findJob = (propertyId: string) => prisma.backgroundJob.findFirst({ where: { dedupeKey: jobKey(propertyId) } });
const runJob = (payload: Record<string, unknown>, attempt = 1) =>
  propertyStatusStoryJob.run(propertyStatusStoryJob.schema.parse(payload), { attempt } as never);
const autoPayload = (propertyId: string) => ({ propertyId, kind: "SOLD", priceWasText: null, priceWasTjs: null, queuedAt: Date.now(), auto: true });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Продано-авто-район-${runId}` } })).id;
  agentId = (await prisma.agent.create({
    data: { fullName: `Продано Агент ${runId}`, phone: `+992935${runId.slice(-7)}`, role: "AGENT", passwordHash: "x" },
  })).id;
  clientId = (await prisma.client.create({
    data: { fullName: `Продано-клиент ${runId}`, phone: `+992936${runId.slice(-7)}`, source: "WEBSITE", assignedAgentId: agentId, acceptedAt: new Date() },
  })).id;
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaIgToken: current.metaIgToken, instagramStoriesEnabled: current.instagramStoriesEnabled,
    facebookStoriesEnabled: current.facebookStoriesEnabled, instagramStoryVideoEnabled: current.instagramStoryVideoEnabled,
    storySoldAutoEnabled: current.storySoldAutoEnabled,
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  publishInstagramStory.mockResolvedValue({ channel: "INSTAGRAM", ok: true, postId: "video-1" });
  publishInstagramStoryImage.mockResolvedValue({ channel: "INSTAGRAM", ok: true, postId: "photo-1" });
  overlayCardOnVideo.mockResolvedValue({ ok: true });
  probeVideoDimensions.mockResolvedValue({ width: 1080, height: 1920, durationSec: 30 });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaIgToken: encryptSecret(FAKE_TOKEN), instagramStoriesEnabled: true, facebookStoriesEnabled: false, instagramStoryVideoEnabled: true, storySoldAutoEnabled: true },
  });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { OR: propertyIds.map((id) => ({ dedupeKey: { contains: id } })) } });
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.pendingInstagramContainer.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.messengerAccount.deleteMany({ where: { externalId: { startsWith: `ig-sold-${runId}` } } });
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("дверь продажи ставит автоисторию «Продано»", () => {
  it("смена статуса карточкой (runPropertyStatusEffects): задание auto с паузой 10 минут, без force", async () => {
    const before = await makeProperty();
    const updated = await prisma.property.update({ where: { id: before.id }, data: { status: "SOLD" } });
    const started = Date.now();
    await runPropertyStatusEffects({ actorId: agentId, before, updated, to: "SOLD" });

    const job = (await waitFor(() => findJob(before.id), { label: "задание автоистории" }))!;
    const payload = job.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ propertyId: before.id, kind: "SOLD", auto: true });
    expect(payload.force).toBeUndefined();
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(started + stories.SOLD_AUTO_STORY_DELAY_MS - 1000);
  });

  it("ночная сверка по закрытой сделке тоже ставит", async () => {
    const property = await makeProperty();
    await prisma.deal.create({ data: { clientId, propertyId: property.id, agentId, stage: "COMPLETED", closedAt: new Date() } });
    expect(await refreshPropertyStatus(property.id)).toBe("SOLD");
    const job = (await waitFor(() => findJob(property.id), { label: "задание после сверки" }))!;
    expect((job.payload as Record<string, unknown>).auto).toBe(true);
  });

  it("ночная сверка по сделке, закрытой давно (больше 48 часов), — истории нет", async () => {
    const property = await makeProperty();
    await prisma.deal.create({ data: { clientId, propertyId: property.id, agentId, stage: "COMPLETED", closedAt: new Date(Date.now() - 5 * 86_400_000) } });
    expect(await refreshPropertyStatus(property.id)).toBe("SOLD");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await findJob(property.id)).toBeNull();
    expect(await stories.queueAutoPropertySoldStory(property.id, "AVAILABLE", new Date(Date.now() - 49 * 3_600_000))).toBe("stale");
    expect(await stories.queueAutoPropertySoldStory(property.id, "AVAILABLE", null)).toBe("stale");
  });

  it("не ставит: выключатель, автоистории выключены, не был в продаже, частный, «продано» уже было", async () => {
    const p = await makeProperty({ status: "SOLD" });

    await prisma.settings.update({ where: { id: "singleton" }, data: { storySoldAutoEnabled: false } });
    expect(await stories.queueAutoPropertySoldStory(p.id, "AVAILABLE")).toBe("switch-off");
    await prisma.settings.update({ where: { id: "singleton" }, data: { storySoldAutoEnabled: true, instagramStoriesEnabled: false } });
    expect(await stories.queueAutoPropertySoldStory(p.id, "AVAILABLE")).toBe("stories-off");
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: true } });

    expect(await stories.queueAutoPropertySoldStory(p.id, "WITHDRAWN")).toBe("not-on-sale");
    expect(await stories.queueAutoPropertySoldStory(p.id, "PENDING_REVIEW")).toBe("not-on-sale");
    expect(await stories.queueAutoPropertySoldStory(p.id, null)).toBe("not-on-sale");

    const priv = await makeProperty({ status: "SOLD", offSite: true });
    expect(await stories.queueAutoPropertySoldStory(priv.id, "AVAILABLE")).toBe("private");

    await prisma.propertyStoryPost.create({ data: { propertyId: p.id, channel: "INSTAGRAM", mediaId: "old", partIndex: 0, kind: "SOLD", publishedAt: new Date(Date.now() - 30 * 86_400_000) } });
    expect(await stories.queueAutoPropertySoldStory(p.id, "RESERVED")).toBe("already");

    expect(await findJob(p.id)).toBeNull();
    expect(await findJob(priv.id)).toBeNull();
  });

  it("снятие с продажи и резерв автоисторию не ставят", async () => {
    const p = await makeProperty({ status: "WITHDRAWN" });
    closeWorkAfterLeavingSale(p.id, "withdrawn");
    const r = await makeProperty({ status: "RESERVED" });
    closeWorkAfterLeavingSale(r.id, "reserved", "AVAILABLE");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await findJob(p.id)).toBeNull();
    expect(await findJob(r.id)).toBeNull();
  });
});

describe("задание автоистории перед публикацией", () => {
  it("всё сходится — выходит ролик с печатью, без force (рубильник автоисторий спрошен)", async () => {
    const p = await makeProperty({ status: "SOLD" });
    await runJob(autoPayload(p.id));
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(await prisma.propertyStoryPost.count({ where: { propertyId: p.id, kind: "SOLD", channel: "INSTAGRAM" } })).toBe(1);
  });

  it("автоистории Instagram выключили, пока ждала, — ничего не выходит (force нет)", async () => {
    const p = await makeProperty({ status: "SOLD" });
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoriesEnabled: false } });
    await runJob(autoPayload(p.id));
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
  });

  it("выключатель выключили, продажу отменили, объект стал частным, «продано» уже было — ничего не выходит", async () => {
    const off = await makeProperty({ status: "SOLD" });
    await prisma.settings.update({ where: { id: "singleton" }, data: { storySoldAutoEnabled: false } });
    await runJob(autoPayload(off.id));
    await prisma.settings.update({ where: { id: "singleton" }, data: { storySoldAutoEnabled: true } });

    const back = await makeProperty({ status: "AVAILABLE" });
    await runJob(autoPayload(back.id));

    const priv = await makeProperty({ status: "SOLD", offSite: true });
    await runJob(autoPayload(priv.id));

    const had = await makeProperty({ status: "SOLD" });
    await prisma.propertyStoryPost.create({ data: { propertyId: had.id, channel: "INSTAGRAM", mediaId: "old", partIndex: 0, kind: "SOLD", publishedAt: new Date(Date.now() - 5 * 86_400_000) } });
    await runJob(autoPayload(had.id));

    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
  });

  it("кнопка «Продано», пока автоистория ждёт паузу, — то же задание сейчас и вручную, второго нет", async () => {
    const p = await makeProperty({ status: "SOLD" });
    expect(await stories.queueAutoPropertySoldStory(p.id, "AVAILABLE")).toBe("queued");
    expect(await stories.queuePropertySoldStory(p.id)).toBe(true);
    const jobs = await prisma.backgroundJob.findMany({ where: { dedupeKey: jobKey(p.id) } });
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as Record<string, unknown>).force).toBe(true);
    expect(jobs[0].runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("мёртвый ключ Instagram (дверь #432): не бомбить", () => {
  it("Meta ответила 401/190 на ролик — без повтора и без второго запроса фото-карточкой", async () => {
    const p = await makeProperty({ status: "SOLD" });
    publishInstagramStory.mockResolvedValue({
      channel: "INSTAGRAM", ok: false,
      error: 'Graph API HTTP 401: {"error":{"message":"Error validating access token: The session has been invalidated because the user changed their password","code":190}}',
    });
    await expect(runJob(autoPayload(p.id))).resolves.toBeUndefined();
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("повторять не будем"), expect.objectContaining({ dedupKey: expect.stringContaining(p.id) }));
  });

  it("аккаунт помечен «доступ потерян» — в Meta не идём вовсе, задание не повторяется", async () => {
    const p = await makeProperty({ status: "SOLD" });
    await prisma.messengerAccount.create({
      data: {
        channel: "INSTAGRAM", externalId: `ig-sold-${runId}`, title: `IG продано ${runId}`, token: encryptSecret(FAKE_TOKEN),
        accessLostAt: new Date(), accessLostReason: "сменили пароль",
      },
    });
    try {
      await expect(runJob(autoPayload(p.id))).resolves.toBeUndefined();
      expect(instagramTokenIdentity).not.toHaveBeenCalled();
      expect(publishInstagramStory).not.toHaveBeenCalled();
      expect(publishInstagramStoryImage).not.toHaveBeenCalled();
    } finally {
      await prisma.messengerAccount.deleteMany({ where: { externalId: `ig-sold-${runId}` } });
    }
  });

  it("обычный отказ Meta (не ключ) — задание повторится, как раньше", async () => {
    const p = await makeProperty({ status: "SOLD" });
    publishInstagramStory.mockResolvedValue({ channel: "INSTAGRAM", ok: false, error: "Media type is invalid" });
    publishInstagramStoryImage.mockResolvedValue({ channel: "INSTAGRAM", ok: false, error: "Media type is invalid" });
    await expect(runJob(autoPayload(p.id))).rejects.toThrow(/Media type/);
  });
});

describe("карточка подборки поверх ролика — без цены", () => {
  it("ролик годится — карточка поверх рисуется с hidePrice, история выходит роликом", async () => {
    const p = await makeProperty();
    const summary = await stories.publishPropertyCardStory(p.id, { force: true, video: true });
    expect(summary).toMatchObject({ publishedParts: 1, video: true });
    // Голос озвучки может назвать цену — подборка роликом идёт без звука.
    expect(overlayCardOnVideo).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ mute: true }));
    expect(generateStoryCardOverlay).toHaveBeenCalledWith(p.id, expect.objectContaining({ hidePrice: true }), expect.anything());
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
  });

  it("старый ролик с ценой в кадре — ролик не берём, выходит фото-карточка тоже без цены", async () => {
    const p = await makeProperty({ videoHandoffLastFactsText: "Объект №1\nЦена: 870 000 с." });
    const summary = await stories.publishPropertyCardStory(p.id, { force: true, video: true });
    expect(summary.video).toBeUndefined();
    expect(overlayCardOnVideo).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
    expect(generateStoryCard).toHaveBeenCalledWith(p.id, expect.objectContaining({ hidePrice: true }));
  });

  it("«Продано» (автоистория): ролик с ценой в кадре не берём, фото-карточка с печатью и без цены", async () => {
    const p = await makeProperty({ status: "SOLD", videoHandoffLastFactsText: "Объект №1\nЦена: 870 000 с." });
    await runJob(autoPayload(p.id));
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(generateStoryCard).toHaveBeenCalledWith(p.id, expect.objectContaining({ soldStamp: true, hidePrice: true }));
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
  });

  it("«Продано» роликом без цены в кадре — карточка поверх с печатью и без цены, ролик без звука", async () => {
    const p = await makeProperty({ status: "SOLD" });
    await runJob(autoPayload(p.id));
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(overlayCardOnVideo).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ mute: true }));
    expect(generateStoryCardOverlay).toHaveBeenCalledWith(p.id, expect.objectContaining({ soldStamp: true, hidePrice: true }), expect.anything());
  });

  it("ffmpeg отказал — причина в журнале и фото-карточка", async () => {
    const p = await makeProperty();
    overlayCardOnVideo.mockResolvedValue({ ok: false, reason: "код 1; Invalid data" });
    const summary = await stories.publishPropertyCardStory(p.id, { force: true, video: true });
    expect(summary.publishedParts).toBe(1);
    expect(summary.video).toBeUndefined();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("Invalid data"));
  });

  it("cardVideoClipUsable: сдан, не на проверке, без цены в кадре", () => {
    const ok = { videoHandoffFinalPath: "/uploads/handoff/a.mp4", videoHandoffStatus: "RECEIVED", clipReviewStatus: "APPROVED", videoHandoffLastFactsText: "Этаж: 3" };
    expect(stories.cardVideoClipUsable(ok)).toBe(true);
    expect(stories.cardVideoClipUsable({ ...ok, videoHandoffLastFactsText: "Цена: 1 с." })).toBe(false);
    expect(stories.cardVideoClipUsable({ ...ok, videoHandoffLastFactsText: null })).toBe(false);
    expect(stories.cardVideoClipUsable({ ...ok, clipReviewStatus: "PENDING" })).toBe(false);
    expect(stories.cardVideoClipUsable({ ...ok, videoHandoffStatus: "SENT_TO_EDITOR" })).toBe(false);
    expect(stories.cardVideoClipUsable({ ...ok, videoHandoffFinalPath: null })).toBe(false);
  });
});
