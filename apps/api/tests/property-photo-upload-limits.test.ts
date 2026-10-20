import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Загрузка фото объекта: битый файл и потолок числа (находка №162).
 *
 * Битый файл с типом «картинка» давал 500 «Ошибка сервера» и запись в журнал
 * ошибок (черновики отвечали 502), а у объекта не было потолка числа фото
 * (у черновика он 60).
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992944${String(runId).slice(-7)}`;
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
let agentId: string;
let districtId: string;
let token: string;
const propertyIds: string[] = [];

async function makeProperty(photoCount = 0) {
  const p = await prisma.property.create({
    data: {
      title: `Лимиты фото ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: `Тестовая лимитов, ${propertyIds.length + 1}`,
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
    },
  });
  propertyIds.push(p.id);
  if (photoCount > 0) {
    await prisma.propertyPhoto.createMany({
      data: Array.from({ length: photoCount }, (_, i) => ({
        propertyId: p.id,
        url: `/uploads/limits-${runId}-${i}.webp`,
        thumbUrl: `/uploads/thumbs/limits-${runId}-${i}.webp`,
        order: i,
      })),
    });
  }
  return p;
}

const upload = (propertyId: string, files: { buf: Buffer; name: string; type: string }[]) => {
  let r = request(app).post(`/api/v1/properties/${propertyId}/photos`).set("Authorization", `Bearer ${token}`);
  for (const f of files) r = r.attach("photos", f.buf, { filename: f.name, contentType: f.type });
  return r;
};

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Агент лимитов фото", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })).id;
  districtId = (await prisma.district.create({ data: { name: `Район лимитов фото ${runId}` } })).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([agentId]);
});

describe("№162 — загрузка фото объекта", () => {
  it("битый файл с типом «картинка» → 400, а не 500; ничего не создаётся", async () => {
    const p = await makeProperty();
    const res = await upload(p.id, [{ buf: Buffer.from("not an image"), name: "x.jpg", type: "image/jpeg" }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/не похож на фото/);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("хорошее и битое фото в одной пачке — не остаётся ничего", async () => {
    const p = await makeProperty();
    const res = await upload(p.id, [
      { buf: TINY_PNG, name: "ok.png", type: "image/png" },
      { buf: Buffer.from("not an image"), name: "bad.jpg", type: "image/jpeg" },
    ]);
    expect(res.status).toBe(400);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("исправное фото по-прежнему принимается", async () => {
    const p = await makeProperty();
    const res = await upload(p.id, [{ buf: TINY_PNG, name: "ok.png", type: "image/png" }]);
    expect(res.status).toBe(201);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(1);
  });

  it("потолок 60 фото на объект → 400", async () => {
    const p = await makeProperty(59);
    const res = await upload(p.id, [
      { buf: TINY_PNG, name: "a.png", type: "image/png" },
      { buf: TINY_PNG, name: "b.png", type: "image/png" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/60/);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: p.id } })).toBe(59);
  });

  it("шестидесятое фото ещё помещается", async () => {
    const p = await makeProperty(59);
    const res = await upload(p.id, [{ buf: TINY_PNG, name: "a.png", type: "image/png" }]);
    expect(res.status).toBe(201);
  });
});
