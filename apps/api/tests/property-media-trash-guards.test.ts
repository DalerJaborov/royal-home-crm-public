import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * ФОТО И ВИДЕО ОБЪЕКТА В КОРЗИНЕ НЕ ТРОГАЮТСЯ; УЛУЧШЕНИЕ ФОТО — ПОД ЗАМКОМ
 * МОНТАЖА (глубокая проверка 02.10.2026, D13).
 *
 * Загрузка фото проверяла Корзину, а порядок фото, удаление фото (внутри —
 * смена статуса и снятие с сайта по удалённому объекту) и удаление видео —
 * нет. Одобрение улучшенного ИИ фото подменяло снимок во время монтажа, когда
 * все остальные операции с фото агенту закрыты.
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
let agentId = "";
let token = "";
const propertyIds: string[] = [];

async function property(data: { status: "AVAILABLE" | "EDITING"; deletedAt?: Date }) {
  const p = await prisma.property.create({
    data: {
      title: `Медиа в корзине ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      condition: "GOOD",
      intakeAgentId: agentId,
      createdById: agentId,
      ...data,
      photos: {
        create: [
          { url: "/uploads/trash-guard-a.webp", thumbUrl: "/uploads/thumbs/trash-guard-a.webp", order: 0 },
          {
            url: "/uploads/trash-guard-b.webp",
            thumbUrl: "/uploads/thumbs/trash-guard-b.webp",
            order: 1,
            enhancedUrl: "/uploads/trash-guard-b-enh.webp",
            enhancedThumbUrl: "/uploads/thumbs/trash-guard-b-enh.webp",
          },
        ],
      },
      videos: { create: [{ storageKey: `trash-guard/${runId}.mp4`, filename: "tour.mp4", sizeBytes: 10, uploadedById: agentId }] },
    },
    include: { photos: { orderBy: { order: "asc" } }, videos: true },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Медиа корзины ${runId}`, phone: `+992965${tail}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("D13: объект в Корзине", () => {
  it("порядок фото, удаление фото и удаление видео — 409, ничего не меняется", async () => {
    const p = await property({ status: "EDITING", deletedAt: new Date() });
    const [a, b] = p.photos;

    const order = await request(app)
      .patch(`/api/v1/properties/${p.id}/photos/order`)
      .set("Authorization", `Bearer ${token}`)
      .send({ photoIds: [b.id, a.id] });
    expect(order.status).toBe(409);
    expect((await prisma.propertyPhoto.findUniqueOrThrow({ where: { id: a.id } })).order).toBe(0);

    const delPhoto = await request(app).delete(`/api/v1/properties/${p.id}/photos/${a.id}`).set("Authorization", `Bearer ${token}`);
    expect(delPhoto.status).toBe(409);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(2);

    const delVideo = await request(app)
      .delete(`/api/v1/properties/${p.id}/videos/${p.videos[0].id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(delVideo.status).toBe(409);
    expect(await prisma.propertyVideo.count({ where: { propertyId: p.id } })).toBe(1);
  });
});

describe("D13: одобрение улучшенного фото после публикации", () => {
  it("агенту — 409, снимок не подменяется", async () => {
    const p = await property({ status: "AVAILABLE" });
    const b = p.photos[1];
    grantElevation(agentId);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/photos/${b.id}/enhance/approve`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect((await prisma.propertyPhoto.findUniqueOrThrow({ where: { id: b.id } })).url).toBe("/uploads/trash-guard-b.webp");
  });
});
