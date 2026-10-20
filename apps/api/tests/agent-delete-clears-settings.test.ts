import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * «Удалить сотрудника» снимает его из Настроек (G4, 02.10.2026).
 *
 * Так было: снятие из пяти полей Настроек (монтажёр, дежурный оператор,
 * дежурные по входящим, модератор, консультант робота) звалось только при
 * отключении тумблером и заморозке. DELETE /agents/:id — и жёсткое удаление,
 * и «отключить вместо удаления» — его не звал: монтажёр с историей входов
 * «удалялся», а сырые ролики с адресами продолжали уходить в его Telegram.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
let adminId: string;
let adminToken: string;
const created: string[] = [];
type SettingsRefs = {
  videoMontajerAgentId: string | null;
  callbackOperatorAgentId: string | null;
  incomingDutyAgentIds: string[];
};
let original: SettingsRefs | null = null;

async function makeEditor(label: string, withHistory: boolean) {
  const phone = `+99295${created.length}${runId}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const a = await prisma.agent.create({
    data: {
      fullName: `Монтажёр ${label}`,
      phone,
      role: "EDITOR",
      passwordHash: await bcrypt.hash(password, 4),
      telegramChatId: `7${created.length}${runId}`,
    },
  });
  created.push(a.id);
  if (withHistory) {
    await prisma.loginLog.create({ data: { agentId: a.id, ip: "127.0.0.1" } });
  }
  return a;
}

function del(id: string) {
  grantElevation(adminId);
  return request(app).delete(`/api/v1/agents/${id}`).set("Authorization", `Bearer ${adminToken}`);
}

beforeAll(async () => {
  const phone = `+992958${runId}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const admin = await prisma.agent.create({
    data: { fullName: "Админ увольнения", phone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 4) },
  });
  adminId = admin.id;
  created.push(admin.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
  adminToken = login.body.accessToken;
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoMontajerAgentId: true, callbackOperatorAgentId: true, incomingDutyAgentIds: true },
  });
  original = s;
});

afterAll(async () => {
  if (original) await prisma.settings.update({ where: { id: "singleton" }, data: original });
  await prisma.loginLog.deleteMany({ where: { agentId: { in: created } } });
  await prisma.session.deleteMany({ where: { agentId: { in: created } } });
  await prisma.agent.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe("DELETE /agents/:id снимает сотрудника из Настроек", () => {
  it("с историей (отключить вместо удаления): монтажёр и дежурный сняты, Telegram отвязан", async () => {
    const editor = await makeEditor("с историей", true);
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { videoMontajerAgentId: editor.id, callbackOperatorAgentId: editor.id, incomingDutyAgentIds: [editor.id] },
      create: { id: "singleton", videoMontajerAgentId: editor.id, callbackOperatorAgentId: editor.id, incomingDutyAgentIds: [editor.id] },
    });

    const res = await del(editor.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deactivatedInsteadOfDeleted).toBe(true);

    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { videoMontajerAgentId: true, callbackOperatorAgentId: true, incomingDutyAgentIds: true },
    });
    expect(s!.videoMontajerAgentId).toBeNull();
    expect(s!.callbackOperatorAgentId).toBeNull();
    expect(s!.incomingDutyAgentIds).not.toContain(editor.id);

    const row = await prisma.agent.findUnique({ where: { id: editor.id }, select: { isActive: true, telegramChatId: true } });
    expect(row!.isActive).toBe(false);
    expect(row!.telegramChatId).toBeNull();
  });

  it("без истории (стёрт целиком): монтажёр снят из Настроек", async () => {
    const editor = await makeEditor("без истории", false);
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: editor.id } });

    const res = await del(editor.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deactivatedInsteadOfDeleted).toBeUndefined();
    expect(await prisma.agent.findUnique({ where: { id: editor.id } })).toBeNull();

    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
    expect(s!.videoMontajerAgentId).toBeNull();
  });
});
