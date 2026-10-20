import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * APROP01 (аудит 04.10.2026): загрузка разрешает до 60 фото, а схема порядка
 * принимала не больше 50 id: у объекта с 51-60 снимками нельзя было сменить
 * обложку и порядок (400).
 * PROP-01: новое фото получало order = число фото, то есть чужой занятый order
 * после удаления из середины; после удаления обложки делило order с ней.
 */
const runId = Date.now();
const password = "testpass123";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let districtId = "";
let agentId = "";
let token = "";
const propertyIds: string[] = [];

async function makeProperty(label: string) {
  const p = await prisma.property.create({
    data: {
      title: `${label} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Район порядка фото ${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент порядка фото", phone: `+992924${runId}`, role: "AGENT", passwordHash } })).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992924${runId}`, password });
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("порядок фото: 51-60 снимков (APROP01)", () => {
  it("объект с 55 фото: смена порядка и обложки проходит", async () => {
    const propertyId = await makeProperty("Объект 55 фото");
    await prisma.propertyPhoto.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({ propertyId, url: `/uploads/p${i}.jpg`, thumbUrl: `/uploads/t${i}.jpg`, order: i })),
    });
    const photos = await prisma.propertyPhoto.findMany({ where: { propertyId }, orderBy: { order: "asc" } });
    const reversed = photos.map((p) => p.id).reverse();
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}/photos/order`)
      .set("Authorization", `Bearer ${token}`)
      .send({ photoIds: reversed });
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(reversed[0]);
  });

  it("список длиннее потолка 60 по-прежнему отклоняется", async () => {
    const propertyId = await makeProperty("Объект для 61 id");
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}/photos/order`)
      .set("Authorization", `Bearer ${token}`)
      .send({ photoIds: Array.from({ length: 61 }, () => crypto.randomUUID()) });
    expect(res.status).toBe(400);
  });
});

describe("новое фото получает свободный order (PROP-01)", () => {
  it("после удаления фото из середины новое получает order 4, а не занятый 3", async () => {
    const propertyId = await makeProperty("Объект дыра order");
    await prisma.propertyPhoto.createMany({
      data: [0, 1, 2, 3].map((i) => ({ propertyId, url: `/uploads/q${i}.jpg`, thumbUrl: `/uploads/qt${i}.jpg`, order: i })),
    });
    await prisma.propertyPhoto.deleteMany({ where: { propertyId, order: 1 } });
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", TINY_PNG, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const orders = (await prisma.propertyPhoto.findMany({ where: { propertyId }, orderBy: { order: "asc" } })).map((p) => p.order);
    expect(orders).toEqual([0, 2, 3, 4]);
  });

  it("после удаления обложки новое фото не делит order с оставшимся", async () => {
    const propertyId = await makeProperty("Объект без обложки");
    await prisma.propertyPhoto.createMany({
      data: [0, 1].map((i) => ({ propertyId, url: `/uploads/r${i}.jpg`, thumbUrl: `/uploads/rt${i}.jpg`, order: i })),
    });
    await prisma.propertyPhoto.deleteMany({ where: { propertyId, order: 0 } });
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/photos`)
      .set("Authorization", `Bearer ${token}`)
      .attach("photos", TINY_PNG, { filename: "b.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const orders = (await prisma.propertyPhoto.findMany({ where: { propertyId }, orderBy: { order: "asc" } })).map((p) => p.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
