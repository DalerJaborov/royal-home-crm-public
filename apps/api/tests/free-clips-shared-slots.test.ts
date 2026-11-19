import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SOCIAL_VIDEO_CHANNELS, SOCIAL_VIDEO_LIMITS, type SocialVideoChannelInfo } from "@royal-home/shared";

vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost: vi.fn(),
}));
vi.mock("../src/lib/socialVideoChannels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialVideoChannels.js")>()),
  loadChannelInfos: vi.fn(),
  loadChannelLive: vi.fn(),
  // Токен Instagram берётся из настроек — у стенда его нет, детерминированная подмена.
  resolveInstagramTarget: vi.fn(async (accountId: string | null) => ({ key: accountId ? `INSTAGRAM:${accountId}` : "INSTAGRAM", token: "tok-default", label: "основной" })),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
}));

import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import { publishApprovedPost, type PublishResult } from "../src/lib/socialPublish.js";
import { loadChannelInfos, loadChannelLive } from "../src/lib/socialVideoChannels.js";
import {
  SOCIAL_VIDEO_PUBLISH_JOB_TYPE,
  SocialVideoError,
  publishSocialVideo,
  runSocialVideoPublish,
  runSocialVideoScheduleTick,
} from "../src/lib/socialVideoPosts.js";
import {
  PUBLISH_SLOT_LOCK_ID,
  findSlotCollision,
  loadOccupiedPublishSlots,
  loadOccupiedPublishSlotsDetailed,
} from "../src/lib/publishSlots.js";
import { DEFAULT_PUBLISH_SCHEDULE_RULES, nextNarrationSlot, nextPublishSlot } from "../src/lib/publishSchedule.js";
import { PROCESS_IDENTITY, isClaimAbandoned } from "../src/lib/socialVideoPosts.js";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PUBLISH_SLOT_LOCK_ID as lockFromHandoff } from "../src/lib/videoHandoff.js";

/**
 * СВОБОДНЫЕ РОЛИКИ НА ОБЩЕЙ ШКАЛЕ ПУБЛИКАЦИЙ (19.11.2026).
 *  — время свободного ролика считается занятым для автоматических слотов (ролик объекта, озвучка, фото-пост, повтор,
 *    подборка): они держат от него промежуток;
 *  — время, выбранное человеком, молча не двигается; занято — 409 `SLOT_TAKEN` с ближайшим свободным, настоять можно;
 *  — проверка и запись времени идут под общим замком: два одновременных запроса не берут одну минуту;
 *  — исполнитель публикации берётся в базе: второй процесс/повтор задания второй раз не публикует.
 * Сети нет: публикатор и список каналов подменены.
 */

const runId = Date.now();
const mockedPublish = vi.mocked(publishApprovedPost);
const mockedInfos = vi.mocked(loadChannelInfos);
const mockedLive = vi.mocked(loadChannelLive);

const READY: SocialVideoChannelInfo[] = SOCIAL_VIDEO_CHANNELS.map((channel) => ({
  channel,
  label: channel,
  connected: true,
  ready: true,
  problem: null,
  limits: SOCIAL_VIDEO_LIMITS[channel],
  accounts: [{ id: null, label: channel, username: null, isDefault: true, ready: true, problem: null }],
}));

const GAP_MS = DEFAULT_PUBLISH_SCHEDULE_RULES.minGapMin * 60_000;
const videoIds: string[] = [];
const propertyIds: string[] = [];
let districtId = "";
let agentId = "";

/** Уникальные сутки далеко вперёд, 14:00 по Душанбе (09:00 UTC): чужие тесты в эти сутки ничего не ставят. */
function farDay(offsetDays: number): Date {
  const base = new Date();
  base.setUTCHours(9, 0, 0, 0);
  return new Date(base.getTime() + (120 + offsetDays) * 86_400_000);
}
let dayCounter = Number(String(runId).slice(-3)) % 200;
const nextDay = () => farDay(dayCounter++ % 230);

async function makeRow(data: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const videoPath = `/uploads/handoff/promo-${id}.mp4`;
  const disk = path.join(uploadsDir, "handoff", `promo-${id}.mp4`);
  await fs.promises.mkdir(path.dirname(disk), { recursive: true });
  await fs.promises.writeFile(disk, "stub");
  const row = await prisma.socialVideoPost.create({
    data: {
      id,
      title: `Слоты-ролик ${runId}`,
      caption: "Тестовая подпись",
      videoPath,
      originalName: "t.mp4",
      sizeBytes: 4,
      durationSec: 30,
      width: 1080,
      height: 1920,
      hasAudio: true,
      videoCodec: "h264",
      channels: ["INSTAGRAM"],
      ...data,
    },
  });
  videoIds.push(row.id);
  return row;
}

