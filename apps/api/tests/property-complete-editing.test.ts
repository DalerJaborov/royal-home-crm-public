import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * «Готово» у монтажёра (спецификация, Этап 7/9): переводит объект в продажу и
 * публикует на сайт одной кнопкой, без ручного выбора статуса. В тестовой
 * среде SITE_SYNC_URL не настроен — маршрут честно возвращает 207 с
 * siteSyncError, а не притворяется, что публикация прошла.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let editorId: string;
let editorToken: string;
let agentId: string;
const propertyIds: string[] = [];
const extraAgentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Владелец 05.08.2026: минимум 6 фото обязателен, чтобы «Готово» сработало. */
async function addSixPhotos(propertyId: string) {
  await prisma.propertyPhoto.createMany({
    data: Array.from({ length: 6 }, (_, i) => ({
      propertyId,
      url: `/uploads/x${i}.webp`,
      thumbUrl: `/uploads/thumbs/x${i}.webp`,
      order: i,
    })),
  });
}

async function makeProperty(data: Partial<Parameters<typeof prisma.property.create>[0]["data"]> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Объект монтажа ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая монтаж, 1",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: agentId,
      createdById: agentId,
      instagramUrl: "https://instagram.com/reel/test",
      ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-монтаж-${runId}` } })).id;
  editorId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр теста", phone: `+992952${runId}`, role: "EDITOR", passwordHash },
    })
  ).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент монтажа", phone: `+992953${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  editorToken = await login(`+992952${runId}`);
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [editorId, agentId, ...extraAgentIds] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /properties/:id/complete-editing", () => {
  it("без фото — 409, статус не меняется", async () => {
    const p = await makeProperty({ instagramUrl: "https://instagram.com/reel/test" });
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/complete-editing`)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(409);
    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("EDITING");
  });

  it("без ссылки на видео — 409", async () => {
    const p = await makeProperty({ instagramUrl: null });
    await prisma.propertyPhoto.create({
      data: { propertyId: p.id, url: "/uploads/x.webp", thumbUrl: "/uploads/thumbs/x.webp" },
    });
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/complete-editing`)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(409);
  });

  it("не на этапе «Монтаж» — 409, даже если фото и видео уже есть", async () => {
    const p = await makeProperty({ status: "PENDING_REVIEW" });
    await prisma.propertyPhoto.create({
      data: { propertyId: p.id, url: "/uploads/x.webp", thumbUrl: "/uploads/thumbs/x.webp" },
    });
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/complete-editing`)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Монтаж/);
  });

  it("фото + видео — переводит в AVAILABLE (207, сайт не настроен в тесте)", async () => {
    const p = await makeProperty();
    await addSixPhotos(p.id);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/complete-editing`)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(207);
    expect(res.body.status).toBe("AVAILABLE");
    expect(res.body.siteSyncError).toBeTruthy();

    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("AVAILABLE");
  });

  it("вне PROPERTY_PIPELINE_STATUSES объект больше не считается в лимите активных (место освобождено)", async () => {
    // Свой агент-интейкер, без единого объекта до этого теста: остальные тесты
    // файла оставляют agentId с объектами в конвейере (тестируют именно отказы,
    // не завершение), и лимит=1 сразу упёрся бы в них, а не в объект этого теста.
    const passwordHash = await bcrypt.hash(password, 10);
    const freshAgent = await prisma.agent.create({
      data: { fullName: "Агент лимита монтажа", phone: `+992954${runId}`, role: "AGENT", passwordHash },
    });
    extraAgentIds.push(freshAgent.id);
    const freshAgentToken = await login(`+992954${runId}`);

    await prisma.settings.update({ where: { id: "singleton" }, data: { propertyActiveLimit: 1 } });
    try {
      const p = await makeProperty({ intakeAgentId: freshAgent.id, createdById: freshAgent.id });
      await addSixPhotos(p.id);
      // Лимит=1, у агента уже есть этот объект в конвейере — второй не пройдёт.
      const blocked = await request(app)
        .post("/api/v1/properties")
        .set("Authorization", `Bearer ${freshAgentToken}`)
        .send({
          type: "APARTMENT",
          areaSqm: 40,
          rooms: 1,
          floor: 2,
          totalFloors: 5,
          windowCount: 2,
          price: 200000,
          currency: "TJS",
          districtId,
          address: "Тестовая монтаж, лимит",
          condition: "GOOD",
          ownerContact: `+992937${runId}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
        });
      expect(blocked.status).toBe(409);

      await request(app)
        .post(`/api/v1/properties/${p.id}/complete-editing`)
        .set("Authorization", `Bearer ${editorToken}`);

      const afterFree = await request(app)
        .post("/api/v1/properties")
        .set("Authorization", `Bearer ${freshAgentToken}`)
        .send({
          type: "APARTMENT",
          areaSqm: 40,
          rooms: 1,
          floor: 2,
          totalFloors: 5,
          windowCount: 2,
          price: 200000,
          currency: "TJS",
          districtId,
          address: "Тестовая монтаж, лимит освобождён",
          condition: "GOOD",
          ownerContact: `+992937${runId}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
        });
      expect(afterFree.status).toBe(201);
      propertyIds.push(afterFree.body.id);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { propertyActiveLimit: 0 } });
    }
  });

  it("история объекта фиксирует переход (AuditLog)", async () => {
    const p = await makeProperty();
    await addSixPhotos(p.id);
    await request(app)
      .post(`/api/v1/properties/${p.id}/complete-editing`)
      .set("Authorization", `Bearer ${editorToken}`);
    // logAudit пишет вне запроса (best-effort): ждём саму запись, а не
    // фиксированные 200 мс — на загруженной машине эта ставка проигрывает.
    const entry = await waitFor(
      () => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_EDITING_DONE" } }),
      { label: "запись PROPERTY_EDITING_DONE в журнале действий" }
    );
    expect(entry).not.toBeNull();
  });
});
