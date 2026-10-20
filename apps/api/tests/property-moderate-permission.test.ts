import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
const closeLeadPushNotification = vi.fn(async () => {});
const closeLeadPushNotifications = vi.fn(async () => {});
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  sendPushToAgents,
  closeLeadPushNotification,
  closeLeadPushNotifications,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

/**
 * Решения владельца 05.08.2026:
 *  1) одобрять/отклонять фото и видео объекта может строго properties.moderate
 *     (по умолчанию MARKETING/DIRECTOR/ADMIN) — обычный агент не должен мочь
 *     вызвать /review/approve и /review/reject даже для своего объекта;
 *  2) объект в EDITING с уже одобренными фото и видео публикуется САМ, как
 *     только монтажёр вписывает ссылку на Reels — без нажатия «Готово»;
 *  3) properties.moderate получает пуш, когда объект встаёт на проверку;
 *     properties.aiListing (EDITOR) получает пуш, когда объект уходит в монтаж.
 *  4) (ролевой аудит 06.08.2026) ответственный за объект получает пуш, когда
 *     объект наконец выходит в продажу (publishAfterEditingComplete) — раньше
 *     этот переход был единственным без единого уведомления;
 *  5) (ролевой аудит 06.08.2026) автовозврат «на проверку» после дозагрузки
 *     ФОТО тоже шлёт пуш properties.moderate — симметрично автовозврату по видео.
 *
 * Временное изъятие properties.moderate (23.08.2026, «на время автоматизации
 * монтажа/публикации одобряет только ADMIN») отменено полностью: у DIRECTOR —
 * 29.08.2026, у MARKETING — 04.09.2026 вместе с удалением автомонтажа. Тесты
 * ниже фиксируют восстановленную границу: MARKETING/DIRECTOR/ADMIN — 200,
 * рядовой агент — 403 даже на своём объекте.
 */

// Минимальный валидный PNG 1×1 — sharp должен суметь его обработать без
// настоящего файла-фикстуры (тот же приём, что и в property-review-cycle.test.ts).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let agentToken: string;
let marketingId: string;
let marketingToken: string;
let directorId: string;
let directorToken: string;
let adminId: string;
let adminToken: string;
const propertyIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function addSixPhotos(propertyId: string) {
  await prisma.propertyPhoto.createMany({
    data: Array.from({ length: 6 }, (_, i) => ({
      propertyId,
      url: `/uploads/mod-${i}.webp`,
      thumbUrl: `/uploads/thumbs/mod-${i}.webp`,
      order: i,
    })),
  });
}

/**
 * Сырой ролик агента — то, что маркетинг смотрит на проверке (владелец 17.08.2026).
 * До этого одобрение видео требовало ссылку на готовый Reels, то есть результат
 * работы монтажёра, которая идёт двумя этапами позже.
 */
async function addRawVideo(propertyId: string) {
  await prisma.propertyVideo.create({
    data: {
      propertyId,
      storageKey: `test/${propertyId}-${Math.round(performance.now())}.mp4`,
      filename: "obzor.mp4",
      sizeBytes: 1024,
      uploadedById: agentId,
    },
  });
}

async function makeProperty(data: Partial<Parameters<typeof prisma.property.create>[0]["data"]> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Объект модерации ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая модерация, 1",
      condition: "GOOD",
      status: "PENDING_REVIEW",
      intakeAgentId: agentId,
      createdById: agentId,
      ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-модерация-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент модерации", phone: `+992961${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
  marketingId = (
    await prisma.agent.create({
      data: { fullName: "Маркетинг модерации", phone: `+992962${runId}`, role: "MARKETING", passwordHash },
    })
  ).id;
  agentIds.push(marketingId);
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор модерации", phone: `+992963${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(directorId);
  adminId = (
    await prisma.agent.create({
      data: { fullName: "Админ модерации", phone: `+992964${runId}`, role: "ADMIN", passwordHash },
    })
  ).id;
  agentIds.push(adminId);

  agentToken = await login(`+992961${runId}`);
  marketingToken = await login(`+992962${runId}`);
  directorToken = await login(`+992963${runId}`);
  adminToken = await login(`+992964${runId}`);
});