async function schedule(id: string, at: Date, extra: { acceptSlotConflict?: boolean } = {}) {
  return publishSocialVideo(id, { mode: "SCHEDULE", scheduledAt: at.toISOString(), channels: ["INSTAGRAM"], ...extra });
}

async function rejection(promise: Promise<unknown>): Promise<SocialVideoError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SocialVideoError);
    return err as SocialVideoError;
  }
  throw new Error("ожидали отказ, а ролик запланировался");
}

function planInstagramOk() {
  mockedPublish.mockImplementation(async (params) => {
    const out: PublishResult[] = [];
    if (!params.skipChannels?.includes("INSTAGRAM")) {
      await params.onChannelStarted?.("INSTAGRAM", "INSTAGRAM");
      const result: PublishResult = { channel: "INSTAGRAM", ok: true, postId: "ig-post" };
      out.push(result);
      await params.onChannelPublished?.(result);
    }
    return out;
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Слоты ${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: `Агент слотов ${runId}`, phone: `+992937${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" } })).id;
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: { id: true } });
});

beforeEach(() => {
  mockedPublish.mockReset();
  mockedInfos.mockReset();
  mockedLive.mockReset();
  mockedInfos.mockResolvedValue(READY);
  mockedLive.mockResolvedValue([]);
});

afterAll(async () => {
  const rows = await prisma.socialVideoPost.findMany({ where: { id: { in: videoIds } }, select: { videoPath: true } });
  for (const row of rows) await fs.promises.rm(path.join(uploadsDir, row.videoPath.slice("/uploads/".length)), { force: true });
  await prisma.socialVideoPost.deleteMany({ where: { id: { in: videoIds } } });
  await prisma.backgroundJob.deleteMany({ where: { type: SOCIAL_VIDEO_PUBLISH_JOB_TYPE } }).catch(() => {});
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("замок шкалы: одно место", () => {
  it("videoHandoff переизлучает ту же константу, что лежит в publishSlots", () => {
    expect(lockFromHandoff).toBe(PUBLISH_SLOT_LOCK_ID);
  });
});

describe("loadOccupiedPublishSlots видит свободные ролики", () => {
  it("считает только запланированные и живые; себя можно исключить", async () => {
    const at = nextDay();
    const scheduled = await makeRow({ status: "SCHEDULED", scheduledAt: at });
    await makeRow({ status: "DRAFT", scheduledAt: new Date(at.getTime() + 3 * 60_000) });
    await makeRow({ status: "DONE", scheduledAt: new Date(at.getTime() + 6 * 60_000) });
    await makeRow({ status: "SCHEDULED", scheduledAt: new Date(at.getTime() + 9 * 60_000), deletedAt: new Date() });
    const since = new Date(at.getTime() - 60_000);
    const until = at.getTime() + 60 * 60_000;
    const mine = (list: Date[]) => list.filter((d) => d.getTime() <= until).map((d) => d.getTime());

    expect(mine(await prisma.$transaction((tx) => loadOccupiedPublishSlots(tx, since)))).toEqual([at.getTime()]);
    expect(mine(await prisma.$transaction((tx) => loadOccupiedPublishSlots(tx, since, undefined, scheduled.id)))).toEqual([]);
    const detailed = await prisma.$transaction((tx) => loadOccupiedPublishSlotsDetailed(tx, since));
    expect(detailed.filter((s) => s.at.getTime() <= until)).toEqual([{ at, kind: "freeVideo" }]);
  });
});

describe("автоматические слоты держат промежуток от свободного ролика", () => {
  it("свободный ролик в 14:00: ролик объекта, новая озвучка и подборки не встают на 14:00", async () => {
    const t = nextDay();
    await makeRow({ status: "SCHEDULED", scheduledAt: t });
    // Как в schedulePublishAfterAccept: под замком читаем занятые слоты и считаем слот. «Сейчас» — за 10 минут до ролика.
    const now = new Date(t.getTime() - 10 * 60_000);
    const occupied = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLISH_SLOT_LOCK_ID}::bigint)`;
      return loadOccupiedPublishSlots(tx, new Date(now.getTime() - GAP_MS));
    });
    expect(occupied.map((d) => d.getTime())).toContain(t.getTime());

    const regular = nextPublishSlot(now, occupied, DEFAULT_PUBLISH_SCHEDULE_RULES);
    expect(Math.abs(regular.at.getTime() - t.getTime())).toBeGreaterThanOrEqual(GAP_MS);

    const narration = nextNarrationSlot(now, occupied, DEFAULT_PUBLISH_SCHEDULE_RULES, 15);
    expect(Math.abs(narration.at.getTime() - t.getTime())).toBeGreaterThanOrEqual(15 * 60_000);
  });
});

