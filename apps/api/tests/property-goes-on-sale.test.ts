import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Когда объект выходит в продажу.
 *
 * Правило владельца 02.08.2026: новый объект заводится НЕ в продаже и проходит
 * конвейер подготовки. Последний этап — монтажёр публикует видео-обзор в Instagram
 * и вставляет ссылку в карточку. Пока ссылки нет, объекта в продаже быть не может,
 * как бы ни хотелось выкатить его поскорее.
 *
 * Тесты стерегут ровно два места, где это ломается молча: маршрут создания (объект
 * снова начнёт появляться сразу «В продаже») и переход в AVAILABLE (проверку легко
 * обойти правкой статуса из списка).
 */

const runId = Date.now();
const password = "testpass123";

/** Владелец 05.08.2026: минимум 6 фото обязателен, чтобы объект мог покинуть подготовку. */
const SIX_PHOTOS = Array.from({ length: 6 }, (_, i) => ({
  url: `/uploads/x${i}.webp`,
  thumbUrl: `/uploads/thumbs/x${i}.webp`,
  order: i,
}));

let districtId: string;
let adminToken: string;
let adminId: string;
let intakeAgentId: string;
const propertyIds: string[] = [];

async function createViaApi(title: string) {
  const res = await request(app)
    .post("/api/v1/properties")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 2,
      floor: 3,
      totalFloors: 9,
      windowCount: 3,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
      title,
      // Руководитель обязан выбрать интейк-агента явно (роль AGENT сервер
      // подставляет сам) — иначе маршрут отвечает 400 ещё до всякой логики.
      // intakeAgentId должен указывать на действующего сотрудника с ролью
      // AGENT (assignableAgentError, shared.ts) — сам ADMIN не годится.
      intakeAgentId: intakeAgentId,
    });
  if (res.body?.id) propertyIds.push(res.body.id);
  return res;
}

