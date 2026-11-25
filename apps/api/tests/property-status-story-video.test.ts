import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСТОРИЯ «ЦЕНА СНИЖЕНА» / «ПРОДАНО» ГОТОВЫМ РОЛИКОМ (25–26.11.2026, ревью #445) — рискованное поведение на базе:
 *  - голос в ролике со старой ценой (звучащая версия озвучки собрана по старым фактам) — фото, а не ролик (класс №214);
 *  - есть озвучка новее звучащей — задание ждёт, а на последней попытке выходит фото;
 *  - старый ролик с ценой, набранной в кадр, — «цена снижена» только фото, «продано» роликом можно;
 *  - «продано», а продажу отменили, пока задание ждало, — ничего не публикуем;
 *  - Meta оставила контейнер ждать (pending) — фото вторым не выкладываем, файл ролика не удаляем;
 *  - Meta отказала, ничего не создав, — откат на фото; ffmpeg не справился — причина в журнале и фото;
 *  - рубильник «готовым роликом» выключен — фото;
 *  - повтор задания после успеха ничего не выкладывает второй раз; автоистория ролика после «цена снижена» не выходит.
 * Сеть Meta, рендер карточки и ffmpeg подменены; решения нашего кода — настоящие, на настоящей базе.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { publishInstagramStoryImage, publishInstagramStory } = vi.hoisted(() => ({
  publishInstagramStoryImage: vi.fn(async (..._a: unknown[]) => ({ channel: "INSTAGRAM" as const, ok: true, postId: "photo-1" }) as { channel: "INSTAGRAM"; ok: boolean; postId?: string; pending?: boolean; error?: string }),
  publishInstagramStory: vi.fn(async (..._a: unknown[]) => ({ channel: "INSTAGRAM" as const, ok: true, postId: "video-1" }) as { channel: "INSTAGRAM"; ok: boolean; postId?: string; pending?: boolean; error?: string }),
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
  generateStoryCard: vi.fn(async () => ({ ok: true as const, image: Buffer.from("fake-jpeg"), error: null })),
  generateStoryCardOverlay: vi.fn(async () => ({ ok: true as const, image: Buffer.from("fake-png"), error: null })),
}));
vi.mock("../src/lib/video/storyCard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/video/storyCard.js")>()),
  generateStoryCard,
  generateStoryCardOverlay,
}));

const { probeVideoDimensions, overlayCardOnVideo } = vi.hoisted(() => ({
  probeVideoDimensions: vi.fn(async () => ({ width: 1080, height: 1920, durationSec: 30 })),
  overlayCardOnVideo: vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeVideoDimensions,
  overlayCardOnVideo,
}));

const { unlink } = vi.hoisted(() => ({ unlink: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, writeFile: vi.fn(async () => {}), unlink }, writeFile: vi.fn(async () => {}), unlink };
});

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const stories = await import("../src/lib/instagramStories.js");
const { propertyStatusStoryJob } = await import("../src/jobs/propertyStatusStory.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");
const { encryptSecret } = await import("../src/crypto.js");

const runId = `${Date.now()}`;
let districtId: string;
let propertyId: string;
let savedSettings: { metaIgToken: string | null; instagramStoriesEnabled: boolean; facebookStoriesEnabled: boolean; instagramStoryVideoEnabled: boolean };
let versionSeq = 0;

const PRICE = 870000;

async function resetProperty(data: Record<string, unknown> = {}) {
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId } });
  await prisma.pendingInstagramContainer.deleteMany({ where: { propertyId } });
  await prisma.property.update({ where: { id: propertyId }, data: { videoMasterNarrationVersionId: null } });
  await prisma.propertyNarrationDelivery.deleteMany({ where: { propertyId } });
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId } });
  await prisma.property.update({
    where: { id: propertyId },
    data: {
      status: "AVAILABLE", price: PRICE, currency: "TJS", narrationOff: false,
      videoHandoffStatus: "RECEIVED", clipReviewStatus: "APPROVED",
      videoHandoffFinalPath: `/uploads/handoff/${propertyId}-1764000000000.mp4`,
      videoHandoffLastFactsText: "Объект №1\nЭтаж: 3",
      ...data,
    },
  });
}

