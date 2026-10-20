import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /marketing/recently-published — шаг 5 переноса: заменяет заглушку «Ждут
 * публикации / Нет данных» на плашке кабинета маркетинга (MarketingCenter.tsx).
 *
 * Момент выхода из конвейера — AuditLog { action: "PROPERTY_EDITING_DONE" }, а
 * не Property.stageEnteredAt (то поле трогает ЛЮБАЯ смена статуса, не только
 * выход из конвейера — см. комментарий у роута). Проверяем:
 *  1) объект с недавним PROPERTY_EDITING_DONE попадает в список, со своими
 *     publishedChannels;
 *  2) событие старше окна (>7 дней) не попадает;
 *  3) запись audit-лога другого entityType/action не попадает.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let marketingToken: string;
const propertyIds: string[] = [];
const auditIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(title: string, publishedChannels: string[] = []) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая публикаций, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedChannels,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeAudit(entityId: string, createdAt: Date, action = "PROPERTY_EDITING_DONE", entityType = "Property") {
  const a = await prisma.auditLog.create({
    data: { action, entityType, entityId, agentName: "Система", createdAt },
  });
  auditIds.push(a.id);
  return a;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-публикации-${runId}` } })).id;
  await prisma.agent.create({
    data: { fullName: `Маркетинг публикаций ${runId}`, phone: `+992969${runId}`, role: "MARKETING", passwordHash },
  });
  marketingToken = await login(`+992969${runId}`);

  const recent = await makeProperty("Вышел недавно", ["INSTAGRAM", "TELEGRAM"]);
  await makeAudit(recent.id, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));

  const old = await makeProperty("Вышел давно", ["FACEBOOK"]);
  await makeAudit(old.id, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

  const unrelated = await makeProperty("Не выходил из конвейера");
  await makeAudit(unrelated.id, new Date(), "PROPERTY_CREATED");
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone: `+992969${runId}` } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /marketing/recently-published", () => {
  it("отдаёт объекты с PROPERTY_EDITING_DONE за 7 дней, с каналами публикации", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/recently-published")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(7);

    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(propertyIds[0]); // недавний
    expect(ids).not.toContain(propertyIds[1]); // старше окна
    expect(ids).not.toContain(propertyIds[2]); // другое действие журнала

    const row = res.body.items.find((i: { id: string }) => i.id === propertyIds[0]);
    expect(row.publishedChannels).toEqual(["INSTAGRAM", "TELEGRAM"]);
    expect(typeof row.publishedAt).toBe("string");
  });
});
