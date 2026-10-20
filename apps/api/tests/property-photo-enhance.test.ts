import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * УЛУЧШЕНИЕ ФОТО ОБЪЕКТА ИИ (пункт 7 очереди, 23.08.2026) — три эндпоинта:
 * запуск, одобрение, отклонение.
 *
 * Что здесь ПРИНЦИПИАЛЬНО проверить, а не "зелёные тесты ради галочки"
 * (см. живой инцидент того же дня, из-за которого функция вообще получила
 * три барьера, а не просто тумблер):
 *  - рубильник Settings.propertyPhotoEnhanceEnabled закрывает запуск на
 *    СЕРВЕРЕ, а не только прячет кнопку;
 *  - approve переносит enhanced* → url/thumbUrl и БЭКАПИТ прежние значения
 *    в original*, а не подменяет их молча;
 *  - reject НЕ трогает url/thumbUrl вообще — только чистит enhanced*;
 *  - чужой объект (без canManageProperty) получает 403 на всех трёх, как и
 *    на уже существующих операциях с фото этой карточки.
 *
 * Сетевой вызов рисования замокан (`ai/photoEnhance.js`) — прогон не должен
 * бить по реальному Google.
 */

const enhancePropertyPhoto = vi.fn();
vi.mock("../src/ai/photoEnhance.js", () => ({
  enhancePropertyPhoto: (photoId: string, requestedBy: string) => enhancePropertyPhoto(photoId, requestedBy),
}));

const request = (await import("supertest")).default;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let adminId = "";
let adminToken = "";
let outsiderId = "";
let outsiderToken = "";
const propertyIds: string[] = [];
const photoIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Улучшение-фото-${runId}` } })).id;

  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ улучшения ${runId}`,
      phone: `+992942${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminId = admin.id;
  const adminLogin = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(adminLogin.status).toBe(200);
  adminToken = adminLogin.body.accessToken as string;
  grantElevation(admin.id);

  // Рядовой агент БЕЗ отношения к объекту (не создатель, не назначенный,
  // не properties.viewAll) — эталон "чужого", которому положено 403.
  const outsider = await prisma.agent.create({
    data: {
      fullName: `Чужой агент ${runId}`,
      phone: `+992943${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  outsiderId = outsider.id;
  const outsiderLogin = await request(app).post("/api/v1/auth/login").send({ phone: outsider.phone, password });
  expect(outsiderLogin.status).toBe(200);
  outsiderToken = outsiderLogin.body.accessToken as string;
  grantElevation(outsider.id);
});

