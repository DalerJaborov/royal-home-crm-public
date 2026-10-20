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
 * ОБЪЕКТ НЕЛЬЗЯ ПРОВЕСТИ МИМО МАРКЕТИНГА ОБЫЧНЫМ PATCH (дыра 16.08.2026).
 *
 * Кнопки «Одобрить»/«Запросить новые» закрыты правом properties.moderate с
 * 05.08.2026, но PATCH /properties/:id проверял только canManageProperty: агент,
 * заведший объект, выбирал в списке статусов «Монтаж» — и карточка уходила мимо
 * проверки целиком (на проде так прошёл объект №20). Хуже того, этот переход слал
 * монтажёру пуш «фото и видео одобрены» про материалы, которых никто не видел.
 *
 * Стережём обе стороны: закрытые переходы отвергаются агенту (403) и остаются
 * доступны маркетингу, а работа агента внутри конвейера (вернуть объект на
 * проверку после доработки, закрыть монтаж выходом в продажу) не задета.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let agentToken: string;
let marketingId: string;
let marketingToken: string;
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
      url: `/uploads/bypass-${i}.webp`,
      thumbUrl: `/uploads/thumbs/bypass-${i}.webp`,
      order: i,
    })),
  });
}

async function makeProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Объект обхода ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая обхода, 1",
      condition: "GOOD",
      status: "PENDING_REVIEW",
      // Объект СВОЙ: агент проходит canManageProperty — отказ обязан прийти именно
      // от проверки прав конвейера, а не от «чужая карточка».
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
  districtId = (await prisma.district.create({ data: { name: `Тест-район-обход-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент обхода", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
  // Снова MARKETING: properties.moderate вернули маркетингу 04.09.2026 вместе
  // с удалением автомонтажа — см. packages/shared/permissions.ts.
  marketingId = (
    await prisma.agent.create({
      data: { fullName: "Модератор обхода", phone: `+992972${runId}`, role: "MARKETING", passwordHash },
    })
  ).id;
  agentIds.push(marketingId);

  agentToken = await login(`+992971${runId}`);
  marketingToken = await login(`+992972${runId}`);
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("PATCH /properties/:id не обходит проверку маркетинга", () => {
  it("АГЕНТ не может увести СВОЙ объект с проверки в монтаж", async () => {
    const p = await makeProperty();
    sendPushToAgents.mockClear();

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "EDITING" });

    expect(res.status).toBe(403);

    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("PENDING_REVIEW");

    // И монтажёру не улетело «фото и видео одобрены» — материалов никто не видел.
    await new Promise((r) => setTimeout(r, 50));
    expect(sendPushToAgents).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: `property-editing-${p.id}` })
    );
  });

  it("АГЕНТ не может выпустить объект с проверки прямо в продажу", async () => {
    // Материалы формально на месте (6 фото + ссылка) — блокеры выхода в продажу
    // пусты, и до 16.08.2026 такой PATCH проходил с кодом 200.
    const p = await makeProperty({ instagramUrl: "https://instagram.com/reel/bypass" });
    await addSixPhotos(p.id);

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "AVAILABLE" });

    expect(res.status).toBe(403);
    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("PENDING_REVIEW");
  });

  it("АГЕНТ не может сам вернуть свой объект на доработку (это решение маркетинга)", async () => {
    const p = await makeProperty();

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "AWAITING_PHOTOS" });

    expect(res.status).toBe(403);
  });

  it("MARKETING тот же переход выполняет", async () => {
    const p = await makeProperty();

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ status: "EDITING" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EDITING");
  });
});

describe("Работа агента внутри конвейера не задета", () => {
  /**
   * ССЫЛКА БОЛЬШЕ НЕ ВОЗВРАЩАЕТ ОБЪЕКТ НА ПРОВЕРКУ — так задумано конвейером видео
   * (коммит 2187ba7 «Конвейер видео: маркетинг одобряет сырые ролики, ссылку делает
   * монтажёр»).
   *
   * Здесь раньше проверялось обратное: агент вставлял ссылку в статусе «Ждём видео»,
   * и объект уходил в PENDING_REVIEW. Теперь работа агента на этом этапе — загрузить
   * СЫРОЙ РОЛИК, по нему маркетинг и одобряет видео; возврат на проверку привязан к
   * самой загрузке (симметрично фото) и покрыт отдельно —
   * property-review-cycle.test.ts, «загрузка нового видео возвращает объект на
   * проверку из AWAITING_VIDEO». Ссылка на Instagram осталась обязательной только на
   * выходе из монтажа в продажу, и вставляет её монтажёр в статусе EDITING.
   *
   * Тот коммит обновил два соседних теста, а этот файл пропустил — от него и упал CI.
   * Проверяем главное: PATCH агента не отвергается (его работу не сломали), но и
   * этап сам собой не перескакивает.
   */
  it("вставка ссылки в «Ждём видео» этап НЕ перескакивает — возврат теперь по загрузке ролика", async () => {
    const p = await makeProperty({ status: "AWAITING_VIDEO" });

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ instagramUrl: "https://instagram.com/reel/fixed-by-agent" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("AWAITING_VIDEO");
  });

  it("до одобрения агент ссылку на ролик не вставляет — пропуск в продажу мимо монтажа (23.09.2026)", async () => {
    for (const status of ["PENDING_REVIEW", "AWAITING_PHOTOS"] as const) {
      const p = await makeProperty({ status });
      const res = await request(app)
        .patch(`/api/v1/properties/${p.id}`)
        .set("Authorization", `Bearer ${agentToken}`)
        .send({ instagramUrl: "https://instagram.com/reel/too-early" });
      expect(res.status).toBe(403);
      const after = await prisma.property.findUnique({ where: { id: p.id } });
      expect(after?.instagramUrl ?? null).toBeNull();
    }
  });

  it("явный возврат на проверку после доработки фото агенту разрешён", async () => {
    const p = await makeProperty({ status: "AWAITING_PHOTOS" });

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "PENDING_REVIEW" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING_REVIEW");
  });

  it("выход из монтажа в продажу агенту по-прежнему доступен", async () => {
    const p = await makeProperty({ status: "EDITING", instagramUrl: "https://instagram.com/reel/done" });
    await addSixPhotos(p.id);

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "AVAILABLE" });

    // Сайт в тестовой среде не настроен — 207 с siteSyncError так же честен, как 200
    // (тот же приём, что в property-moderate-permission.test.ts).
    expect([200, 207]).toContain(res.status);
    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("AVAILABLE");
  });

  it("снять объект с подготовки агент может — публикацией это не грозит", async () => {
    const p = await makeProperty();

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "WITHDRAWN" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("WITHDRAWN");
  });
});

/**
 * НАХОДКА АУДИТА 13.09.2026: WITHDRAWN исключён из PROPERTY_PIPELINE_STATUSES (это
 * не этап подготовки), и requiresPropertyModeration читал это как «объект уже вышел
 * из подготовки — маркетинг тут ни при чём», хотя возврат ИМЕННО в AVAILABLE отсюда —
 * тот же вход в продажу «с нуля», что и выход из конвейера. Агент мог одним PATCH
 * вернуть снятый объект в продажу в обход и маркетинга, и проверки готовности
 * (материалы могли протухнуть за время, пока объект простоял снятым).
 */
describe("Возврат WITHDRAWN → AVAILABLE — тоже решение маркетинга", () => {
  it("АГЕНТ не может сам вернуть снятый объект в продажу, даже с готовыми материалами", async () => {
    const p = await makeProperty({ status: "WITHDRAWN", instagramUrl: "https://instagram.com/reel/withdrawn" });
    await addSixPhotos(p.id);

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "AVAILABLE" });

    expect(res.status).toBe(403);
    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("WITHDRAWN");
  });

  it("MARKETING тот же переход выполняет (материалы на месте)", async () => {
    const p = await makeProperty({ status: "WITHDRAWN", instagramUrl: "https://instagram.com/reel/withdrawn-mk" });
    await addSixPhotos(p.id);

    const res = await request(app)
      .patch(`/api/v1/properties/${p.id}`)
      .set("Authorization", `Bearer ${marketingToken}`)
      .send({ status: "AVAILABLE" });

    expect([200, 207]).toContain(res.status);
    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.status).toBe("AVAILABLE");
  });
});
