import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Журнал действий не отдаёт номер клиента тому, кому закрыт clients.viewPhone
 * (аудит Codex 04.10.2026, ACCESS-01).
 *
 * Так было: запись TRASH/RESTORE/CLIENT_MERGE и т.п. кладёт в meta настоящий
 * phone и fullName клиента, а GET /audit-log прятал при отдаче только контакт
 * владельца объекта. Право auditLog.view обходило clients.viewPhone.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const ids: string[] = [];
const auditIds: string[] = [];
const PHONE = "+992900001122";
const clientEntityId = `00000000-0000-4000-8000-${runId.padStart(12, "0")}`;
let blindToken: string;
let seeingToken: string;

async function mk(fullName: string, phone: string, permissions: unknown) {
  await prisma.agent.deleteMany({ where: { phone } });
  const a = await prisma.agent.create({
    data: {
      fullName,
      phone,
      role: "MANAGER" as never,
      passwordHash: await bcrypt.hash(password, 10),
      permissions: permissions as never,
    },
  });
  ids.push(a.id);
  return a;
}

async function loginOf(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const blind = await mk("Читатель Журнала Без Номеров", `+992991${runId}`, {
    granted: ["auditLog.view"],
    revoked: ["clients.viewPhone"],
  });
  const seeing = await mk("Читатель Журнала С Номерами", `+992992${runId}`, {
    granted: ["auditLog.view", "clients.viewPhone"],
    revoked: [],
  });
  blindToken = await loginOf(blind.phone);
  seeingToken = await loginOf(seeing.phone);
  for (const action of ["TRASH", "RESTORE"]) {
    const row = await prisma.auditLog.create({
      data: {
        action,
        entityType: "Client",
        entityId: clientEntityId,
        agentName: "Тест",
        meta: { shortId: "ПР-000001", fullName: `Входящий ${PHONE}`, phone: PHONE, kind: "BUYER" },
      },
    });
    auditIds.push(row.id);
  }
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
  await prisma.session.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("GET /audit-log и номер клиента", () => {
  it("без clients.viewPhone номер в meta и в имени закрыт", async () => {
    const res = await request(app)
      .get(`/api/v1/audit-log?entityType=Client&entityId=${clientEntityId}`)
      .set("Authorization", `Bearer ${blindToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    const text = JSON.stringify(res.body.items);
    expect(text).not.toContain("900001122");
    // Остальные поля записи на месте.
    expect(res.body.items[0].meta.shortId).toBe("ПР-000001");
    expect(res.body.items[0].meta.kind).toBe("BUYER");
  });

  it("с clients.viewPhone журнал отдаётся как есть", async () => {
    const res = await request(app)
      .get(`/api/v1/audit-log?entityType=Client&entityId=${clientEntityId}`)
      .set("Authorization", `Bearer ${seeingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].meta.phone).toBe(PHONE);
    expect(res.body.items[0].meta.fullName).toContain(PHONE);
  });
});