afterEach(async () => {
  enhancePropertyPhoto.mockReset();
  // Рубильник — на умолчание после каждого теста, чтобы порядок файлов в
  // прогоне не решал, включён он или нет у соседей (см. tests/setup.ts).
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyPhotoEnhanceEnabled: false } });
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { id: { in: photoIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, outsiderId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makePropertyWithPhoto() {
  const property = await prisma.property.create({
    data: {
      title: `Объект улучшения ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Тест ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      createdById: adminId,
    },
  });
  propertyIds.push(property.id);
  const photo = await prisma.propertyPhoto.create({
    data: {
      propertyId: property.id,
      url: `/uploads/orig-${runId}-${photoIds.length}.webp`,
      thumbUrl: `/uploads/thumbs/orig-${runId}-${photoIds.length}.webp`,
      order: 0,
    },
  });
  photoIds.push(photo.id);
  return { property, photo };
}

describe("POST /properties/:id/photos/:photoId/enhance — запуск", () => {
  it("403, пока Settings.propertyPhotoEnhanceEnabled выключен (умолчание)", async () => {
    const { property, photo } = await makePropertyWithPhoto();
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(enhancePropertyPhoto).not.toHaveBeenCalled();
  });

  it("запускает улучшение и возвращает обновлённое фото, когда рубильник включён", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyPhotoEnhanceEnabled: true } });
    const { property, photo } = await makePropertyWithPhoto();
    const enhanced = { ...photo, enhancedUrl: "/uploads/cand.webp", enhancedThumbUrl: "/uploads/thumbs/cand.webp" };
    enhancePropertyPhoto.mockResolvedValue({ ok: true, photo: enhanced, error: null, status: 200 });

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.enhancedUrl).toBe("/uploads/cand.webp");
    expect(enhancePropertyPhoto).toHaveBeenCalledWith(photo.id, adminId);
  });

  it("502 с человеческой причиной, когда рисование отказало", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyPhotoEnhanceEnabled: true } });
    const { property, photo } = await makePropertyWithPhoto();
    enhancePropertyPhoto.mockResolvedValue({ ok: false, photo: null, error: "Google ответил 503", status: 503 });

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Google ответил 503");
  });

  it("403 чужому агенту без canManageProperty, даже при включённом рубильнике", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyPhotoEnhanceEnabled: true } });
    const { property, photo } = await makePropertyWithPhoto();
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
    expect(enhancePropertyPhoto).not.toHaveBeenCalled();
  });
});

describe("POST /properties/:id/photos/:photoId/enhance/approve — одобрение", () => {
  it("переносит enhanced* в url/thumbUrl и бэкапит прежние значения в original*", async () => {
    const { property, photo } = await makePropertyWithPhoto();
    await prisma.propertyPhoto.update({
      where: { id: photo.id },
      data: { enhancedUrl: "/uploads/cand.webp", enhancedThumbUrl: "/uploads/thumbs/cand.webp" },
    });

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance/approve`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("/uploads/cand.webp");
    expect(res.body.thumbUrl).toBe("/uploads/thumbs/cand.webp");
    expect(res.body.originalUrl).toBe(photo.url);
    expect(res.body.originalThumbUrl).toBe(photo.thumbUrl);
    // Кандидат рассмотрен — поля ожидания решения обязаны опустеть, иначе
    // карточка сравнения осталась бы висеть в интерфейсе после одобрения.
    expect(res.body.enhancedUrl).toBeNull();
    expect(res.body.enhancedThumbUrl).toBeNull();
    expect(res.body.enhancedRequestedAt).toBeNull();
    expect(res.body.enhancedRequestedBy).toBeNull();
  });

  it("второе одобрение стирает с диска прошлую улучшенную версию, оригинал остаётся (№187)", async () => {
    const fsp = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const { uploadsDir } = await import("../src/upload.js");
    const { property, photo } = await makePropertyWithPhoto();
    const name = (suffix: string) => `enh-${runId}-${suffix}.webp`;
    const touch = async (file: string) => {
      await fsp.mkdir(pathMod.join(uploadsDir, "thumbs"), { recursive: true });
      await fsp.writeFile(pathMod.join(uploadsDir, file), "x");
      await fsp.writeFile(pathMod.join(uploadsDir, "thumbs", file), "x");
    };
    const exists = (file: string) => fsp.access(pathMod.join(uploadsDir, file)).then(() => true, () => false);
    const origFile = pathMod.basename(photo.url);
    for (const f of [origFile, name("v1"), name("v2")]) await touch(f);
    const approve = async (file: string) => {
      await prisma.propertyPhoto.update({
        where: { id: photo.id },
        data: { enhancedUrl: `/uploads/${file}`, enhancedThumbUrl: `/uploads/thumbs/${file}` },
      });
      return request(app)
        .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance/approve`)
        .set("Authorization", `Bearer ${adminToken}`);
    };

    expect((await approve(name("v1"))).status).toBe(200);
    expect(await exists(name("v1"))).toBe(true); // теперь это действующее фото
    expect((await approve(name("v2"))).status).toBe(200);

    expect(await exists(name("v1"))).toBe(false); // прежняя улучшенная версия — сирота
    expect(await exists(name("v2"))).toBe(true); // действующая
    expect(await exists(origFile)).toBe(true); // самый первый оригинал сохранён
    const after = await prisma.propertyPhoto.findUniqueOrThrow({ where: { id: photo.id } });
    expect(after.originalUrl).toBe(photo.url);
    await Promise.all([origFile, name("v2")].map((f) => fsp.rm(pathMod.join(uploadsDir, f), { force: true })));
  });

  it("409, когда одобрять нечего", async () => {
    const { property, photo } = await makePropertyWithPhoto();
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance/approve`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
  });

  it("403 чужому агенту без canManageProperty", async () => {
    const { property, photo } = await makePropertyWithPhoto();
    await prisma.propertyPhoto.update({
      where: { id: photo.id },
      data: { enhancedUrl: "/uploads/cand.webp", enhancedThumbUrl: "/uploads/thumbs/cand.webp" },
    });
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance/approve`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
    const unchanged = await prisma.propertyPhoto.findUnique({ where: { id: photo.id } });
    expect(unchanged?.url).toBe(photo.url);
  });
});

describe("POST /properties/:id/photos/:photoId/enhance/reject — отклонение", () => {
  it("чистит enhanced*-поля и НЕ трогает url/thumbUrl", async () => {
    const { property, photo } = await makePropertyWithPhoto();
    await prisma.propertyPhoto.update({
      where: { id: photo.id },
      data: {
        enhancedUrl: "/uploads/cand.webp",
        enhancedThumbUrl: "/uploads/thumbs/cand.webp",
        enhancedRequestedAt: new Date(),
        enhancedRequestedBy: adminId,
      },
    });

    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance/reject`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.enhancedUrl).toBeNull();
    expect(res.body.enhancedThumbUrl).toBeNull();
    expect(res.body.enhancedRequestedAt).toBeNull();
    expect(res.body.enhancedRequestedBy).toBeNull();
    // Действующее фото — то, что видит клиент/сайт — обязано остаться прежним.
    expect(res.body.url).toBe(photo.url);
    expect(res.body.thumbUrl).toBe(photo.thumbUrl);
  });

  it("403 чужому агенту без canManageProperty", async () => {
    const { property, photo } = await makePropertyWithPhoto();
    const res = await request(app)
      .post(`/api/v1/properties/${property.id}/photos/${photo.id}/enhance/reject`)
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
  });
});
