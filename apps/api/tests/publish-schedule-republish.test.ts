import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * «МАРКЕТИНГ → РАСПИСАНИЕ» И НОВЫЙ РОЛИК ВЫШЕДШЕГО ОБЪЕКТА (24.09.2026, случай
 * ОБ-000132). Готовый ролик на замену встаёт в час расстановки, но очередь
 * брала только объекты без публикаций — и его не показывала. Теперь вышедший
 * объект в очереди, пока его новое задание ждёт или идёт и слот впереди; уже
 * отработавшее задание и прошлый выход в очередь не попадают.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { videoHandoffPublishDedupeKey, VIDEO_HANDOFF_PUBLISH_JOB_TYPE, VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS } = await import(
  "../src/lib/videoHandoff.js"
);

const runId = Date.now();
const password = "testpass123";
const phone = `+992978${runId}`;
const HOUR = 60 * 60 * 1000;

let districtId: string;
let marketingToken: string;
const propertyIds: string[] = [];

async function receivedProperty(
  title: string,
  opts: { slotInHours: number; publishedChannels?: string[]; jobStatus?: "PENDING" | "RUNNING" | "DONE" }
) {
  const slot = new Date(Date.now() + opts.slotInHours * HOUR);
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      videoHandoffStatus: "RECEIVED",
      videoHandoffFinalPath: "/uploads/handoff/republish.mp4",
      videoHandoffReceivedAt: new Date(),
      scheduledPublishAt: slot,
      publishedChannels: opts.publishedChannels ?? [],
    },
  });
  propertyIds.push(p.id);
  await prisma.backgroundJob.create({
    data: {
      type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
      payload: { propertyId: p.id },
      dedupeKey: videoHandoffPublishDedupeKey(p.id),
      maxAttempts: VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS,
      runAt: slot,
      status: opts.jobStatus ?? "PENDING",
    },
  });
  return p;
}

type Row = { propertyId: string; jobState: string; channels: string[] };

async function upcoming(): Promise<Row[]> {
  const res = await request(app).get("/api/v1/marketing/publish-schedule").set("Authorization", `Bearer ${marketingToken}`);
  expect(res.status).toBe(200);
  return res.body.upcoming as Row[];
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-republish-${runId}` } })).id;
  await prisma.agent.create({ data: { fullName: "Маркетолог republish", phone, role: "MARKETING", passwordHash } });
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  marketingToken = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("GET /marketing/publish-schedule — новый ролик вышедшего объекта", () => {
  it("вышедший объект с новым роликом, ждущим своего часа, — в очереди, площадки без уже занятых", async () => {
    const p = await receivedProperty("Замена ролика", { slotInHours: 1, publishedChannels: ["TELEGRAM"] });

    const row = (await upcoming()).find((r) => r.propertyId === p.id);

    expect(row).toBeDefined();
    expect(row!.jobState).toBe("waiting");
    // Где старый ролик стоит, публикация пропускает — туда новый не уедет.
    expect(row!.channels).not.toContain("TELEGRAM");
  });

  it("новый ролик вышедшего объекта уже уходит — в очереди как «публикуется»", async () => {
    const p = await receivedProperty("Замена уходит", { slotInHours: 1, publishedChannels: ["TELEGRAM"], jobStatus: "RUNNING" });
    expect((await upcoming()).find((r) => r.propertyId === p.id)?.jobState).toBe("publishing");
  });

  it("задание уже отработало («Опубликовать сейчас» до слота) — не в очереди и не «застряло»", async () => {
    const p = await receivedProperty("Замена вышла раньше", { slotInHours: 1, publishedChannels: ["TELEGRAM"], jobStatus: "DONE" });
    expect((await upcoming()).some((r) => r.propertyId === p.id)).toBe(false);
  });

  it("слот вышедшего объекта в прошлом — это прошлый выход, а не очередь", async () => {
    const p = await receivedProperty("Давно вышел", { slotInHours: -3, publishedChannels: ["TELEGRAM"], jobStatus: "DONE" });
    expect((await upcoming()).some((r) => r.propertyId === p.id)).toBe(false);
  });

  it("объект без публикаций — как раньше: и ждущий, и просроченный в очереди", async () => {
    const fresh = await receivedProperty("Первый выход", { slotInHours: 1 });
    const late = await receivedProperty("Первый выход опоздал", { slotInHours: -2, jobStatus: "DONE" });
    const rows = await upcoming();
    expect(rows.find((r) => r.propertyId === fresh.id)?.jobState).toBe("waiting");
    expect(rows.find((r) => r.propertyId === late.id)?.jobState).toBe("stuck");
  });
});
