import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { PROPERTY_PIPELINE_STATUSES } from "@royal-home/shared";
import { countStuckConversationsByChannel, findStuckConversations } from "../src/lib/stuckConversations.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * СЧЁТЧИКИ, КОТОРЫЕ УПИРАЛИСЬ В ПРЕДЕЛ ВЫБОРКИ, И СПИСКИ БЕЗ ПРОДОЛЖЕНИЯ
 * (02.10.2026, класс «Пагинация»).
 *
 * Общий признак: число на экране было длиной выданной пачки (30, 200, 500, 50),
 * то есть выглядело настоящим, а было потолком сервера; а список за потолком
 * нельзя было долистать. Здесь закреплено, что числа — настоящие count() по тем
 * же условиям, а страница 2 отдаёт следующие строки, а не повтор первой.
 *
 * База общая с соседними файлами, поэтому сверяемся не с числом заведённых тут
 * строк, а с тем, что говорит сама база по тому же условию и порядку.
 */

const runId = Date.now();
const password = "testpass123";
const agentIds: string[] = [];
let adminToken: string;
let marketingToken: string;
let strangerToken: string;
let clientId: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const mk = async (role: "ADMIN" | "MARKETING" | "AGENT", prefix: string) => {
    const a = await prisma.agent.create({
      data: { fullName: `Счётчики ${role} ${runId}`, phone: `+${prefix}${runId}`, role, passwordHash },
    });
    agentIds.push(a.id);
    return a;
  };
  const admin = await mk("ADMIN", "99291");
  const marketing = await mk("MARKETING", "99292");
  const stranger = await mk("AGENT", "99293");
  adminToken = await login(admin.phone);
  marketingToken = await login(marketing.phone);
  strangerToken = await login(stranger.phone);

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент хронологии ${runId}`,
      phone: `+99294${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: admin.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
  // Семь записей, две из них в ОДНУ секунду — курсор (createdAt, id) обязан
  // не потерять и не задвоить их на стыке страниц.
  const base = Date.now() - 60 * 60 * 1000;
  const sameMoment = new Date(base + 3 * 60_000);
  const times = [base, base + 60_000, base + 120_000, sameMoment.getTime(), sameMoment.getTime(), base + 240_000, base + 300_000];
  for (const [i, t] of times.entries()) {
    await prisma.interaction.create({
      data: {
        clientId,
        agentId: admin.id,
        type: i % 2 === 0 ? "CALL" : "MEETING",
        notes: `Запись ${i} ${runId}`,
        createdAt: new Date(t),
      },
    });
  }
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces(agentIds);
});