describe("findSlotCollision", () => {
  const at = new Date("2026-12-01T09:00:00Z");
  const min = (m: number) => new Date(at.getTime() + m * 60_000);

  it("свободно — null; рядом — столкновение и ближайшее свободное время после занятых", () => {
    expect(findSlotCollision(at, [], GAP_MS)).toBeNull();
    expect(findSlotCollision(at, [{ at: min(120), kind: "repost" }], GAP_MS)).toBeNull();
    const hit = findSlotCollision(at, [{ at: min(30), kind: "propertyVideo" }], GAP_MS);
    expect(hit?.kind).toBe("propertyVideo");
    expect(hit?.suggestedAt.getTime()).toBe(min(30 + 90).getTime());
  });

  it("цепочка занятых: подсказка уходит за последний, а не в середину цепочки", () => {
    const hit = findSlotCollision(
      at,
      [
        { at: min(0), kind: "photoPost" },
        { at: min(80), kind: "digest" },
        { at: min(160), kind: "freeVideo" },
      ],
      GAP_MS
    );
    expect(hit?.suggestedAt.getTime()).toBe(min(160 + 90).getTime());
  });
});

describe("подсказка не уходит в ночь", () => {
  const w = { startMin: 9 * 60, endMin: 21 * 60 };
  it("занято вечером до закрытия окна — подсказка на открытие следующего дня (09:00 по Душанбе)", () => {
    const at = new Date("2026-12-01T15:00:00Z"); // 20:00 Душанбе
    const hit = findSlotCollision(at, [{ at, kind: "propertyVideo" }], GAP_MS, w);
    expect(hit?.suggestedAt.toISOString()).toBe("2026-12-02T04:00:00.000Z");
  });
  it("без окна поведение прежнее", () => {
    const at = new Date("2026-12-01T15:00:00Z");
    expect(findSlotCollision(at, [{ at, kind: "propertyVideo" }], GAP_MS)?.suggestedAt.getTime()).toBe(at.getTime() + GAP_MS);
  });
});

describe("выбранное человеком время: не двигаем, предупреждаем, настоять можно", () => {
  it("занятое другой публикацией — отказ SLOT_TAKEN с ближайшим свободным; свободное и «настоять» — ставятся как есть", async () => {
    const t = nextDay();
    const first = await makeRow();
    await schedule(first.id, t);

    const second = await makeRow();
    const clash = new Date(t.getTime() + 30 * 60_000);
    const err = await rejection(schedule(second.id, clash));
    expect(err.status).toBe(409);
    expect(err.extra).toMatchObject({ code: "SLOT_TAKEN", takenKind: "freeVideo", suggestedAt: new Date(t.getTime() + GAP_MS).toISOString(), minGapMin: 90 });
    expect(err.message).toMatch(/уже выходит другой ролик из «Роликов в соцсети», ближайшее свободное время — 15:30/);
    const untouched = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: second.id } });
    expect(untouched).toMatchObject({ status: "DRAFT", scheduledAt: null });

    // Настоял — время его, ровно то, что выбрал.
    const forced = await schedule(second.id, clash, { acceptSlotConflict: true });
    expect(forced.scheduledAt).toBe(clash.toISOString());

    // Подсказанное время свободно только если не мешает и «настоявшему»: подсказка идёт за ним.
    const third = await makeRow();
    const err3 = await rejection(schedule(third.id, t));
    expect((err3.extra as { suggestedAt: string }).suggestedAt).toBe(new Date(clash.getTime() + GAP_MS).toISOString());
    const free = new Date(clash.getTime() + GAP_MS);
    expect((await schedule(third.id, free)).scheduledAt).toBe(free.toISOString());
  });

  it("столкновение с роликом объекта называет его по-человечески", async () => {
    const t = nextDay();
    const property = await prisma.property.create({
      data: {
        title: `Слоты ${runId}`,
        type: "APARTMENT",
        rooms: 2,
        areaSqm: 58,
        floor: 5,
        price: 450000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: agentId,
        scheduledPublishAt: t,
      } as never,
    });
    propertyIds.push(property.id);
    const row = await makeRow();
    const err = await rejection(schedule(row.id, new Date(t.getTime() + 20 * 60_000)));
    expect(err.message).toMatch(/уже выходит ролик объекта/);
    expect(err.extra).toMatchObject({ takenKind: "propertyVideo" });
  });

  it("два запроса в одну минуту одновременно: один встаёт, второй получает отказ (замок шкалы)", async () => {
    const t = nextDay();
    const a = await makeRow();
    const b = await makeRow();
    const results = await Promise.allSettled([schedule(a.id, t), schedule(b.id, t)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as SocialVideoError).extra).toMatchObject({ code: "SLOT_TAKEN" });
  });

  it("перепланирование самого себя не мешает самому себе", async () => {
    const t = nextDay();
    const row = await makeRow();
    await schedule(row.id, t);
    await prisma.socialVideoPost.update({ where: { id: row.id }, data: { status: "DRAFT" } });
    expect((await schedule(row.id, new Date(t.getTime() + 5 * 60_000))).status).toBe("SCHEDULED");
  });
});

