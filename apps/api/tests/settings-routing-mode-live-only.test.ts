import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * «Голосовое меню (IVR)» не выбирается (23.09.2026). Станция этот режим не
 * исполняет, а сохранённый режим уезжал в неё через AMI (routingModeSync.ts)
 * как рабочий. Кнопку на экране выключили, здесь закрыта вторая дверь —
 * прямой запрос к маршруту настроек.
 */

const runId = Date.now();
const password = "testpass123";

let adminId = "";
let adminToken = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: `Админ режима звонков ${runId}`, phone: `+992963${String(runId).slice(-7)}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("PATCH /settings incomingRoutingMode", () => {
  it("ivr_menu отклоняется и в базу не попадает", async () => {
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { incomingRoutingMode: true } });
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ incomingRoutingMode: "ivr_menu" });
    expect(res.status).toBe(400);
    const after = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { incomingRoutingMode: true } });
    expect(after?.incomingRoutingMode).toBe(before?.incomingRoutingMode);
  });
});
