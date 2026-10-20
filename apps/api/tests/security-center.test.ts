import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Кабинет службы безопасности (GET /security/lost-clients, /security/lost-properties):
 * агрегация карточек, у которых Client.securityReview не пусто, разделённая на
 * покупателя (kind BUYER/OTHER) и продавца (kind SELLER) — см. routes/security.ts.
 */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let securityAgentId: string;
let securityToken: string;
let plainAgentToken: string;
const clientIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент СБ-теста", phone: `+992960${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  securityAgentId = (
    await prisma.agent.create({
      data: { fullName: "Служба безопасности", phone: `+992961${runId}`, role: "SECURITY", passwordHash },
    })
  ).id;
  plainAgentToken = await login(`+992960${runId}`);
  securityToken = await login(`+992961${runId}`);

  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель СБ ${runId}`,
      phone: `+992962${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      securityReview: "PENDING",
    },
  });
  clientIds.push(buyer.id);
  await prisma.interaction.create({
    data: {
      clientId: buyer.id,
      agentId,
      type: "SYSTEM",
      notes: "Клиент отказался (Купил самостоятельно). Инициатор: Клиент. Отказ №1.",
    },
  });

  const seller = await prisma.client.create({
    data: {
      fullName: `Продавец СБ ${runId}`,
      phone: `+992963${runId}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      securityReview: "CONFIRMED",
      securityReviewedAt: new Date(),
      securityReviewedById: securityAgentId,
      securityNote: "Продал в обход агентства",
    },
  });
  clientIds.push(seller.id);
  await prisma.interaction.create({
    data: {
      clientId: seller.id,
      agentId,
      type: "SYSTEM",
      notes: "Итог объекта: Неактивный (Продал самостоятельно). Инициатор: Собственник.",
    },
  });

  // Клиент без проверки СБ — не должен попадать ни в один из списков.
  const clean = await prisma.client.create({
    data: {
      fullName: `Чистый клиент ${runId}`,
      phone: `+992964${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
    },
  });
  clientIds.push(clean.id);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, securityAgentId] } } });
});

describe("GET /security/lost-clients", () => {
  it("без права clients.securityReview — 403", async () => {
    const res = await request(app)
      .get("/api/v1/security/lost-clients")
      .set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("возвращает только BUYER/OTHER с непустым securityReview, с причиной и инициатором", async () => {
    const res = await request(app)
      .get("/api/v1/security/lost-clients")
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(clientIds[0]);
    expect(ids).not.toContain(clientIds[1]); // seller — другой раздел
    expect(ids).not.toContain(clientIds[2]); // без проверки СБ вовсе

    const row = res.body.items.find((i: { id: string }) => i.id === clientIds[0]);
    expect(row.securityReview).toBe("PENDING");
    expect(row.initiator).toBe("CLIENT");
    expect(row.refusalReason).toBeNull(); // тестовые клиенты созданы напрямую в БД, без refuse-маршрута
  });
});

/**
 * «Видеть все» — не «править все».
 *
 * У службы безопасности есть `clients.viewAll` и нет `clients.assign`, а доступ на
 * запись в PATCH /clients/:id решался только первым правом. Проверяющий мог
 * переписать разбираемую карточку — стереть название агентства-конкурента или
 * поправить комментарий об уходе клиента. Тест держит границу с обеих сторон:
 * читать СБ по-прежнему может всё (проверки выше), писать в чужую карточку — нет.
 */
describe("PATCH /clients/:id — правка чужой карточки", () => {
  it("служба безопасности читает, но не правит", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${clientIds[0]}`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ fullName: "Переписано службой безопасности" });
    expect(res.status).toBe(403);

    const untouched = await prisma.client.findUnique({ where: { id: clientIds[0] }, select: { fullName: true } });
    expect(untouched?.fullName).toBe(`Покупатель СБ ${runId}`);
  });
});

describe("GET /security/lost-properties", () => {
  it("возвращает только SELLER с непустым securityReview, с вердиктом и проверяющим", async () => {
    const res = await request(app)
      .get("/api/v1/security/lost-properties")
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(clientIds[1]);
    expect(ids).not.toContain(clientIds[0]); // buyer — другой раздел

    const row = res.body.items.find((i: { id: string }) => i.id === clientIds[1]);
    expect(row.securityReview).toBe("CONFIRMED");
    expect(row.reviewedBy?.id).toBe(securityAgentId);
    expect(row.initiator).toBe("OWNER");
  });
});
