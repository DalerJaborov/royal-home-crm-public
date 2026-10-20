import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Кабинет маркетинга (GET /marketing/queue, /marketing/summary, /marketing/editors-load).
 *
 * Не входил в исходную письменную спецификацию владельца — добавлен 05.08.2026
 * по прямой просьбе, построен по образцу кабинета СБ (security-center.test.ts).
 * Проверяем: доступ роли MARKETING/DIRECTOR/ADMIN (НЕ по праву properties.viewAll —
 * им обладает и EDITOR/MANAGER, которым сюда хода нет), состав очереди
 * конвейера, счётчики и список монтажёров.
 *
 * ADMIN добавлен в допуск 22.08.2026 (решение владельца: администрация видит
 * все разделы, включая чужие по смыслу, без пробелов) — с обеими вкладками,
 * как у директора.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let plainAgentId: string;
let marketingAgentId: string;
let marketingToken: string;
let editorAgentId: string;
let editorToken: string;
let plainAgentToken: string;
let adminAgentId: string;
let adminToken: string;
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(title: string, data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      ...data,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-маркетинг-${runId}` } })).id;

  const agent = await prisma.agent.create({
    data: { fullName: "Обычный агент-теста", phone: `+992970${runId}`, role: "AGENT", passwordHash },
  });
  plainAgentId = agent.id;
  plainAgentToken = await login(agent.phone);

  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог-теста", phone: `+992971${runId}`, role: "MARKETING", passwordHash },
  });
  marketingAgentId = marketing.id;
  marketingToken = await login(marketing.phone);

  const editor = await prisma.agent.create({
    data: { fullName: "Монтажёр-теста", phone: `+992972${runId}`, role: "EDITOR", passwordHash },
  });
  editorAgentId = editor.id;
  editorToken = await login(editor.phone);

  const admin = await prisma.agent.create({
    data: { fullName: "Админ-теста", phone: `+992973${runId}`, role: "ADMIN", passwordHash },
  });
  adminAgentId = admin.id;
  adminToken = await login(admin.phone);

  // Объект, просрочивший «Ждёт фото» — вошёл в этап давно, дедлайн по умолчанию 2 дня.
  await makeProperty("Просроченные фото", {
    status: "AWAITING_PHOTOS",
    stageEnteredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    intakeAgentId: agent.id,
  });

  // Объект на монтаже, ещё в сроке.
  await makeProperty("На монтаже", {
    status: "EDITING",
    stageEnteredAt: new Date(),
    intakeAgentId: agent.id,
  });

  // Объект уже в продаже — не должен попадать в очередь конвейера.
  await makeProperty("В продаже", { status: "AVAILABLE" });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  // Обычный агент убирается вместе с остальными: он активен, а раздача лидов
  // выбирает исполнителя среди ВСЕХ активных агентов базы — забытый здесь, он
  // навсегда становится участником чужих очередей и роняет чужие проверки
  // (тот же класс, что чинили в #701; помощник tests/helpers/cleanupAgents.ts).
  await deleteAgentsWithTraces([plainAgentId, marketingAgentId, editorAgentId, adminAgentId]);
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
});

describe("GET /marketing/queue", () => {
  it("обычному агенту — 403", async () => {
    const res = await request(app).get("/api/v1/marketing/queue").set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("монтажёру (EDITOR, есть properties.viewAll, но не роль MARKETING) — тоже 403", async () => {
    const res = await request(app).get("/api/v1/marketing/queue").set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(403);
  });

  it("маркетингу — только объекты в конвейере, с состоянием этапа и просрочкой", async () => {
    const res = await request(app).get("/api/v1/marketing/queue").set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    const titles = res.body.items.map((i: { title: string }) => i.title);
    expect(titles).toContain(`Просроченные фото ${runId}`);
    expect(titles).toContain(`На монтаже ${runId}`);
    expect(titles).not.toContain(`В продаже ${runId}`);

    const overdueRow = res.body.items.find((i: { title: string }) => i.title === `Просроченные фото ${runId}`);
    expect(overdueRow.pipeline.overdue).toBe(true);
    expect(overdueRow.pipeline.owner).toBe("AGENT");

    const editingRow = res.body.items.find((i: { title: string }) => i.title === `На монтаже ${runId}`);
    expect(editingRow.pipeline.overdue).toBe(false);
    expect(editingRow.pipeline.owner).toBe("EDITOR");
  });

  it("админу — тоже доступна очередь (решение владельца 22.08.2026, полная видимость)", async () => {
    const res = await request(app).get("/api/v1/marketing/queue").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /marketing/summary", () => {
  it("считает очередь и просрочку по конвейеру", async () => {
    const res = await request(app).get("/api/v1/marketing/summary").set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.awaitingPhotos).toBeGreaterThanOrEqual(1);
    expect(res.body.editing).toBeGreaterThanOrEqual(1);
    expect(res.body.overdue).toBeGreaterThanOrEqual(1);
  });

  it("админу — тоже доступна сводка", async () => {
    const res = await request(app).get("/api/v1/marketing/summary").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /marketing/editors-load", () => {
  it("возвращает список монтажёров и общую очередь монтажа (без персонального закрепления)", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editors-load")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.editors.map((e: { id: string }) => e.id);
    expect(ids).toContain(editorAgentId);
    expect(res.body.sharedQueue.inEditing).toBeGreaterThanOrEqual(1);
  });

  it("админу — тоже доступна нагрузка монтажа", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/editors-load")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

/**
 * GET /marketing/channels-status (01.09.2026) — та же аудитория, что /queue и
 * /summary (requireMarketingRole): монтажёру (EDITOR) сюда хода нет, у него нет
 * своей ветки автопубликации, только очередь монтажа.
 */
describe("GET /marketing/channels-status", () => {
  it("маркетингу — доступен обзор каналов с ожидаемой формой ответа", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/channels-status")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.autoPublishEnabled).toBe("boolean");
    expect(typeof res.body.publishedCount).toBe("number");
    expect(typeof res.body.openErrors).toBe("number");
    // Автомонтаж удалён 04.09.2026 — ни рубильника, ни очереди второй модерации.
    expect(res.body.autoMontageEnabled).toBeUndefined();
    expect(res.body.pendingApproval).toBeUndefined();
    expect(res.body.channels).toMatchObject({
      INSTAGRAM: { connected: expect.any(Boolean), botEnabled: expect.any(Boolean), commentsEnabled: expect.any(Boolean) },
      FACEBOOK: { connected: expect.any(Boolean), botEnabled: expect.any(Boolean) },
      TELEGRAM: {
        botEnabled: expect.any(Boolean),
        crosspostConnected: expect.any(Boolean),
        commentsConnected: expect.any(Boolean),
        commentsEnabled: expect.any(Boolean),
      },
      YOUTUBE: { connected: expect.any(Boolean) },
      // TikTok реализован 17.09.2026 (Content Posting API, routes/tiktok.ts) —
      // раньше здесь была заглушка `{ implemented: false }`.
      TIKTOK: { connected: expect.any(Boolean), username: null },
    });
  });

  it("админу и директору — тоже доступен, монтажёру и обычному агенту — нет", async () => {
    const admin = await request(app)
      .get("/api/v1/marketing/channels-status")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(admin.status).toBe(200);

    const editor = await request(app)
      .get("/api/v1/marketing/channels-status")
      .set("Authorization", `Bearer ${editorToken}`);
    expect(editor.status).toBe(403);

    const plain = await request(app)
      .get("/api/v1/marketing/channels-status")
      .set("Authorization", `Bearer ${plainAgentToken}`);
    expect(plain.status).toBe(403);
  });
});
