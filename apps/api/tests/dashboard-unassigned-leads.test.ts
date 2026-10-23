import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { UNASSIGNED_LEADS_LIMIT } from "../src/lib/unassignedLeads.js";

/**
 * «Ждут агента» на пульте: список `GET /dashboard/unassigned-leads` и число
 * `queuedTotal` из `GET /dashboard/team-live` считаются ОДНИМ условием
 * (lib/unassignedLeads.ts) и обязаны совпадать. База общая на прогон, поэтому
 * сверяем число с `total` списка, а свои строки ищем по метке.
 */
const runId = Date.now();
const created: string[] = [];
let directorId = "";
let agentId = "";
let directorToken = "";
let agentToken = "";
let phoneSeq = 0;

async function makeClient(name: string, over: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+9929${String(runId).slice(-5)}${String(phoneSeq++).padStart(2, "0")}`,
      source: "TELEGRAM",
      kind: "BUYER",
      assignedAgentId: null,
      acceptedAt: null,
      ...over,
    },
  });
  created.push(c.id);
  return c;
}

beforeAll(async () => {
  const [director, agent] = await Promise.all([
    prisma.agent.create({ data: { fullName: `Директор очереди ${runId}`, phone: `+99271${String(runId).slice(-8)}`, role: "DIRECTOR", passwordHash: "x" } }),
    prisma.agent.create({ data: { fullName: `Агент очереди ${runId}`, phone: `+99272${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" } }),
  ]);
  directorId = director.id;
  agentId = agent.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: created } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.$disconnect();
});

const get = (path: string, token: string) => request(app).get(`/api/v1/dashboard/${path}`).set("Authorization", `Bearer ${token}`);

describe("GET /dashboard/unassigned-leads", () => {
  it("список и queuedTotal считают одно и то же; чужие состояния в список не попадают", async () => {
    const waiting = await makeClient("Ждёт агента");
    const other = await makeClient("Прочее", { kind: "OTHER" });
    const assigned = await makeClient("Назначен", { assignedAgentId: agentId });
    const trashed = await makeClient("В корзине", { deletedAt: new Date() });

    const list = await get("unassigned-leads", directorToken);
    expect(list.status).toBe(200);
    const live = await get("team-live", directorToken);
    expect(live.status).toBe(200);
    expect(list.body.total).toBe(live.body.queuedTotal);

    const ids = list.body.items.map((i: { id: string }) => i.id);
    expect(list.body.items.length).toBeLessThanOrEqual(UNASSIGNED_LEADS_LIMIT);
    const mine = list.body.items.find((i: { id: string }) => i.id === waiting.id);
    // Своя строка может не войти в первые 20, если в общей базе есть более давние, — тогда число всё равно сверено выше.
    if (list.body.total <= UNASSIGNED_LEADS_LIMIT) {
      expect(mine).toMatchObject({ id: waiting.id, shortId: waiting.shortId, source: "TELEGRAM" });
      expect(typeof mine.waitingMinutes).toBe("number");
    }
    for (const bad of [other.id, assigned.id, trashed.id]) expect(ids).not.toContain(bad);
    // Давние первыми.
    const times = list.body.items.map((i: { createdAt: string }) => i.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it("агенту без права назначать — 403", async () => {
    const res = await get("unassigned-leads", agentToken);
    expect(res.status).toBe(403);
  });
});
