import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { learnedRulesBlock, selectActiveLessons } from "../src/lib/botLessons.js";

const run = `quarantine-${Date.now()}`;
const agents: string[] = [], lessons: string[] = [];
let adminToken: string, agentToken: string;
beforeAll(async () => {
  const password = "quarantine-test-password";
  const passwordHash = await bcrypt.hash(password, 4);
  for (const role of ["ADMIN", "AGENT"] as const) {
    const a = await prisma.agent.create({ data: { fullName: `${run}-${role}`, phone: `+992${role === "ADMIN" ? "94" : "95"}${String(Date.now()).slice(-7)}`,
      role, passwordHash, permissions: { granted: ["settings.view", "settings.manage"], revoked: [] } } });
    agents.push(a.id);
    const login = await request(app).post("/api/v1/auth/login").send({ phone: a.phone, password });
    expect(login.status).toBe(200);
    if (role === "ADMIN") adminToken = login.body.accessToken; else agentToken = login.body.accessToken;
  }
  for (const pending of [false, true]) {
    const row = await prisma.botLesson.create({ data: { kind: "audit_finding", channel: "WHATSAPP",
      botMessage: `${run}-private-${pending}`, humanMessage: `${run}-private-answer`,
      lesson: pending ? null : `${run}-private-rule`, active: true, investigationOnly: true } });
    lessons.push(row.id);
  }
});
afterAll(async () => {
  await prisma.botLesson.deleteMany({ where: { id: { in: lessons } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
});
describe("Audit lesson quarantine", () => {
  it("never loads active quarantined rules into chat or voice prompts", async () => {
    await prisma.botLesson.update({ where: { id: lessons[0] }, data: { active: true } });
    expect(await learnedRulesBlock()).not.toContain(run);
    for (const surface of ["chat", "voice"] as const) {
      expect((await selectActiveLessons({ surface })).map(r => r.id)).not.toContain(lessons[0]);
    }
  });
  it("hides legacy examples and counts from ordinary settings readers, preserving admin read", async () => {
    const ordinary = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${agentToken}`);
    const admin = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${adminToken}`);
    expect(ordinary.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(JSON.stringify(ordinary.body)).not.toContain(run);
    expect(JSON.stringify(admin.body)).toContain(run);
    expect(admin.body.rulesTotal).toBeGreaterThan(ordinary.body.rulesTotal);
    expect(admin.body.questionsTotal).toBeGreaterThan(ordinary.body.questionsTotal);
    expect(admin.body.activeCount).toBe(ordinary.body.activeCount);
  });
  it("excludes trainer queue and denies cloning a quarantined group even for admin", async () => {
    const queue = await request(app).get("/api/v1/bot-trainer/queue").set("Authorization", `Bearer ${adminToken}`);
    expect(queue.status).toBe(200);
    expect(JSON.stringify(queue.body)).not.toContain(run);
    for (const ids of [{ lessonId: lessons[1] }, { lessonId: "ordinary-id", lessonGroupIds: [lessons[1]] }]) {
      const result = await request(app).post("/api/v1/bot-trainer/decide")
        .set("Authorization", `Bearer ${adminToken}`).send({ itemId: "question-test", kind: "question",
          verdict: "mute", channel: "WHATSAPP", note: "Do not clone", ...ids });
      expect(result.status).toBe(404);
    }
    expect((await prisma.botLesson.findUniqueOrThrow({ where: { id: lessons[1] } })).lesson).toBeNull();
  });
  it("keeps identical ordinary and quarantined rules in separate groups", async () => {
    const publicRule = await prisma.botLesson.create({ data: { kind: "operator_override", channel: "WHATSAPP",
      botMessage: "Ordinary example", humanMessage: "Ordinary response", lesson: `${run}-private-rule`, active: true } });
    lessons.push(publicRule.id);
    const admin = await request(app).get("/api/v1/bot-learning").set("Authorization", `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);
    const matching = admin.body.rules.filter((r: { lesson: string }) => r.lesson === `${run}-private-rule`);
    expect(matching).toHaveLength(2);
    expect(matching.map((r: { investigationOnly: boolean }) => r.investigationOnly).sort()).toEqual([false, true]);
    expect(matching.every((r: { dupCount: number }) => r.dupCount === 1)).toBe(true);
  });
});
