import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * СПРАВОЧНИК ОРИЕНТИРОВ: слои и чистка (28.11.2026). Экран Настроек показывает по умолчанию только то, что завели
 * сотрудники («own»), купленный слой («import») — отдельно; чистка мусора и дублей доступна только руководителю и
 * только скрывает. Тест НЕ запускает саму чистку на общей базе (она скрыла бы чужие тестовые записи) — её правила
 * проверяет landmark-cleanup.test.ts без базы.
 */
const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const tail = String(runId).slice(-6);
const password = "testpass123";
const sourcePrefix = `test-landmark-layers-${runId}`;
let agentId = "";
let adminId = "";
let agentToken = "";
let adminToken = "";
const ownName = `Народный-${runId}`;
const boughtName = `Купленный-${runId}`;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({ data: { fullName: `Слои ${runId}`, phone: `+992371${tail}`, role: "AGENT", passwordHash } });
  const admin = await prisma.agent.create({ data: { fullName: `Слои админ ${runId}`, phone: `+992372${tail}`, role: "ADMIN", passwordHash } });
  agentId = agent.id;
  adminId = admin.id;
  agentToken = await login(`+992371${tail}`);
  adminToken = await login(`+992372${tail}`);
  await prisma.landmark.create({ data: { name: ownName, category: "ТЦ", lat: 38.7101, lng: 68.6101, source: "agent" } });
  await prisma.landmark.create({ data: { sourceId: `${sourcePrefix}-b`, name: boughtName, category: "ТЦ", lat: 38.7102, lng: 68.6102, source: "import" } });
});

afterAll(async () => {
  await prisma.landmark.deleteMany({ where: { OR: [{ sourceId: { startsWith: sourcePrefix } }, { name: ownName }] } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, adminId].filter(Boolean) } } });
});

describe("слои справочника ориентиров", () => {
  it("layer=own — только заведённое сотрудниками", async () => {
    const res = await request(app).get("/api/v1/landmarks?layer=own&pageSize=100&q=-" + runId).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const names = (res.body.items as { name: string; source: string }[]).map((i) => i.name);
    expect(names).toContain(ownName);
    expect(names).not.toContain(boughtName);
    expect((res.body.items as { source: string }[]).every((i) => i.source === "agent")).toBe(true);
  });

  it("layer=import — только купленный слой; без layer — оба (мастер объекта не ломается)", async () => {
    const imp = await request(app).get("/api/v1/landmarks?layer=import&pageSize=100&q=-" + runId).set("Authorization", `Bearer ${agentToken}`);
    expect((imp.body.items as { name: string }[]).map((i) => i.name)).toEqual([boughtName]);
    const all = await request(app).get("/api/v1/landmarks?pageSize=100&q=-" + runId).set("Authorization", `Bearer ${agentToken}`);
    expect((all.body.items as { name: string }[]).map((i) => i.name).sort()).toEqual([boughtName, ownName].sort());
  });

  it("синоним от импорта не защищает запись от чистки: мусор с import-синонимом считается, с синонимом сотрудника — нет", async () => {
    const before = (await request(app).get("/api/v1/landmarks/summary").set("Authorization", `Bearer ${agentToken}`)).body.junk as number;
    const junk = await prisma.landmark.create({ data: { sourceId: `${sourcePrefix}-j1`, name: "Ы", category: "Прочее", lat: 38.7103, lng: 68.6103, source: "import" } });
    const kept = await prisma.landmark.create({ data: { sourceId: `${sourcePrefix}-j2`, name: "Э", category: "Прочее", lat: 38.7104, lng: 68.6104, source: "import" } });
    await prisma.geoAlias.create({ data: { text: "Ы", normalized: "ы", targetType: "landmark", targetId: junk.id, source: "import" } });
    await prisma.geoAlias.create({ data: { text: "Э-народное", normalized: "э народное", targetType: "landmark", targetId: kept.id, source: "agent" } });
    const after = (await request(app).get("/api/v1/landmarks/summary").set("Authorization", `Bearer ${agentToken}`)).body.junk as number;
    expect(after - before).toBe(1);
    await prisma.geoAlias.deleteMany({ where: { targetId: { in: [junk.id, kept.id] } } });
  });

  it("неверный layer — 400", async () => {
    const res = await request(app).get("/api/v1/landmarks?layer=zzz").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(400);
  });

  it("summary отдаёт счётчики любому сотруднику", async () => {
    const res = await request(app).get("/api/v1/landmarks/summary").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    for (const k of ["own", "importTotal", "importHidden", "junk", "duplicateGroups", "duplicateExtra"]) {
      expect(typeof res.body[k]).toBe("number");
    }
    expect(res.body.own).toBeGreaterThanOrEqual(1);
  });

  it("чистка: агенту нельзя (403), руководителю с неверным режимом — 400", async () => {
    const denied = await request(app).post("/api/v1/landmarks/cleanup").set("Authorization", `Bearer ${agentToken}`).send({ mode: "junk" });
    expect(denied.status).toBe(403);
    const bad = await request(app).post("/api/v1/landmarks/cleanup").set("Authorization", `Bearer ${adminToken}`).send({ mode: "delete-all" });
    expect(bad.status).toBe(400);
  });
});
