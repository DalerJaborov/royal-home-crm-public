import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { PULT_MODULES } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";
import { invalidatePultModuleCache } from "../src/lib/pultModules.js";
import { waitFor } from "./helpers/waitFor.js";

/** Модули пульта (аудит 02.09.2026 §4): выключенная секция ОТСУТСТВУЕТ в ответе
 *  агрегатора, а не приходит пустой; тумблер — только с правом на настройки и
 *  подтверждением личности. */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let managerId: string;
let managerToken: string;

const TOUCHED = ["video", "ticker", "ask"] as const;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ модулей пульта", phone: `+992937${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  adminToken = (await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password })).body.accessToken;

  const manager = await prisma.agent.create({
    data: { fullName: "Менеджер модулей пульта", phone: `+992938${runId}`, role: "MANAGER", passwordHash },
  });
  managerId = manager.id;
  managerToken = (await request(app).post("/api/v1/auth/login").send({ phone: manager.phone, password })).body
    .accessToken;

  await prisma.pultModule.deleteMany({ where: { id: { in: [...TOUCHED] } } });
  invalidatePultModuleCache();
});

afterAll(async () => {
  await prisma.pultModule.deleteMany({ where: { id: { in: [...TOUCHED] } } });
  invalidatePultModuleCache();
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [adminId, managerId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, managerId] } } });
});

describe("GET /dashboard/modules", () => {
  it("отдаёт весь реестр, по умолчанию всё включено", async () => {
    const res = await request(app).get("/api/v1/dashboard/modules").set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.modules.map((m: { id: string }) => m.id);
    expect(ids).toEqual(PULT_MODULES.map((m) => m.id));
    for (const id of TOUCHED) {
      const row = res.body.modules.find((m: { id: string }) => m.id === id);
      expect(row.enabled).toBe(true);
      expect(row.updatedBy).toBeNull();
    }
  });

  it("менеджер с dashboard.analytics читает список, но переключать не может", async () => {
    const list = await request(app).get("/api/v1/dashboard/modules").set(auth(managerToken));
    expect(list.status).toBe(200);
    const patch = await request(app)
      .patch("/api/v1/dashboard/modules/video")
      .set(auth(managerToken))
      .send({ enabled: false });
    expect(patch.status).toBe(403);
  });
});

describe("PATCH /dashboard/modules/:id", () => {
  it("без подтверждения личности — 428", async () => {
    revokeElevation(adminId);
    const res = await request(app).patch("/api/v1/dashboard/modules/video").set(auth(adminToken)).send({ enabled: false });
    expect(res.status).toBe(428);
  });

  it("незнакомый модуль — 404, мусор в теле — 400", async () => {
    grantElevation(adminId);
    const unknown = await request(app)
      .patch("/api/v1/dashboard/modules/nonexistent")
      .set(auth(adminToken))
      .send({ enabled: false });
    expect(unknown.status).toBe(404);
    const junk = await request(app).patch("/api/v1/dashboard/modules/video").set(auth(adminToken)).send({ enabled: "no" });
    expect(junk.status).toBe(400);
  });

  it("выключенная секция исчезает из агрегатора и попадает в modulesOff; след в AuditLog", async () => {
    grantElevation(adminId);
    const before = await request(app).get("/api/v1/dashboard/mission-control").set(auth(adminToken));
    expect(before.status).toBe(200);
    expect(before.body).toHaveProperty("video");
    expect(before.body.modulesOff).not.toContain("video");

    const off = await request(app).patch("/api/v1/dashboard/modules/video").set(auth(adminToken)).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: "video", enabled: false });

    const after = await request(app).get("/api/v1/dashboard/mission-control").set(auth(adminToken));
    expect(after.status).toBe(200);
    expect(after.body).not.toHaveProperty("video");
    expect(after.body.modulesOff).toContain("video");
    // Остальные секции на месте — выключение одной не задевает соседей.
    expect(after.body).toHaveProperty("hero");
    expect(after.body).toHaveProperty("team");

    const list = await request(app).get("/api/v1/dashboard/modules").set(auth(adminToken));
    const row = list.body.modules.find((m: { id: string }) => m.id === "video");
    expect(row.enabled).toBe(false);
    expect(row.updatedBy).toMatchObject({ id: adminId });

    // logAudit пишет вне запроса (best-effort) — ждём запись, а не проверяем
    // сразу после ответа (tests/helpers/waitFor.ts).
    const audit = await waitFor(
      () =>
        prisma.auditLog.findFirst({
          where: { action: "PULT_MODULE_TOGGLE", entityId: "video", agentId: adminId },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись PULT_MODULE_TOGGLE в журнале действий" }
    );
    expect(audit).not.toBeNull();

    const on = await request(app).patch("/api/v1/dashboard/modules/video").set(auth(adminToken)).send({ enabled: true });
    expect(on.status).toBe(200);
    const restored = await request(app).get("/api/v1/dashboard/mission-control").set(auth(adminToken));
    expect(restored.body).toHaveProperty("video");
  });

  it("выключенная лента отвечает пустым списком, выключенный «вопрос к данным» — 409", async () => {
    grantElevation(adminId);
    await request(app).patch("/api/v1/dashboard/modules/ticker").set(auth(adminToken)).send({ enabled: false });
    await request(app).patch("/api/v1/dashboard/modules/ask").set(auth(adminToken)).send({ enabled: false });

    const ticker = await request(app).get("/api/v1/dashboard/mission-control/ticker").set(auth(adminToken));
    expect(ticker.status).toBe(200);
    expect(ticker.body).toEqual({ items: [], nextCursor: null });

    const ask = await request(app)
      .post("/api/v1/dashboard/mission-control/ask")
      .set(auth(adminToken))
      .send({ question: "Сколько лидов сегодня?" });
    expect(ask.status).toBe(409);

    await request(app).patch("/api/v1/dashboard/modules/ticker").set(auth(adminToken)).send({ enabled: true });
    await request(app).patch("/api/v1/dashboard/modules/ask").set(auth(adminToken)).send({ enabled: true });
  });
});
