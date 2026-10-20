import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

// Настоящая отправка (она же пишет ленту с tag — по ней работает shouldAlert),
// но с возможностью посмотреть, кому и что ушло.
const sendPushToAgent = vi.fn();
vi.mock("../src/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push.js")>();
  sendPushToAgent.mockImplementation(actual.sendPushToAgent);
  return { ...actual, sendPushToAgent };
});
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinAlarmHours: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { notifyStuckMaterials, notifyOverdueMaterials, STUCK_VIDEO_AFTER_HOURS } = await import(
  "../src/lib/propertyPipeline.js"
);

/**
 * СТОРОЖ «МАТЕРИАЛОВ НЕТ» (lib/propertyPipeline.ts::notifyStuckMaterials, 07.10.2026):
 * объект, у которого не догрузилось видео, не должен висеть молча — ни при
 * включённой, ни при выключенной проверке исходников.
 */

const runId = Date.now();
const HOUR = 60 * 60 * 1000;
let districtId: string;
let intakeId: string;
let originalRawReview: boolean | null = null;
const propertyIds: string[] = [];

async function makeProperty(
  status: "PENDING_REVIEW" | "AWAITING_PHOTOS" | "AWAITING_VIDEO",
  hoursAgo: number,
  opts: { withVideo?: boolean; noPeople?: boolean } = {}
) {
  const p = await prisma.property.create({
    data: {
      title: `Объект без материалов ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 7",
      condition: "GOOD",
      status,
      intakeAgentId: opts.noPeople ? null : intakeId,
      ...(opts.withVideo
        ? { videos: { create: { storageKey: `key-${runId}-${propertyIds.length}`, filename: "v.mp4", sizeBytes: 1, uploadedById: intakeId } } }
        : {}),
    },
  });
  await prisma.property.update({ where: { id: p.id }, data: { stageEnteredAt: new Date(Date.now() - hoursAgo * HOUR) } });
  propertyIds.push(p.id);
  return p;
}

const pushesFor = (tag: string) =>
  sendPushToAgent.mock.calls.filter(([, payload]) => (payload as { tag?: string }).tag === tag);
const alertRows = (tag: string) => prisma.pendingDirectorAlert.findMany({ where: { tag } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-сторож-${runId}` } })).id;
  intakeId = (
    await prisma.agent.create({
      data: { fullName: "Принявший агент", phone: `+992943${String(runId).slice(-9)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  originalRawReview = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { rawReviewRequired: true } }))
    ?.rawReviewRequired ?? null;
  // Проверка исходников ВЫКЛЮЧЕНА — именно тот режим, где объект раньше висел невидимо.
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { rawReviewRequired: false },
    create: { id: "singleton", rawReviewRequired: false },
  });
});

beforeEach(() => {
  sendPushToAgent.mockClear();
});

afterAll(async () => {
  const tags = propertyIds.flatMap((id) => [
    `video-missing-${id}`,
    `video-missing-lead-${id}`,
    `video-missing-escalate-${id}`,
    `materials-missing-${id}`,
    `pending-review-overdue-${id}`,
  ]);
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: tags } } });
  await prisma.notification.deleteMany({ where: { tag: { in: tags } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: intakeId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  if (originalRawReview !== null) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { rawReviewRequired: originalRawReview } });
  }
});

describe("notifyStuckMaterials: PENDING_REVIEW без видео", () => {
  it(`${STUCK_VIDEO_AFTER_HOURS + 1} ч без видео при rawReviewRequired=false — пуш принявшему агенту и один аларм руководству`, async () => {
    const p = await makeProperty("PENDING_REVIEW", STUCK_VIDEO_AFTER_HOURS + 1);
    await notifyStuckMaterials();
    const pushes = pushesFor(`video-missing-${p.id}`);
    expect(pushes).toHaveLength(1);
    expect(pushes[0][0]).toBe(intakeId);
    expect((pushes[0][1] as { title: string }).title).toContain("Видео не догружено");
    const lead = await alertRows(`video-missing-lead-${p.id}`);
    expect(lead).toHaveLength(1);
    expect(lead[0].recipientPermission).toBe("clients.assign");
    // До 72 часов директору отдельно не эскалируем.
    expect(await alertRows(`video-missing-escalate-${p.id}`)).toHaveLength(0);
  });

  it("второй прогон в те же сутки не дублирует ни пуш, ни аларм", async () => {
    const p = await makeProperty("PENDING_REVIEW", STUCK_VIDEO_AFTER_HOURS + 1);
    await notifyStuckMaterials();
    // Запись в ленте пишется фоном — по ней shouldAlert узнаёт, что сигнал уже был.
    await waitFor(() => prisma.notification.findFirst({ where: { tag: `video-missing-${p.id}` } }));
    sendPushToAgent.mockClear();
    await notifyStuckMaterials();
    expect(pushesFor(`video-missing-${p.id}`)).toHaveLength(0);
    expect(await alertRows(`video-missing-lead-${p.id}`)).toHaveLength(1);
  });

  it("через 72 часа без видео — ещё и аларм директору", async () => {
    const p = await makeProperty("PENDING_REVIEW", 80);
    await notifyStuckMaterials();
    const escalated = await alertRows(`video-missing-escalate-${p.id}`);
    expect(escalated).toHaveLength(1);
    expect(escalated[0].recipientRoles).toEqual(["DIRECTOR"]);
  });

  it("моложе порога или с видео в карточке — сторож молчит", async () => {
    const young = await makeProperty("PENDING_REVIEW", STUCK_VIDEO_AFTER_HOURS - 2);
    const withVideo = await makeProperty("PENDING_REVIEW", 30, { withVideo: true });
    await notifyStuckMaterials();
    expect(pushesFor(`video-missing-${young.id}`)).toHaveLength(0);
    expect(pushesFor(`video-missing-${withVideo.id}`)).toHaveLength(0);
    expect(await alertRows(`video-missing-lead-${young.id}`)).toHaveLength(0);
    expect(await alertRows(`video-missing-lead-${withVideo.id}`)).toHaveLength(0);
  });
});

describe("notifyStuckMaterials: AWAITING_PHOTOS / AWAITING_VIDEO без материала", () => {
  it("25 ч без фото — суточный пуш ответственному, штраф Royal Score не начисляется", async () => {
    const p = await makeProperty("AWAITING_PHOTOS", 25);
    await notifyStuckMaterials();
    const pushes = pushesFor(`materials-missing-${p.id}`);
    expect(pushes).toHaveLength(1);
    expect(pushes[0][0]).toBe(intakeId);
    expect(await prisma.royalScoreEvent.count({ where: { sourceId: p.id } })).toBe(0);
  });

  it("без ответственного вообще — аларм директору и администратору, а не тишина", async () => {
    const p = await makeProperty("AWAITING_VIDEO", 30, { noPeople: true });
    await notifyStuckMaterials();
    expect(sendPushToAgent).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: `materials-missing-${p.id}` }));
    const rows = await alertRows(`materials-missing-${p.id}`);
    expect(rows).toHaveLength(1);
    expect([...rows[0].recipientRoles].sort()).toEqual(["ADMIN", "DIRECTOR"]);
  });

  it("моложе суток — молчит", async () => {
    const p = await makeProperty("AWAITING_PHOTOS", 20);
    await notifyStuckMaterials();
    expect(pushesFor(`materials-missing-${p.id}`)).toHaveLength(0);
  });
});

describe("notifyOverdueMaterials: рубильник проверки не прячет просроченный объект", () => {
  it("rawReviewRequired=false: просроченный PENDING_REVIEW всё равно попадает руководству (clients.assign), модератору — нет", async () => {
    const p = await makeProperty("PENDING_REVIEW", 24 * 5);
    await notifyOverdueMaterials();
    const rows = await alertRows(`pending-review-overdue-${p.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientPermission).toBe("clients.assign");
    expect(rows[0].title).toContain("завис на проверке");
  });
});