describe("GET /clients/:id/timeline — старые записи хронологии курсором", () => {
  it("карточка отдаёт настоящее число записей (interactionsTotal)", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.interactionsTotal).toBe(7);
    expect(res.body._count).toBeUndefined();
  });

  it("листает по 3 без потерь и повторов, total — все записи", async () => {
    const seen: string[] = [];
    let cursor: { before: string; beforeId: string } | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const qs = new URLSearchParams({ limit: "3", ...(cursor ?? {}) });
      const res = await request(app)
        .get(`/api/v1/clients/${clientId}/timeline?${qs.toString()}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(7);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      if (!res.body.hasMore) break;
      const last = res.body.items[res.body.items.length - 1];
      cursor = { before: last.createdAt, beforeId: last.id };
    }
    const expected = await prisma.interaction.findMany({
      where: { clientId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    expect(seen).toEqual(expected.map((e) => e.id));
  });

  it("срез «Звонки» листает только звонки и считает только их", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/timeline?type=CALL&limit=50`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.items.every((i: { type: string }) => i.type === "CALL")).toBe(true);
    expect(res.body.hasMore).toBe(false);
  });

  it("чужой агент — 403, как и у самой карточки", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/timeline`)
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(res.status).toBe(403);
  });

  it("половина курсора — 400", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/timeline?before=${encodeURIComponent(new Date().toISOString())}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /marketing/queue?status= — стадия фильтруется на сервере", () => {
  it("только строки стадии, total — count() по стадии, страница 2 — следующие 40", async () => {
    const where = { deletedAt: null, status: "EDITING" as const };
    const res = await request(app)
      .get("/api/v1/marketing/queue?status=EDITING&page=1")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(await prisma.property.count({ where }));
    expect(res.body.items.every((r: { status: string }) => r.status === "EDITING")).toBe(true);

    const all = { deletedAt: null, status: { in: [...PROPERTY_PIPELINE_STATUSES] } };
    const page2 = await request(app).get("/api/v1/marketing/queue?page=2").set("Authorization", `Bearer ${marketingToken}`);
    expect(page2.status).toBe(200);
    const expected = await prisma.property.findMany({
      where: all,
      orderBy: [{ stageEnteredAt: "asc" }, { id: "asc" }],
      skip: 40,
      take: 40,
      select: { id: true },
    });
    expect(new Set(page2.body.items.map((r: { id: string }) => r.id))).toEqual(new Set(expected.map((e) => e.id)));
  });

  it("чужая стадия — 400", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/queue?status=AVAILABLE")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /marketing/editor-queue — у каждого списка своя страница", () => {
  it("editingPage=2 отдаёт строки после первых 50, счётчики — по всему этапу", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editor-queue?editingPage=2&upcomingPage=1")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(50);
    expect(res.body.counts.inEditing).toBe(await prisma.property.count({ where: { deletedAt: null, status: "EDITING" } }));
    expect(res.body.counts.upcoming).toBe(
      await prisma.property.count({ where: { deletedAt: null, status: "AWAITING_VIDEO" } })
    );
    const expected = await prisma.property.findMany({
      where: { deletedAt: null, status: "EDITING" },
      orderBy: [{ stageEnteredAt: "asc" }, { id: "asc" }],
      skip: 50,
      take: 50,
      select: { id: true },
    });
    expect(new Set(res.body.inEditing.map((r: { id: string }) => r.id))).toEqual(new Set(expected.map((e) => e.id)));
  });
});

describe("GET /marketing/recently-published — «Показать ещё»", () => {
  it("отдаёт page/pageSize и честный total событий за окно", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/recently-published?page=2")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(50);
    expect(typeof res.body.total).toBe("number");
  });
});

describe("Счётчики, упиравшиеся в предел выборки", () => {
  it("тренажёр бота: total — все ждущие случаи, а не длина очереди в 30", async () => {
    const res = await request(app).get("/api/v1/bot-trainer/queue?limit=1").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const [lessons, findings] = await Promise.all([
      prisma.botLesson.count({ where: { lesson: null } }),
      prisma.botAuditFinding.count({ where: { resolvedAt: null } }),
    ]);
    expect(res.body.items.length).toBeLessThanOrEqual(1);
    expect(res.body.total).toBeGreaterThanOrEqual(lessons + findings);
  });

  it("«Сейчас ждут ответа»: сумма по каналам — COUNT без предела в 200", async () => {
    const res = await request(app).get("/api/v1/reports/waiting-now").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const sum = res.body.channels.reduce((acc: number, c: { waiting: number }) => acc + c.waiting, 0);
    expect(res.body.totalWaiting).toBe(sum);
    const counts = await countStuckConversationsByChannel();
    const rows = await findStuckConversations();
    // Подсчёт и выборка — одно условие: пока строк меньше предела, числа совпадают.
    if (rows.length < 200) expect(counts.reduce((a, c) => a + c.count, 0)).toBe(rows.length);
  });

  it("аудит диалогов: total — count(), а не длина выборки в 500", async () => {
    const res = await request(app).get("/api/v1/bot-audit").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(res.body.unresolvedTotal);
    expect(typeof res.body.groupsLimited).toBe("boolean");
  });
});