/** Версия озвучки: `price` — цена, по которой собраны её факты (по умолчанию текущая). */
async function addVersion(opts: { price?: number; approved?: boolean; status?: string } = {}) {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, include: { district: true } });
  const facts = narrationFacts({ ...p, price: opts.price ?? Number(p.price) }, false);
  versionSeq += 1;
  return prisma.propertyNarrationVersion.create({
    data: {
      propertyId, revision: versionSeq, script: "Текст озвучки", factsSnapshot: facts as object, factsHash: narrationHash(facts),
      status: opts.status ?? "READY", approvedAt: opts.approved === false ? null : new Date(), createdById: "test",
      requestKey: `storynp-${runId}-${versionSeq}`,
    },
  });
}

const runJob = (payload: Record<string, unknown>, attempt = 1) =>
  propertyStatusStoryJob.run(propertyStatusStoryJob.schema.parse(payload), { attempt } as never);

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-история-ролик-${runId}` } })).id;
  propertyId = (await prisma.property.create({
    data: { title: `Тест-объект-история-ролик-${runId}`, type: "APARTMENT", areaSqm: 50, rooms: 2, floor: 3, totalFloors: 9, price: PRICE, currency: "TJS", districtId, address: "Тестовая, 5", condition: "GOOD", status: "AVAILABLE" },
  })).id;
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaIgToken: current.metaIgToken, instagramStoriesEnabled: current.instagramStoriesEnabled,
    facebookStoriesEnabled: current.facebookStoriesEnabled, instagramStoryVideoEnabled: current.instagramStoryVideoEnabled,
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
    data: { metaIgToken: encryptSecret("fake-ig-token"), instagramStoriesEnabled: true, facebookStoriesEnabled: false, instagramStoryVideoEnabled: true },
  });
  await resetProperty();
});

afterAll(async () => {
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId } });
  await prisma.pendingInstagramContainer.deleteMany({ where: { propertyId } });
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { contains: propertyId } } });
  await prisma.property.update({ where: { id: propertyId }, data: { videoMasterNarrationVersionId: null } }).catch(() => {});
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId } });
  await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

const priceDrop = { propertyId: "", kind: "PRICE_DROP", priceWasText: "890 000 с.", priceWasTjs: 890000, queuedAt: Date.now() };
const dropPayload = () => ({ ...priceDrop, propertyId, queuedAt: Date.now() });

describe("«цена снижена» роликом: голос в ролике должен называть текущую цену", () => {
  it("озвучка в ролике собрана по нынешней цене — выходит ролик с карточкой", async () => {
    const v = await addVersion();
    await prisma.property.update({ where: { id: propertyId }, data: { videoMasterNarrationVersionId: v.id } });
    expect(await stories.priceDropVoiceCheck(propertyId)).toBe("OK");

    await runJob(dropPayload());

    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
  });

  it("в ролике звучит озвучка со СТАРОЙ ценой (она же последняя одобренная) — фото-карточка, не ролик", async () => {
    const v = await addVersion({ price: 890000 });
    await prisma.property.update({ where: { id: propertyId }, data: { videoMasterNarrationVersionId: v.id } });
    expect(await stories.priceDropVoiceCheck(propertyId)).toBe("STALE");

    await runJob(dropPayload());

    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
  });

  it("голос вклеивал монтажёр: сверяется доставленная ему версия, старая цена — фото", async () => {
    const v = await addVersion({ price: 890000 });
    await prisma.propertyNarrationDelivery.create({
      data: { propertyId, versionId: v.id, mode: "TELEGRAM", status: "SENT", requestKey: `storynp-del-${runId}-${v.revision}`, createdById: "test" },
    });
    expect(await stories.priceDropVoiceCheck(propertyId)).toBe("STALE");
    await runJob(dropPayload());
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
  });

  it("есть озвучка новее звучащей и ещё не утверждена — задание ждёт; на последней попытке выходит фото", async () => {
    const v = await addVersion({ price: 890000 });
    await prisma.property.update({ where: { id: propertyId }, data: { videoMasterNarrationVersionId: v.id } });
    await addVersion({ approved: false, status: "READY" });
    expect(await stories.priceDropVoiceCheck(propertyId)).toBe("WAIT_NEWER");

    await expect(runJob(dropPayload(), 1)).rejects.toThrow(/озвучка/);
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();

    await runJob(dropPayload(), stories.PRICE_DROP_STORY_MAX_ATTEMPTS);
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
  });

  it("старый ролик с ценой, набранной в кадр, — «цена снижена» только фото", async () => {
    await resetProperty({ videoHandoffLastFactsText: "Объект №1\nЭтаж: 3\nЦена: 890 000 с." });
    await runJob(dropPayload());
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
  });
});

describe("«продано» роликом", () => {
  const soldPayload = () => ({ propertyId, kind: "SOLD", priceWasText: null, priceWasTjs: null, queuedAt: Date.now(), force: true });

  it("цена в кадре «продано» не мешает — выходит ролик", async () => {
    await resetProperty({ status: "SOLD", videoHandoffLastFactsText: "Объект №1\nЦена: 890 000 с." });
    await runJob(soldPayload());
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
  });

  it("продажу отменили, пока задание ждало (статус уже не SOLD) — ничего не публикуем", async () => {
    await resetProperty({ status: "AVAILABLE" });
    await runJob(soldPayload());
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
  });

  it("повтор задания после успеха — второй истории нет", async () => {
    await resetProperty({ status: "SOLD" });
    const payload = soldPayload();
    await runJob(payload);
    await runJob(payload);
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(await prisma.propertyStoryPost.count({ where: { propertyId, kind: "SOLD", channel: "INSTAGRAM" } })).toBe(1);
  });
});

describe("откаты на фото и «одна история вместо двух»", () => {
  it("Meta оставила контейнер ждать (pending) — фото не выкладываем, файл ролика не удаляем, повтора нет", async () => {
    publishInstagramStory.mockResolvedValue({ channel: "INSTAGRAM", ok: false, pending: true, error: "ещё обрабатывается" });
    await runJob(dropPayload()); // pending — задание завершается без ошибки (повтора не будет)
    expect(publishInstagramStoryImage).not.toHaveBeenCalled();
    const removed = unlink.mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.endsWith(".mp4"))).toBe(false);
  });

  it("Meta отказала, ничего не создав, — откат на фото-карточку", async () => {
    publishInstagramStory.mockResolvedValue({ channel: "INSTAGRAM", ok: false, error: "Media type is invalid" });
    await runJob(dropPayload());
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
    // Удачный ролик/фото удаляет временный файл ролика (не pending).
    expect(unlink.mock.calls.some((c) => String(c[0]).endsWith(".mp4"))).toBe(true);
  });

  it("ffmpeg не справился — причина в журнале ошибок, выходит фото", async () => {
    overlayCardOnVideo.mockResolvedValue({ ok: false, reason: "код 1; Invalid data found when processing input" });
    await runJob(dropPayload());
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith("meta", expect.stringContaining("Invalid data found when processing input"));
  });

  it("рубильник «готовым роликом» выключен — фото-карточка, ffmpeg не зовём", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { instagramStoryVideoEnabled: false } });
    await runJob(dropPayload());
    expect(overlayCardOnVideo).not.toHaveBeenCalled();
    expect(publishInstagramStory).not.toHaveBeenCalled();
    expect(publishInstagramStoryImage).toHaveBeenCalledTimes(1);
  });

  it("после «цена снижена» автоистория самого ролика в те же два часа не выходит", async () => {
    await runJob(dropPayload());
    expect(publishInstagramStory).toHaveBeenCalledTimes(1);
    publishInstagramStory.mockClear();
    const summary = await stories.publishPropertyInstagramStories(propertyId, `/uploads/handoff/${propertyId}-1764000000000.mp4`);
    expect(summary.attempted).toBe(false);
    expect(publishInstagramStory).not.toHaveBeenCalled();
  });
});