/** Объект прямо в базе — так заводятся перенесённые объявления и фикстуры. */
async function seedProperty(data: Record<string, unknown>) {
  const property = await prisma.property.create({
    data: {
      title: `Готовый-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      ...data,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: `Готовность-${runId}` } });
  districtId = district.id;

  const admin = await prisma.agent.create({
    data: {
      fullName: "Админ готовности",
      phone: `+99290${runId.toString().slice(-7)}`,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;

  const intakeAgent = await prisma.agent.create({
    data: {
      fullName: "Интейк-агент готовности",
      phone: `+99291${runId.toString().slice(-7)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  intakeAgentId = intakeAgent.id;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone: `+99290${runId.toString().slice(-7)}` } });
  await prisma.agent.deleteMany({ where: { id: intakeAgentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Новый объект заводится не в продаже", () => {
  /**
   * НАХОДКА 12.09.2026 (сквозной тест добавления объекта на проде): объект без
   * фотографий раньше уходил сразу в PENDING_REVIEW — наличие фото при создании
   * не проверялось вовсе. На проде это дало два объекта с нулём фото в очереди
   * проверки маркетинга, просроченных на 7 и 17 дней, при том что стадия «Ждут
   * фото» показывала 0. createViaApi() здесь не передаёт draftId — фотографий у
   * объекта заведомо нет, и правильный статус теперь AWAITING_PHOTOS, а не
   * PENDING_REVIEW (см. routes/properties/crud.ts).
   */
  it("созданный через CRM без фото попадает в «Ждут фото», а не на проверку и не в продажу", async () => {
    const res = await createViaApi(`Новый-${runId}`);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("AWAITING_PHOTOS");
  });

  /** Умолчание КОЛОНКИ осталось AVAILABLE нарочно: конвейер — правило приёма через
   *  CRM, а не свойство таблицы. Иначе перенос старых объявлений и сиды оказались бы
   *  заперты в конвейере задним числом. */
  it("запись напрямую в базу конвейером не связана", async () => {
    const property = await seedProperty({});
    expect(property.status).toBe("AVAILABLE");
  });
});

describe("Выход в продажу требует видео", () => {
  it("без ссылки на Instagram переход в продажу отклоняется", async () => {
    const property = await seedProperty({ status: "EDITING" });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("видео-обзор");
  });

  it("без единой фотографии — тоже отклоняется", async () => {
    const property = await seedProperty({
      status: "EDITING",
      instagramUrl: "https://www.instagram.com/reel/abc123/",
    });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("фото меньше минимума");
  });

  it("есть 6 фото и ссылка — объект выходит в продажу", async () => {
    const property = await seedProperty({
      status: "EDITING",
      instagramUrl: "https://www.instagram.com/reel/abc123/",
      photos: { create: SIX_PHOTOS },
    });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE" });

    // Выход из монтажа списком идёт путём «Готово» (D7, 02.10.2026) — публикация
    // на сайт синхронная, в тесте сайт не настроен, и ответ честный 207 с
    // причиной, как у property-complete-editing.test.ts.
    expect(res.status).toBe(207);
    expect(res.body.status).toBe("AVAILABLE");
    expect(res.body.siteSyncError).toContain("не настроена");
  });

  /** Ссылку монтажёр обычно вставляет тем же действием, которым закрывает этап. */
  it("ссылка, присланная тем же запросом, засчитывается", async () => {
    const property = await seedProperty({
      status: "EDITING",
      photos: { create: SIX_PHOTOS },
    });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE", instagramUrl: "https://www.instagram.com/reel/xyz/" });

    // 207 — см. тест выше: сайт в тесте не настроен, объект при этом в продаже.
    expect(res.status).toBe(207);
    expect(res.body.status).toBe("AVAILABLE");
  });

  /**
   * ПРАВИЛО ВЛАДЕЛЬЦА 13.08.2026: телеграм-ссылка видео-обзором НЕ считается.
   *
   * До этого дня она проходила везде — поле заполнено, значит работа сделана. Стоило
   * это того, что бот отправлял такую ссылку клиенту в директ Instagram, где она не
   * открывается, а пересланный рилс по такой карточке не узнавался вовсе.
   */
  it("телеграм-ссылка вместо публикации в продажу не пускает", async () => {
    const property = await seedProperty({
      status: "EDITING",
      instagramUrl: "https://t.me/royalhome_tj/1234",
      photos: { create: SIX_PHOTOS },
    });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE" });

    expect(res.status).toBe(409);
    // Сообщение обязано отличаться от «нет ссылки»: поле на глазах заполнено, и
    // общая формулировка отправляла бы заполнять заполненное.
    expect(res.body.error).toContain("не на Instagram");
  });

  /**
   * НАХОДКА АУДИТА 13.09.2026: WITHDRAWN нарочно исключён из PROPERTY_PIPELINE_STATUSES
   * (это не этап подготовки — объект уже был в продаже и его сняли), но это не значит
   * «этому правилу не подчиняется». Раньше отсюда пропускался ВЕСЬ выход в продажу:
   * ни фото, ни ссылка на видео-обзор не проверялись, и правило моделировалось так,
   * будто снятый с продажи объект «уже был в продаже» в смысле этой проверки — хотя
   * ровно наоборот, он снова заходит в продажу «с нуля» и мог простоять снятым
   * месяцами, пока материалы протухали или не собирались вовсе. Тест раньше
   * (ошибочно) фиксировал именно этот пропуск как ожидаемое поведение.
   */
  it("возврат из «снят с продажи» без фото и ссылки в продажу не пускает", async () => {
    const property = await seedProperty({ status: "WITHDRAWN" });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("не готов к продаже");
  });

  it("возврат из «снят с продажи» с готовыми материалами проходит", async () => {
    const property = await seedProperty({
      status: "WITHDRAWN",
      instagramUrl: "https://www.instagram.com/reel/withdrawn-ready/",
      photos: { create: SIX_PHOTOS },
    });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "AVAILABLE" });

    expect([200, 207]).toContain(res.status);
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("AVAILABLE");
  });
});

describe("На сайт недоготовленный объект не уходит", () => {
  it("публикация объекта из конвейера отклоняется с указанием номера", async () => {
    const property = await seedProperty({ status: "AWAITING_VIDEO" });

    const res = await request(app)
      .post("/api/v1/properties/bulk-sync")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [property.id], action: "publish" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`№${property.shortId}`);
  });
});

/**
 * Очередь монтажёра: объекты без ссылки на видео-обзор.
 *
 * Тот же список отвечает на вопрос «почему бот не узнаёт пересланный рилс»:
 * узнавание ищет код поста среди Property.instagramUrl и ломается на пустом поле,
 * а не на слепоте модели.
 */
describe("Фильтр «без видео»", () => {
  it("показывает объекты без ссылки и без пустой строки, остальные прячет", async () => {
    const withVideo = await seedProperty({
      title: `С видео-${runId}`,
      instagramUrl: "https://www.instagram.com/reel/has-video/",
    });
    const noLink = await seedProperty({ title: `Без видео-${runId}` });
    const emptyLink = await seedProperty({ title: `Пустая ссылка-${runId}`, instagramUrl: "" });
    // Заполнено, но не тем. Раньше такой объект в очередь не попадал, и найти его
    // можно было только пролистав каталог глазами.
    const telegramLink = await seedProperty({
      title: `Телеграм вместо видео-${runId}`,
      instagramUrl: "https://t.me/royalhome_tj/1234",
    });

    const res = await request(app)
      .get(`/api/v1/properties?noVideo=1&q=${runId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(noLink.id);
    // Пустая строка — это «не заполнял», а не заполненное значение.
    expect(ids).toContain(emptyLink.id);
    expect(ids).toContain(telegramLink.id);
    expect(ids).not.toContain(withVideo.id);
  });
});
