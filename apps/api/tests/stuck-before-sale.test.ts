import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_PROPERTY_PHOTOS, type PermissionId } from "@royal-home/shared";

/**
 * «ЗАСТРЯЛИ ДО ПРОДАЖИ» (17.11.2026, волна 2 Шабнам): одна функция lib/stuckBeforeSale.ts для
 * get_stuck_work и экрана. По каждому виду застревания — своя причина словами и следующий шаг:
 * на проверке, ждёт фото, ждёт видео, у монтажёра, ролик получен и не принят, ролик принят и вышел
 * в сети без Instagram (директор может вывести без него). Свежий объект (меньше трёх суток) и
 * удалённый в список не попадают.
 *
 * Выводы — только по своим объектам (`ownerAgentId` своего агента): тесты идут в два процесса на
 * одной базе, и чужие объекты сдвигают «всю компанию».
 */

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { listStuckBeforeSale, dushanbeDaysBetween, shortDushanbeDate, STUCK_BEFORE_SALE_MIN_DAYS } = await import("../src/lib/stuckBeforeSale.js");
const { getStuckWorkTool } = await import("../src/ai/assistant/tools/brainReadTools.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now();
const DAY = 86_400_000;
let districtId = "";
let ownerId = "";
let directorId = "";
const ownerName = `Агент застряли ${runId}`;
const propertyIds: string[] = [];
const ids: Record<string, string> = {};

async function seed(key: string, overrides: Record<string, unknown>, photos = MIN_PROPERTY_PHOTOS) {
  const property = await prisma.property.create({
    data: {
      title: `Застрял ${key} ${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      price: 400000,
      currency: "TJS",
      districtId,
      address: `Застрял ${key} ${runId}`,
      condition: "GOOD",
      createdById: ownerId,
      assignedAgentId: ownerId,
      intakeAgentId: ownerId,
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  ids[key] = property.id;
  if (photos > 0) {
    await prisma.propertyPhoto.createMany({
      data: Array.from({ length: photos }, (_, i) => ({
        propertyId: property.id,
        url: `/uploads/stk${i}.webp`,
        thumbUrl: `/uploads/thumbs/stk${i}.webp`,
        order: i,
      })),
    });
  }
}

const ago = (days: number, extraHours = 1) => new Date(Date.now() - days * DAY - extraHours * 3_600_000);

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Застряли район ${runId}` } })).id;
  ownerId = await createTestAgent(ownerName);
  directorId = await createTestAgent(`Директор застряли ${runId}`, "DIRECTOR");

  await seed("review", { status: "PENDING_REVIEW", stageEnteredAt: ago(66) });
  await seed("photos", { status: "AWAITING_PHOTOS", stageEnteredAt: ago(5) }, 0);
  await seed("video", { status: "AWAITING_VIDEO", stageEnteredAt: ago(4) });
  await seed("editor", {
    status: "EDITING",
    stageEnteredAt: ago(9),
    videoHandoffStatus: "SENT_TO_EDITOR",
    videoHandoffSentAt: ago(6),
    videoHandoffDeliveredAt: ago(5),
  });
  await seed("clipPending", {
    status: "EDITING",
    stageEnteredAt: ago(8),
    videoHandoffStatus: "RECEIVED",
    videoHandoffReceivedAt: ago(4),
    videoHandoffFinalPath: "/private/stk-pending.mp4",
    clipReviewStatus: "PENDING",
    clipReviewRequestedAt: ago(4),
  });
  // Как ОБ-000193: ролик принят, вышел в YouTube и Facebook, ссылки на Instagram нет.
  await seed("noInstagram", {
    status: "EDITING",
    stageEnteredAt: ago(11),
    instagramUrl: null,
    videoHandoffStatus: "RECEIVED",
    videoHandoffReceivedAt: ago(11),
    videoHandoffFinalPath: "/private/stk-noig.mp4",
    clipReviewStatus: "APPROVED",
    publishedChannels: ["YOUTUBE", "FACEBOOK"],
  });
  await seed("fresh", { status: "AWAITING_VIDEO", stageEnteredAt: new Date() });
  await seed("trashed", { status: "PENDING_REVIEW", stageEnteredAt: ago(30), deletedAt: new Date() });
  await seed("selling", { status: "AVAILABLE", stageEnteredAt: ago(30) });
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([ownerId, directorId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

const mine = async () => listStuckBeforeSale({ ownerAgentId: ownerId, limit: 200 });
const itemFor = async (key: string) => (await mine()).items.find((i) => i.propertyId === ids[key]);

describe("listStuckBeforeSale: причина по каждому виду застревания", () => {
  it("свежий, удалённый и уже продающийся — не в списке; остальные — самые давние первыми", async () => {
    const result = await mine();
    const got = result.items.map((i) => i.propertyId);
    expect(got).not.toContain(ids.fresh);
    expect(got).not.toContain(ids.trashed);
    expect(got).not.toContain(ids.selling);
    expect(result.total).toBe(6);
    expect(result.minDays).toBe(STUCK_BEFORE_SALE_MIN_DAYS);
    expect(got[0]).toBe(ids.review);
  });

  it("на проверке: с какого числа, сколько дней, следующий — маркетинг", async () => {
    const item = (await itemFor("review"))!;
    expect(item.kind).toBe("ON_REVIEW");
    expect(item.reason).toMatch(/^на проверке с \d{2}\.\d{2}/);
    expect(item.days).toBeGreaterThanOrEqual(66);
    expect(item.nextBy).toBe("MARKETING");
  });

  it("ждёт фото / ждёт видео — следующий агент объекта по имени", async () => {
    const photos = (await itemFor("photos"))!;
    expect(photos).toMatchObject({ kind: "AWAITING_PHOTOS", reason: "ждёт фото", nextBy: "AGENT", nextByName: ownerName });
    expect(photos.blockers.join(" ")).toMatch(/фото меньше минимума/);
    const video = (await itemFor("video"))!;
    expect(video).toMatchObject({ kind: "AWAITING_VIDEO", reason: "ждёт видео", nextBy: "AGENT" });
  });

  it("у монтажёра N дней — следующий монтажёр", async () => {
    const item = (await itemFor("editor"))!;
    expect(item.kind).toBe("WITH_EDITOR");
    expect(item.reason).toBe("у монтажёра 5 дн.");
    expect(item.nextBy).toBe("EDITOR");
  });

  it("ролик получен, не принят — ждёт приёмки", async () => {
    const item = (await itemFor("clipPending"))!;
    expect(item.kind).toBe("CLIP_NOT_ACCEPTED");
    expect(item.reason).toMatch(/^ролик получен, не принят — ждёт приёмки/);
    expect(item.nextBy).toBe("CLIP_REVIEWER");
  });

  it("ролик принят и вышел в сети, нет Instagram — директор может вывести без него", async () => {
    const item = (await itemFor("noInstagram"))!;
    expect(item.kind).toBe("NO_INSTAGRAM_CAN_BYPASS");
    expect(item.reason).toBe("ролик принят и вышел в Facebook, YouTube; нет Instagram — директор может вывести без него");
    expect(item.nextBy).toBe("DIRECTOR");
    expect(item.withoutInstagram).toEqual({ channels: ["Facebook", "YouTube"] });
    expect(item.blockers).toEqual(["нет ссылки на видео-обзор в Instagram"]);
    expect(item.days).toBeGreaterThanOrEqual(11);
  });

  it("предел выборки соблюдается, счётчик — честный", async () => {
    const limited = await listStuckBeforeSale({ ownerAgentId: ownerId, limit: 2 });
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBe(6);
  });
});

describe("сутки и даты — по Душанбе", () => {
  it("23:30 и 00:30 по Душанбе — разные сутки, хотя прошёл час", () => {
    // 18:30 UTC = 23:30 Душанбе; 19:30 UTC = 00:30 следующих суток.
    expect(dushanbeDaysBetween(new Date("2026-11-10T18:30:00Z"), new Date("2026-11-10T19:30:00Z"))).toBe(1);
    expect(dushanbeDaysBetween(new Date("2026-11-10T05:00:00Z"), new Date("2026-11-10T18:00:00Z"))).toBe(0);
  });
  it("дата без года в текущем году, с годом — в прошлом", () => {
    const now = new Date("2026-11-17T08:00:00Z");
    expect(shortDushanbeDate(new Date("2026-09-12T08:00:00Z"), now)).toBe("12.09");
    // 20:00 UTC 31.12.2025 — это уже 01:00 первого января по Душанбе, текущий год.
    expect(shortDushanbeDate(new Date("2025-12-31T20:00:00Z"), now)).toBe("01.01");
    expect(shortDushanbeDate(new Date("2025-06-01T08:00:00Z"), now)).toBe("01.06.2025");
  });
});

describe("get_stuck_work: «застряли до продажи» в сводке Шабнам", () => {
  it("руководителю — блок beforeSale и строка в display; агенту — прежний отказ", async () => {
    const leader = actorFromAccess(directorId, { role: "DIRECTOR", permissions: new Set<PermissionId>(["auditLog.view"]) }, "crm-private");
    const out = (await getStuckWorkTool.run({}, { actor: leader })) as {
      beforeSale: { total: number; items: { code: string; reason: string }[]; more: number };
      display: string;
    };
    expect(out.beforeSale.total).toBeGreaterThanOrEqual(6);
    expect(out.beforeSale.items.length).toBeLessThanOrEqual(10);
    expect(out.display).toMatch(/Застряли до продажи \(дольше 3 дн\.\): \d+/);

    const agent = actorFromAccess(ownerId, { role: "AGENT", permissions: new Set<PermissionId>([]) }, "crm-private");
    expect(((await getStuckWorkTool.run({}, { actor: agent })) as { error?: string }).error).toMatch(/руководство/);
  });
});