afterAll(async () => {
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("POST /properties/:id/review/approve и /reject — право properties.moderate", () => {
  it("АГЕНТ получает 403 на approve даже для своего объекта", async () => {
    const p = await makeProperty();
    await addSixPhotos(p.id);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ material: "photos" });
    expect(res.status).toBe(403);

    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.photosApprovedAt).toBeNull();
  });

  it("АГЕНТ получает 403 на reject даже для своего объекта", async () => {
    const p = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/reject`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ material: "photos", reason: "Не то" });
    expect(res.status).toBe(403);
  });

  it("MARKETING снова может одобрить: право вернули 04.09.2026 вместе с удалением автомонтажа", async () => {
    const p = await makeProperty();
    await addSixPhotos(p.id);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ material: "photos" });
    expect(res.status).toBe(200);
    expect(res.body.photosApprovedAt).toBeTruthy();
  });

  it("DIRECTOR снова может отклонить: право вернули 29.08.2026", async () => {
    /**
     * Временное изъятие properties.moderate у директора (23.08.2026, на время
     * автоматизации монтажа) отменено 29.08.2026 коммитом «Вернуть DIRECTOR право
     * одобрять готовый Reels-ролик» (6b39a687). Тест тогда обновить забыли, и он
     * падал ещё до работ 30.08 — то же самое было в permissions.test.ts.
     */
    const p = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/reject`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ material: "photos", reason: "Переснять" });
    expect(res.status).toBe(200);
  });

  it("ADMIN получает 200 на approve", async () => {
    const p = await makeProperty();
    await addSixPhotos(p.id);
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ material: "photos" });
    expect(res.status).toBe(200);
    expect(res.body.photosApprovedAt).toBeTruthy();
  });

  it("ADMIN получает 200 на reject", async () => {
    const p = await makeProperty();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/reject`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ material: "photos", reason: "Переснять" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("AWAITING_PHOTOS");
  });
});

describe("Автопубликация из EDITING после ссылки на видео (решение владельца 05.08.2026)", () => {
  it("объект в EDITING с одобренными фото и видео и добавленной instagramUrl публикуется сам", async () => {
    const now = new Date();
    const p = await makeProperty({
      status: "EDITING",
      instagramUrl: null,
      photosApprovedAt: now,
      videoApprovedAt: now,
    });
    await addSixPhotos(p.id);

    sendPushToAgent.mockClear();
    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ instagramUrl: "https://instagram.com/reel/auto-publish-test" });

    // Сайт в тестовой среде не настроен (SITE_SYNC_URL) — как и у ручной кнопки
    // «Готово» (см. property-complete-editing.test.ts), это честные 207 с
    // siteSyncError, но статус в CRM уже должен смениться на AVAILABLE.
    expect([200, 207]).toContain(res.status);
    expect(res.body.status).toBe("AVAILABLE");

    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("AVAILABLE");

    // Ролевой аудит 06.08.2026: ответственный (intakeAgentId, тут это agentId)
    // получает пуш «объект в продаже» — раньше этот переход не слал ничего.
    await new Promise((r) => setTimeout(r, 50));
    expect(sendPushToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({ tag: `property-published-${p.id}` }));
  });

  it("объект в EDITING без минимума фото НЕ публикуется сам при добавлении ссылки", async () => {
    const p = await makeProperty({ status: "EDITING", instagramUrl: null });
    // Фото не добавляем — blockersForSale (минимум 6 фото) не должен обнулиться.

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ instagramUrl: "https://instagram.com/reel/not-ready" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EDITING");
  });
});

describe("Пуш-уведомления конвейера", () => {
  /**
   * НАХОДКА 12.09.2026: этот тест раньше проверял, что пуш «на проверку»
   * уходит при ЛЮБОМ создании объекта — под старым (ошибочным) поведением
   * объект без единой фотографии всё равно вставал в PENDING_REVIEW. После
   * починки (routes/properties/crud.ts) объект без фото при создании уходит в
   * AWAITING_PHOTOS, и пушить маркетингу нечего проверять — моделировать это
   * здесь незачем: пуш при РЕАЛЬНОМ попадании на проверку уже проверен ниже
   * («автовозврат после дозагрузки фото», где статус доходит до PENDING_REVIEW
   * по-настоящему и пуш действительно уходит).
   */
  it("создание объекта без фото не шлёт пуш «на проверку» — проверять там нечего", async () => {
    sendPushToAgents.mockClear();
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${agentToken}`)
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
        address: "Тестовая модерация, пуш",
        condition: "GOOD",
        ownerContact: `+992937${runId}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
      });
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);
    expect(res.body.status).toBe("AWAITING_PHOTOS");
    await new Promise((r) => setTimeout(r, 50));
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });

  it("вызывается пуш, когда объект уходит в монтаж (approve второго материала)", async () => {
    // Ссылки на Reels здесь НЕТ нарочно: её делает монтажёр уже после этого перехода.
    const p = await makeProperty();
    await addSixPhotos(p.id);
    await addRawVideo(p.id);
    await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ material: "photos" });

    sendPushToAgents.mockClear();
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/review/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ material: "video" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EDITING");
    await new Promise((r) => setTimeout(r, 50));
    expect(sendPushToAgents).toHaveBeenCalled();
  });

  /**
   * Ролевой аудит 06.08.2026: автовозврат «на проверку» после дозагрузки ФОТО
   * (POST /:id/photos) раньше не слал пуш properties.moderate, хотя тот же
   * автовозврат по ВИДЕО (videoAutoRevert в PATCH /:id) — слал. Маркетинг узнавал
   * о новой работе, только заглянув в список руками.
   */
  it("вызывается пуш properties.moderate при автовозврате после дозагрузки фото", async () => {
    const p = await makeProperty({ status: "AWAITING_PHOTOS", instagramUrl: "https://instagram.com/reel/push-photos" });
    await addSixPhotos(p.id); // уже 6 — следующая же загрузка перейдёт порог

    sendPushToAgents.mockClear();
    const uploadRes = await request(app)
      .post(`/api/v1/properties/${p.id}/photos`)
      .set("Authorization", `Bearer ${agentToken}`)
      .attach("photos", TINY_PNG, "new.png");
    expect(uploadRes.status).toBe(201);

    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("PENDING_REVIEW");

    await new Promise((r) => setTimeout(r, 50));
    expect(sendPushToAgents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: `property-pending-review-${p.id}` })
    );
  });
});
