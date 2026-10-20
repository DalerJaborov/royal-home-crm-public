import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { DEFAULT_EVENT_POINTS } from "../src/lib/scoreJournal.js";
import { revertToReviewAfterVideoUpload } from "../src/lib/propertyPipeline.js";

/**
 * Цикл проверки материалов объекта (спецификация, Этап 6): «Одобрить фото» /
 * «Запросить новые» — кнопки вместо выпадающего списка статусов. Раздельно по
 * фото и видео; когда одобрены оба — объект уходит в монтаж (EDITING).
 */

const runId = Date.now();
const password = "testpass123";

// Минимальный валидный PNG 1×1 — sharp должен суметь его обработать без
// настоящего файла-фикстуры.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let districtId: string;
let marketingId: string;
let marketingToken: string;
let agentId: string;
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeProperty(withPhoto: boolean, withVideo: boolean) {
  const p = await prisma.property.create({
    data: {
      title: `Объект проверки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "PENDING_REVIEW",
      intakeAgentId: agentId,
      createdById: agentId,
    },
  });
  propertyIds.push(p.id);
  /**
   * «Видео есть» на проверке — это СЫРЫЕ РОЛИКИ агента, а не ссылка на Reels
   * (владелец 17.08.2026): ссылку вставляет монтажёр уже после одобрения. Раньше
   * здесь заполнялся instagramUrl, и тесты закрепляли вывернутый порядок этапов.
   */
  if (withVideo) {
    await prisma.propertyVideo.create({
      data: {
        propertyId: p.id,
        storageKey: `test/${p.id}.mp4`,
        filename: "obzor.mp4",
        sizeBytes: 1024,
        uploadedById: agentId,
      },
    });
  }
  if (withPhoto) {
    // Владелец 05.08.2026: минимум 6 фото обязателен, чтобы объект прошёл проверку.
    await prisma.propertyPhoto.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        propertyId: p.id,
        url: `/uploads/x${i}.webp`,
        thumbUrl: `/uploads/thumbs/x${i}.webp`,
        order: i,
      })),
    });
  }
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-проверка-${runId}` } })).id;
  // Снова MARKETING: properties.moderate вернули маркетингу 04.09.2026 вместе
  // с удалением автомонтажа — см. packages/shared/permissions.ts.
  marketingId = (
    await prisma.agent.create({
      data: { fullName: "Модератор проверки", phone: `+992950${runId}`, role: "MARKETING", passwordHash },
    })
  ).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент проверки", phone: `+992951${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  marketingToken = await login(`+992950${runId}`);
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [marketingId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

// kind обязателен: property_reworked и property_rework_fixed намеренно делят
// один sourceId (одна и та же передача, два события её жизни) — без фильтра по
// kind findFirst мог бы вернуть любую из двух строк.
async function waitForEvent(sourceId: string, kind?: string): Promise<{ delta: number; kind: string } | null> {
  for (let i = 0; i < 50; i++) {
    const found = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId, ...(kind ? { kind } : {}) } });
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe("Одобрение фото и видео", () => {
  it("нельзя одобрить фото, если их нет ни одной", async () => {
    const p = await makeProperty(false, true);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "photos" });
    expect(res.status).toBe(409);
  });

  it("одобрение с первого раза начисляет photos_approved_first_try; объект остаётся на проверке, пока не одобрено видео", async () => {
    const p = await makeProperty(true, true);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "photos" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING_REVIEW");
    expect(res.body.photosApprovedAt).not.toBeNull();

    const event = await waitForEvent(`${p.id}-photos-approved`);
    expect(event?.kind).toBe("photos_approved_first_try");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.photos_approved_first_try);
  });

  it("одобрение обоих материалов переводит объект в EDITING", async () => {
    const p = await makeProperty(true, true);
    await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "photos" });
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "video" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EDITING");
  });

  it("возврат фото на доработку — property_reworked, статус AWAITING_PHOTOS", async () => {
    const p = await makeProperty(true, true);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/reject`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "photos", reason: "Тёмные, переснять при дневном свете" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("AWAITING_PHOTOS");
    expect(res.body.reviewRejectionReason).toContain("переснять");

    const event = await waitForEvent(`reject-${p.id}-photos-1`);
    expect(event?.kind).toBe("property_reworked");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.property_reworked);
  });

  it("повторная загрузка фото возвращает объект на проверку и начисляет property_rework_fixed", async () => {
    const p = await makeProperty(true, true);
    await request(app)
      .post(`/api/v1/properties/${p.id}/review/reject`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "photos", reason: "Переснять" });

    const uploadRes = await request(app)
      .post(`/api/v1/properties/${p.id}/photos`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .attach("photos", TINY_PNG, "new.png");
    expect(uploadRes.status).toBe(201);

    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("PENDING_REVIEW");
    expect(after?.reviewRejectionReason).toBeNull();

    // Тот же sourceId, что у reworked, но kind — rework_fixed: дедуп по (kind,
    // sourceId) не мешает записать оба события одной парой.
    const fixedEvent = await waitForEvent(`reject-${p.id}-photos-1`, "property_rework_fixed");
    expect(fixedEvent).not.toBeNull();
    expect(fixedEvent?.delta).toBe(DEFAULT_EVENT_POINTS.property_rework_fixed);
  });

  /**
   * Ждут на этом этапе НОВЫЕ РОЛИКИ агента, а не ссылку (владелец 17.08.2026).
   * Пока возврат был привязан к вставке ссылки, агент мог переснять и залить видео,
   * а объект навсегда оставался «Ждём видео»: ссылку делает монтажёр, и позже.
   */
  it("загрузка нового видео возвращает объект на проверку из AWAITING_VIDEO", async () => {
    const p = await makeProperty(true, false);
    await request(app)
      .post(`/api/v1/properties/${p.id}/review/reject`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "video", reason: "Плохой звук" });

    await prisma.propertyVideo.create({
      data: {
        propertyId: p.id,
        storageKey: `test/${p.id}-fixed.mp4`,
        filename: "obzor-2.mp4",
        sizeBytes: 2048,
        uploadedById: agentId,
      },
    });
    await revertToReviewAfterVideoUpload(await prisma.property.findUniqueOrThrow({ where: { id: p.id } }));

    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("PENDING_REVIEW");
    expect(after?.reviewRejectionReason).toBeNull();

    const event = await waitForEvent(`reject-${p.id}-video-1`, "property_rework_fixed");
    expect(event).not.toBeNull();
  });

  it("одобрение после возврата на доработку НЕ начисляет «с первого раза»", async () => {
    const p = await makeProperty(true, true);
    await request(app)
      .post(`/api/v1/properties/${p.id}/review/reject`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "video", reason: "Плохой звук" });
    // Агент переснял: объект возвращается на проверку сам, ролики уже лежат
    // (makeProperty(true, true) — «видео есть» это загруженные ролики, не ссылка).
    await revertToReviewAfterVideoUpload(await prisma.property.findUniqueOrThrow({ where: { id: p.id } }));

    await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "video" });

    const firstTryEvent = await waitFor(
      () => prisma.royalScoreEvent.findFirst({
      where: { agentId, sourceId: `${p.id}-video-approved`, kind: "video_approved_first_try" },
    }),
      { label: "балл Royal Score" }
    ).catch(() => null);
    expect(firstTryEvent).toBeNull();
  });

  it("на объекте не на проверке одобрить/отклонить нельзя", async () => {
    const p = await makeProperty(true, true);
    await prisma.property.update({ where: { id: p.id }, data: { status: "AVAILABLE" } });
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "photos" });
    expect(res.status).toBe(409);
  });
});
