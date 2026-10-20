import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs";

/**
 * ЛИМИТ ЧИСЛА ВИДЕО НА ОБЪЕКТ — CHECK-THEN-ACT БЕЗ ЛОКА (аудит «монтажёр ↔ CRM»,
 * 21.09.2026). До правки `currentCount`/`incomingCount` в POST /:id/videos
 * (routes/properties/videos.ts) считались через Promise.all ДО записи, без
 * транзакции: два агента, грузящие ролики в один объект одновременно, оба
 * проходили проверку и вместе превышали Settings.propertyVideoMaxCount. Очередь
 * монтажа рядом (lib/videoHandoff.ts::queueVideoHandoff) уже была защищена
 * advisory-локом — здесь того же не было.
 *
 * Починка — тот же приём (pg_advisory_xact_lock по propertyId,
 * withPropertyLock в lib/videoHandoff.ts), примененный к проверке+записи здесь.
 * Тест бьёт РЕАЛЬНЫМ HTTP параллельно (Promise.all двух supertest-запросов —
 * они идут отдельными сокетами и правда конкурируют за строку), а не
 * последовательно: с локом ровно один из двух запросов должен пройти лимит=1,
 * другой — честно получить 400. Без лока оба могли пройти проверку одновременно
 * и создать две записи при лимите в одну — именно так и терялась гарантия.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let token: string;
const propertyIds: string[] = [];
let originalMaxCount: number | null = null;

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Лимит видео ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

function uploadOne(propertyId: string, tag: string) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos`)
    .set("Authorization", `Bearer ${token}`)
    .attach("videos", Buffer.from(`видео ${tag}`), { filename: `${tag}.mp4`, contentType: "video/mp4" });
}

async function setMaxCount(n: number) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { propertyVideoMaxCount: n },
    create: { id: "singleton", propertyVideoMaxCount: n },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-лимит-видео-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент лимита видео", phone: `+992954${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992954${runId}`, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyVideoMaxCount: true } });
  originalMaxCount = settings?.propertyVideoMaxCount ?? null;
});

afterAll(async () => {
  if (originalMaxCount !== null) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyVideoMaxCount: originalMaxCount } });
  }
  const videos = await prisma.propertyVideo.findMany({ where: { propertyId: { in: propertyIds } }, select: { storageKey: true } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  for (const v of videos) {
    const p = localVideoFilePath(v.storageKey);
    // Уборка временного файла — по возможности: на Windows файл только что записанного
    // ролика на секунду-другую держит чужой процесс (антивирус, соседний воркер) и `rmSync`
    // отвечает EPERM. Это не результат проверки — набор из-за него красным быть не должен.
    if (p) {
      try {
        fs.rmSync(p, { force: true, maxRetries: 20, retryDelay: 200 });
      } catch {
        /* файл уберёт ночная чистка каталога тестовых загрузок */
      }
    }
  }
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Лимит видео на объект под параллельной нагрузкой", () => {
  it("два запроса ОДНОВРЕМЕННО на лимит=1 — проходит ровно один, второй честно отклонён", async () => {
    const p = await makeProperty();
    await setMaxCount(1);

    const [first, second] = await Promise.all([uploadOne(p.id, "a"), uploadOne(p.id, "b")]);

    const statuses = [first.status, second.status].sort();
    // Ровно один 201 (создан) и один 400 (лимит) — НИКОГДА два 201.
    expect(statuses).toEqual([201, 400]);

    const count = await prisma.propertyVideo.count({ where: { propertyId: p.id } });
    expect(count).toBe(1);
  });

  it("три запроса одновременно на лимит=2 — проходят ровно два, третий отклонён", async () => {
    const p = await makeProperty();
    await setMaxCount(2);

    const results = await Promise.all([uploadOne(p.id, "x"), uploadOne(p.id, "y"), uploadOne(p.id, "z")]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 400]);

    const count = await prisma.propertyVideo.count({ where: { propertyId: p.id } });
    expect(count).toBe(2);
  });

  it("обычная последовательная загрузка в пределах лимита по-прежнему работает", async () => {
    const p = await makeProperty();
    await setMaxCount(30);

    const res = await uploadOne(p.id, "solo");
    expect(res.status).toBe(201);
    expect(await prisma.propertyVideo.count({ where: { propertyId: p.id } })).toBe(1);
  });
});
