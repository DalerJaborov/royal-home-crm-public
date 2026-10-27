import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";
import { settingsSomonRouter } from "../src/routes/settingsSomon.js";

const app = express(); app.use(express.json()); app.use("/settings/somon", settingsSomonRouter);
const adminId = randomUUID(), agentId = randomUUID();
let oldMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;
let oldRecipients: Awaited<ReturnType<typeof prisma.somonRecipient.findMany>> = [];
let adminToken = "", agentToken = "";

describe("Somon settings access", () => {
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
    oldMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    oldRecipients = await prisma.somonRecipient.findMany();
    await prisma.somonRecipient.deleteMany();
    await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
    await prisma.agent.createMany({ data: [
      { id: adminId, fullName: "Stand admin", phone: `stand-admin-${adminId}`, role: "ADMIN" },
      { id: agentId, fullName: "Stand agent", phone: `stand-agent-${agentId}`, role: "AGENT", telegramChatId: `stand-chat-${agentId}` },
    ] });
    adminToken = signAccessToken({ sub: adminId, role: "ADMIN" });
    agentToken = signAccessToken({ sub: agentId, role: "AGENT" });
  });
  afterAll(async () => {
    revokeElevation(adminId);
    await prisma.somonRecipient.deleteMany();
    if (oldRecipients.length) await prisma.somonRecipient.createMany({ data: oldRecipients });
    await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
    if (oldMonitor) await prisma.somonMonitor.create({ data: oldMonitor });
    await prisma.auditLog.deleteMany({ where: { agentId: adminId, entityType: { in: ["SomonMonitor", "SomonDelivery"] } } });
    await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
    vi.unstubAllEnvs();
  });
  it("requires authentication and settings permission", async () => {
    expect((await request(app).get("/settings/somon/recipients")).status).toBe(401);
    expect((await request(app).get("/settings/somon/recipients").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
  });
  it("requires elevation, validates the list, and starts only with a linked agent", async () => {
    const url = "/settings/somon/recipients", auth = `Bearer ${adminToken}`;
    expect((await request(app).put(url).set("Authorization", auth).send({ agentIds: [agentId] })).status).toBe(428);
    grantElevation(adminId);
    expect((await request(app).put(url).set("Authorization", auth).send({ agentIds: [agentId, agentId] })).status).toBe(400);
    expect((await request(app).put(url).set("Authorization", auth).send({ agentIds: [agentId] })).status).toBe(200);
    expect((await request(app).put("/settings/somon/state").set("Authorization", auth).send({ enabled: true })).status).toBe(200);
    const state = await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(state.enabled).toBe(true); expect(state.baselineAt).toBeNull();
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { sourceStopped: true, sourceFailures: 5 } });
    expect((await request(app).post("/settings/somon/source/recover").set("Authorization", auth).send({})).status).toBe(400);
    expect((await request(app).post("/settings/somon/source/recover").set("Authorization", `Bearer ${agentToken}`).send({ checked: true })).status).toBe(403);
    const before = Date.now();
    expect((await request(app).post("/settings/somon/source/recover").set("Authorization", auth).send({ checked: true })).status).toBe(200);
    const recovered = await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(recovered.sourceStopped).toBe(false); expect(recovered.sourceFailures).toBe(0); expect(recovered.blockedUntil!.getTime()).toBeGreaterThanOrEqual(before + 120000);
    expect((await request(app).put("/settings/somon/state").set("Authorization", auth).send({ enabled: false })).status).toBe(200);
  });
});
