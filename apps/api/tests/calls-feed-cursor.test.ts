import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Лента звонков GET /calls/feed: курсор не теряет строки с одинаковым временем
 * (находка Codex №16, 04.10.2026).
 *
 * Страница режется `slice(0, limit)` после склейки двух таблиц, а следующая
 * страница просила строго `< nextBefore` по времени последней отданной строки.
 * Строки с тем же временем, что не влезли в limit, отсекались и пропадали из
 * показа (в базе они целы). Время сеем в 2098-2099 годах, чтобы наши строки шли
 * первыми, а остальные данные базы их не разбавляли.
 */

const runId = Date.now();
let adminToken = "";
let adminId = "";
let clientId = "";
const incomingIds: string[] = [];
const interactionIds: string[] = [];

const T_IN = new Date("2099-01-01T10:00:00.000Z");
const T_MIX = new Date("2098-01-01T10:00:00.000Z");

async function addIncoming(startedAt: Date, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await prisma.incomingCall.create({
      data: { channelId: `feed-cursor-${runId}-${startedAt.getUTCFullYear()}-${i}`, phone: `+9927700${String(i).padStart(4, "0")}`, startedAt },
    });
    ids.push(c.id);
  }
  incomingIds.push(...ids);
  return ids;
}

async function addOutgoing(createdAt: Date, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = await prisma.interaction.create({
      data: { clientId, agentId: adminId, type: "CALL", notes: `feed-cursor ${runId}`, callAttempt: "NO_ANSWER", createdAt },
    });
    ids.push(row.id);
  }
  interactionIds.push(...ids);
  return ids;
}

/** Листает ленту курсором, как это делает клиент, и отдаёт все строки подряд. */
async function walk(firstBefore: string, limit: number, maxPages = 6): Promise<string[]> {
  const seen: string[] = [];
  let before: string | null = firstBefore;
  for (let p = 0; p < maxPages && before; p++) {
    const res: request.Response = await request(app)
      .get("/api/v1/calls/feed")
      .query({ limit, before })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    seen.push(...res.body.items.map((i: { id: string }) => i.id));
    before = res.body.nextBefore;
  }
  return seen;
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: `Админ ленты ${runId}`, phone: `+99275${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  adminId = admin.id;
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  const client = await prisma.client.create({
    data: { fullName: `Клиент ленты ${runId}`, phone: `+99276${String(runId).slice(-7)}`, source: "PHONE_CALL", assignedAgentId: admin.id, acceptedAt: new Date() },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.incomingCall.deleteMany({ where: { id: { in: incomingIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("GET /calls/feed: одинаковое время на границе страницы", () => {
  it("три входящих с одним startedAt при limit=2: ничего не теряется и не дублируется", async () => {
    const ids = await addIncoming(T_IN, 3);
    const seen = await walk("2099-06-01T00:00:00.000Z", 2, 2);
    expect(new Set(seen).size).toBe(seen.length); // без дублей
    for (const id of ids) expect(seen).toContain(id);
  });

  it("совпавшее время у входящих и исходящих: все четыре строки видны при limit=3", async () => {
    const inIds = await addIncoming(T_MIX, 2);
    const outIds = await addOutgoing(T_MIX, 2);
    const seen = await walk("2098-06-01T00:00:00.000Z", 3, 2);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of [...inIds, ...outIds]) expect(seen).toContain(id);
  });

  it("старый формат курсора (только время) по-прежнему принимается", async () => {
    const res = await request(app)
      .get("/api/v1/calls/feed")
      .query({ limit: 5, before: "2099-06-01T00:00:00.000Z" })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("мусорный курсор отклоняется 400, а не отдаёт первую страницу молча", async () => {
    const res = await request(app)
      .get("/api/v1/calls/feed")
      .query({ before: "вчера|OUT" })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
