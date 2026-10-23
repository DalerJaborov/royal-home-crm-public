import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * GET /properties/clip-review/pending — очередь «ролики ждут проверки» для пульта (23.10.2026).
 * Признак — CLIP_REVIEW_PENDING_WHERE (тот же, по которому approveClip берёт ролик в работу):
 * RECEIVED + PENDING, без удалённых; давние первыми; право properties.moderate.
 */
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const propertyIds: string[] = [];
const agentIds: string[] = [];
let adminToken = "";
let plainToken = "";

async function makeAgent(suffix: string, role: "ADMIN" | "AGENT") {
  const phone = `+99297${runId}${suffix}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const a = await prisma.agent.create({ data: { fullName: `Очередь роликов ${suffix}`, phone, role, passwordHash: await bcrypt.hash(password, 4) } });
  agentIds.push(a.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(label: string, data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Очередь роликов ${label} ${runId}`, type: "APARTMENT", areaSqm: 50, rooms: 2, price: 100000, currency: "TJS",
      address: "Тестовая, 1", condition: "GOOD", status: "EDITING", ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  adminToken = await makeAgent("1", "ADMIN");
  plainToken = await makeAgent("2", "AGENT");
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
});

describe("GET /properties/clip-review/pending", () => {
  it("отдаёт только ролики на проверке, давние первыми, с путём к файлу и обложкой", async () => {
    const newer = await makeProperty("новее", {
      videoHandoffStatus: "RECEIVED", clipReviewStatus: "PENDING", videoHandoffFinalPath: "/uploads/handoff/new.mp4",
      clipReviewRequestedAt: new Date("2026-10-23T09:00:00Z"),
    });
    const older = await makeProperty("старее", {
      videoHandoffStatus: "RECEIVED", clipReviewStatus: "PENDING", videoHandoffFinalPath: "/uploads/handoff/old.mp4",
      clipReviewRequestedAt: new Date("2026-10-22T09:00:00Z"),
    });
    await prisma.propertyPhoto.create({ data: { propertyId: older.id, url: "/uploads/p/o.jpg", thumbUrl: "/uploads/p/o-t.jpg", order: 0 } });
    const approved = await makeProperty("решён", { videoHandoffStatus: "RECEIVED", clipReviewStatus: "APPROVED" });
    const wrongStage = await makeProperty("у монтажёра", { videoHandoffStatus: "SENT_TO_EDITOR", clipReviewStatus: "PENDING" });
    const deleted = await makeProperty("удалён", { videoHandoffStatus: "RECEIVED", clipReviewStatus: "PENDING", deletedAt: new Date() });

    const res = await request(app).get("/api/v1/properties/clip-review/pending").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
    for (const bad of [approved.id, wrongStage.id, deleted.id]) expect(ids).not.toContain(bad);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const row = res.body.items.find((i: { id: string }) => i.id === older.id);
    expect(row).toMatchObject({ shortId: older.shortId, requestedAt: "2026-10-22T09:00:00.000Z" });
    expect(String(row.videoUrl)).toContain("old.mp4");
    expect(String(row.coverUrl)).toContain("o-t.jpg");
  });

  it("предел 20 и проверка query через Zod", async () => {
    const bad = await request(app).get("/api/v1/properties/clip-review/pending?limit=500").set("Authorization", `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
    const one = await request(app).get("/api/v1/properties/clip-review/pending?limit=1").set("Authorization", `Bearer ${adminToken}`);
    expect(one.status).toBe(200);
    expect(one.body.items.length).toBeLessThanOrEqual(1);
  });

  it("без права properties.moderate — 403, без входа — 401", async () => {
    const plain = await request(app).get("/api/v1/properties/clip-review/pending").set("Authorization", `Bearer ${plainToken}`);
    expect(plain.status).toBe(403);
    const anon = await request(app).get("/api/v1/properties/clip-review/pending");
    expect(anon.status).toBe(401);
  });
});