describe("один ролик — одна публикация: тик и исполнитель", () => {
  it("два тика одновременно запускают ролик один раз", async () => {
    const now = new Date();
    const row = await makeRow({ status: "SCHEDULED", scheduledAt: new Date(now.getTime() - 60_000) });
    const ticks = await Promise.all([runSocialVideoScheduleTick(now), runSocialVideoScheduleTick(now)]);
    // Чужие просроченные ролики в общей базе тоже могут запуститься — важно только про нашу строку.
    expect(ticks.length).toBe(2);
    const after = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("PUBLISHING");
    const jobs = await prisma.backgroundJob.count({ where: { type: SOCIAL_VIDEO_PUBLISH_JOB_TYPE, payload: { path: ["id"], equals: row.id } } });
    expect(jobs).toBe(1);
  });

  it("исполнитель уже занят (другой процесс держит бронь) — второй не публикует", async () => {
    planInstagramOk();
    const row = await makeRow({
      status: "PUBLISHING",
      startedAt: new Date(),
      runClaimedAt: new Date(),
      runClaimedBy: `${os.hostname()}:${process.pid}:1`,
      channelResults: { INSTAGRAM: { state: "QUEUED", error: null, note: null, postId: null, url: null, retriable: false, attempts: 0, startedAt: null, finishedAt: null } },
    });
    await runSocialVideoPublish(row.id);
    expect(mockedPublish).not.toHaveBeenCalled();
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PUBLISHING");
  });

  it("бронь умершего процесса (перезапуск посреди публикации) не мешает: повтор задания доделывает адреса", async () => {
    planInstagramOk();
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid ?? 0;
    expect(dead).toBeGreaterThan(0);
    const row = await makeRow({
      status: "PUBLISHING",
      startedAt: new Date(),
      runClaimedAt: new Date(),
      runClaimedBy: `${os.hostname()}:${dead}:1`,
      channelResults: { INSTAGRAM: { state: "QUEUED", error: null, note: null, postId: null, url: null, retriable: false, attempts: 0, startedAt: null, finishedAt: null } },
    });
    await runSocialVideoPublish(row.id);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DONE");
  });

  it("бронь этого же живого процесса и другого живого процесса — пропускают; чужого хоста — только после срока", () => {
    const now = Date.now();
    const fresh = new Date(now - 60_000);
    expect(isClaimAbandoned(PROCESS_IDENTITY, new Date(now - 3 * 60 * 60_000))).toBe(false);
    expect(isClaimAbandoned(`${os.hostname()}:${process.pid}:1`, fresh)).toBe(false);
    expect(isClaimAbandoned("other-host:123:1", fresh)).toBe(false);
    expect(isClaimAbandoned("other-host:123:1", new Date(now - 60 * 60_000))).toBe(true);
  });

  it("свободный исполнитель берёт бронь и публикует ровно один раз, повтор задания после этого ничего не делает", async () => {
    planInstagramOk();
    const row = await makeRow({
      status: "PUBLISHING",
      startedAt: new Date(),
      channelResults: { INSTAGRAM: { state: "QUEUED", error: null, note: null, postId: null, url: null, retriable: false, attempts: 0, startedAt: null, finishedAt: null } },
    });
    await Promise.all([runSocialVideoPublish(row.id), runSocialVideoPublish(row.id)]);
    await runSocialVideoPublish(row.id);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    const done = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe("DONE");
    expect(done.runClaimedAt).not.toBeNull();
  });

  it("брошенная бронь (старше 45 минут — процесс умер) не мешает новому исполнителю", async () => {
    planInstagramOk();
    const row = await makeRow({
      status: "PUBLISHING",
      startedAt: new Date(),
      runClaimedAt: new Date(Date.now() - 2 * 60 * 60_000),
      channelResults: { INSTAGRAM: { state: "QUEUED", error: null, note: null, postId: null, url: null, retriable: false, attempts: 0, startedAt: null, finishedAt: null } },
    });
    await runSocialVideoPublish(row.id);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });
});
