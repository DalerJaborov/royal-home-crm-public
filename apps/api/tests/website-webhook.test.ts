import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

const runId = Date.now();
const API_KEY = "test-website-key";

let agentId: string;
let createdClientIds: string[] = [];
let savedWorkHours: { workHoursStart: string; workHoursEnd: string } | null = null;
let listingDistrictId: string;
let listingPropertyId: string;

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  // Вне рабочих часов вебхук по задумке откладывает назначение агента до утра —
  // тест от времени суток зависеть не должен: раздвигаем окно на весь день.
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedWorkHours = { workHoursStart: settings.workHoursStart, workHoursEnd: settings.workHoursEnd };
  await prisma.settings.update({
    where: { id: "singleton" },
    // Круглые сутки — это "00:00"–"24:00", а НЕ "00:00"–"23:59": минута 23:59 у
    // второго остаётся закрытой, и тест падает одну минуту в сутки
    // (isWithinDushanbeWindow → false, заявка уходит в общую очередь без агента).
    // "00:00"–"00:00" тоже нельзя: у isWithinDushanbeWindow пустое окно значит
    // «никогда». Разбор — docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md.
    data: { workHoursStart: "00:00", workHoursEnd: "24:00" },
  });
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Вебхук Агент", phone: `+992880${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  listingDistrictId = (await prisma.district.create({ data: { name: `Вебхук-район-${runId}` } })).id;
  listingPropertyId = (
    await prisma.property.create({
      data: {
        title: `Объект вебхука ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 60000,
        currency: "USD",
        districtId: listingDistrictId,
        address: `Тест ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        publishedOnSite: true,
      },
    })
  ).id;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  if (savedWorkHours) {
    await prisma.settings.update({ where: { id: "singleton" }, data: savedWorkHours }).catch(() => {});
  }
  await prisma.interaction.deleteMany({ where: { clientId: { in: createdClientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.agent.delete({ where: { id: agentId } }).catch(() => {});
  await prisma.siteEditNotification.deleteMany({ where: { propertyId: listingPropertyId } });
  await prisma.property.delete({ where: { id: listingPropertyId } }).catch(() => {});
  await prisma.district.delete({ where: { id: listingDistrictId } }).catch(() => {});
});

describe("Webhook заявок с сайта", () => {
  it("отклоняет запрос без API-ключа", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .send({ fullName: "Сайт Тест", phone: `+992881${runId}` });
    expect(res.status).toBe(401);
  });

  it("отклоняет запрос с неверным ключом", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .set("X-Api-Key", "wrong-key")
      .send({ fullName: "Сайт Тест", phone: `+992881${runId}` });
    expect(res.status).toBe(401);
  });

  it("отклоняет невалидные данные (телефон-мусор)", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .set("X-Api-Key", API_KEY)
      .send({ fullName: "Сайт Тест", phone: "not-a-phone" });
    expect(res.status).toBe(400);
  });

  it("SYNC-02: номер из одних разделителей или с горстью цифр отклоняется и не создаёт клиента с телефоном «+»", async () => {
    for (const phone of ["-------", "()()()()", "+ - - - - -", "1-2-3-----"]) {
      const res = await request(app)
        .post("/api/v1/webhooks/website-lead")
        .set("X-Api-Key", API_KEY)
        .send({ fullName: "Мусорная Заявка", phone });
      expect(res.status, phone).toBe(400);
    }
    expect(await prisma.client.findUnique({ where: { phone: "+" } })).toBeNull();
    expect(await prisma.client.findUnique({ where: { phone: "+123" } })).toBeNull();
  });

  it("создаёт лида с источником WEBSITE и распределяет агенту", async () => {
    const phone = `+992881${runId}`;
    const res = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .set("X-Api-Key", API_KEY)
      .send({ fullName: "Сайт Тест", phone, comment: "Хочу 2-комн", rooms: 2 });
    // clientId забираем и регистрируем на очистку СРАЗУ, до дальнейших expect —
    // иначе упавшая позже проверка в этом же it оставляет запись в базе навсегда:
    // afterAll чистит только то, что попало в createdClientIds, а не то, что
    // реально создал вебхук.
    if (res.body?.clientId) createdClientIds.push(res.body.clientId);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);

    const client = await prisma.client.findUnique({ where: { phone } });
    expect(client).not.toBeNull();
    expect(client!.source).toBe("WEBSITE");
    expect(client!.desiredRooms).toBe(2);
    expect(client!.acceptedAt).toBeNull(); // лид ждёт принятия
    expect(client!.assignedAgentId).toBeTruthy();
  });

  it("повторная заявка того же телефона не создаёт дубля, а пишет взаимодействие", async () => {
    const phone = `+992881${runId}`;
    const res = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .set("X-Api-Key", API_KEY)
      .send({ fullName: "Сайт Тест", phone, comment: "Всё ещё интересно" });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);

    const clients = await prisma.client.findMany({ where: { phone } });
    expect(clients.length).toBe(1);

    // Запись и push теперь общие для всех каналов (createLeadFromChannel,
    // leads.ts) — до 11.08.2026 у сайта была своя отдельная запись, у бота и
    // Telegram не было вообще ничего.
    const repeatNote = await prisma.interaction.findFirst({
      where: { clientId: clients[0].id, notes: { contains: "Клиент снова обратился" } },
    });
    expect(repeatNote).not.toBeNull();
    expect(repeatNote?.notes).toContain("Всё ещё интересно");
  });

  /**
   * Хвост номера дополняется нулями до ШЕСТИ знаков намеренно.
   *
   * Было `${runId % 1000000}` — число без ведущих нулей, поэтому длина номера
   * плавала вместе с текущим временем. Раз в тысячу секунд остаток оказывался
   * трёхзначным, номер выходил ровно девятизначным, и normalizeDigits по праву
   * считал его МЕСТНЫМ — приписывал код страны второй раз (+992990001031). Тест
   * искал +990001031, не находил и падал с «expected null not to be null».
   *
   * Ловилось это примерно в одном прогоне из тысячи и выглядело как случайный
   * сбой стенда — ровно тот случай, когда падение списывают на «мигает» и
   * перезапускают. Фиксированная ширина убирает зависимость от времени суток.
   *
   * 08.09.2026: `runId % 1_000_000` сам по себе тоже небезопасен на постоянной
   * базе self-hosted раннера — это всего миллион корзин, и при частых прогонах
   * (несколько CI-запусков в день) `Date.now() % 1_000_000` двух разных запусков
   * иногда совпадает (день рождения-парадокс), да ещё старая запись могла
   * пережить прошлый прогон, если тот упал ДО того, как её id попал в
   * createdClientIds (см. фикс выше и ниже). Берём случайный хвост вместо
   * временного — как `Math.random()` в соседних тестах (agent-occupancy-shield,
   * lead-decline и др.) — и это не зависит от того, когда именно идёт прогон.
   */
  const phoneTail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");

  it("нормализует телефон с пробелами и скобками", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/website-lead")
      .set("X-Api-Key", API_KEY)
      .send({ fullName: "Формат Телефона", phone: `+992 (88) 2${phoneTail}` });
    if (res.body?.clientId) createdClientIds.push(res.body.clientId);
    expect(res.status).toBe(201);

    const client = await prisma.client.findUnique({ where: { phone: `+992882${phoneTail}` } });
    expect(client).not.toBeNull();
  });
});

describe("Webhook правки объекта на сайте (/site-listing-changed)", () => {
  it("повторная доставка того же события не плодит вторую запись в ленте правок", async () => {
    const payload = { externalId: listingPropertyId, action: "updated", changes: { price: 65000 }, editedBy: "admin" };

    const first = await request(app)
      .post("/api/v1/webhooks/site-listing-changed")
      .set("X-Api-Key", API_KEY)
      .send(payload);
    expect(first.status).toBe(201);

    // Админ сайта повторяет сохранение (плохая связь) — тот же вызов уходит второй раз.
    const second = await request(app)
      .post("/api/v1/webhooks/site-listing-changed")
      .set("X-Api-Key", API_KEY)
      .send(payload);
    expect(second.status).toBe(201);

    const notifications = await prisma.siteEditNotification.findMany({
      where: { propertyId: listingPropertyId },
    });
    expect(notifications.length).toBe(1);
  });

  it("другая правка того же объекта в том же окне не считается дублем", async () => {
    const different = await request(app)
      .post("/api/v1/webhooks/site-listing-changed")
      .set("X-Api-Key", API_KEY)
      .send({ externalId: listingPropertyId, action: "updated", changes: { price: 70000 }, editedBy: "admin" });
    expect(different.status).toBe(201);

    const notifications = await prisma.siteEditNotification.findMany({
      where: { propertyId: listingPropertyId },
    });
    expect(notifications.length).toBe(2);
  });
});

describe("Webhook объекта, созданного на сайте (/site-listing-upserted)", () => {
  const upsertPropertyIds: string[] = [];
  // Случайный, а не завязанный на runId (Date.now()): на постоянной базе
  // self-hosted раннера при частых прогонах `runId % 90_000_000` двух разных
  // запусков может совпасть (тот же класс проблемы, что у phoneTail выше), а
  // siteListingId у Property уникален — совпадение уронит POST /upserted с
  // конфликтом, который выглядит как сбой самого теста, а не изоляции.
  const newListingId = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  const deleteListingId = newListingId + 1;

  afterAll(async () => {
    await prisma.siteEditNotification.deleteMany({ where: { propertyId: { in: upsertPropertyIds } } });
    await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: upsertPropertyIds } } });
    await prisma.property.deleteMany({ where: { id: { in: upsertPropertyIds } } });
  });

  it("две параллельные доставки нового объекта не создают дубль и не падают 500", async () => {
    // Тот же кейс повтора, что у /website-lead: сайт не дождался ответа за таймаут,
    // пока первая доставка ещё выполняется, и шлёт тот же вебхук второй раз.
    const payload = {
      siteListingId: newListingId,
      action: "upserted",
      title: `Объект с сайта ${newListingId}`,
      location: `Тестовый адрес ${newListingId}`,
      price: 55000,
      area: 50,
    };

    const [first, second] = await Promise.all([
      request(app).post("/api/v1/webhooks/site-listing-upserted").set("X-Api-Key", API_KEY).send(payload),
      request(app).post("/api/v1/webhooks/site-listing-upserted").set("X-Api-Key", API_KEY).send(payload),
    ]);
    // Регистрируем на очистку сразу же по siteListingId, не дожидаясь проверок
    // ниже — упавший length-assert иначе оставляет объект в базе навсегда.
    for (const p of await prisma.property.findMany({ where: { siteListingId: newListingId }, select: { id: true } })) {
      upsertPropertyIds.push(p.id);
    }

    expect(first.status).not.toBe(500);
    expect(second.status).not.toBe(500);

    const properties = await prisma.property.findMany({ where: { siteListingId: newListingId } });
    expect(properties.length).toBe(1);
  });

  it("две параллельные доставки удаления не плодят два события DELETED", async () => {
    const created = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({
        siteListingId: deleteListingId,
        action: "upserted",
        title: `Объект на удаление ${deleteListingId}`,
        location: `Тестовый адрес ${deleteListingId}`,
        price: 40000,
        area: 40,
      });
    expect(created.status).toBe(201);
    upsertPropertyIds.push(created.body.propertyId);

    const [first, second] = await Promise.all([
      request(app)
        .post("/api/v1/webhooks/site-listing-upserted")
        .set("X-Api-Key", API_KEY)
        .send({ siteListingId: deleteListingId, action: "deleted" }),
      request(app)
        .post("/api/v1/webhooks/site-listing-upserted")
        .set("X-Api-Key", API_KEY)
        .send({ siteListingId: deleteListingId, action: "deleted" }),
    ]);
    expect(first.status).not.toBe(500);
    expect(second.status).not.toBe(500);

    const notifications = await prisma.siteEditNotification.findMany({
      where: { propertyId: created.body.propertyId, action: "DELETED" },
    });
    expect(notifications.length).toBe(1);
  });

  /**
   * Разведка 07.09.2026: удаление объекта вебхуком сайта писало `deletedAt`
   * в обход общей функции trashProperty — тот же класс бага, что у слияния
   * дубликатов клиента и запасного пути «не по делу». Заявка агента на удаление
   * этого же объекта оставалась PENDING и висела в Архиве, хотя объекта уже нет.
   */
  it("закрывает заявку агента на удаление, если объект удалили с сайта", async () => {
    const listingId = deleteListingId + 1;
    const created = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({
        siteListingId: listingId,
        action: "upserted",
        title: `Объект с заявкой на удаление ${listingId}`,
        location: `Тестовый адрес ${listingId}`,
        price: 45000,
        area: 45,
      });
    expect(created.status).toBe(201);
    const propertyId = created.body.propertyId as string;
    upsertPropertyIds.push(propertyId);

    const deleteRequest = await prisma.propertyDeleteRequest.create({
      data: { propertyId, requestedById: agentId, reason: "OWNER_CANCELLED" },
    });

    const res = await request(app)
      .post("/api/v1/webhooks/site-listing-upserted")
      .set("X-Api-Key", API_KEY)
      .send({ siteListingId: listingId, action: "deleted" });
    expect(res.status).toBe(200);

    const closed = await prisma.propertyDeleteRequest.findUnique({ where: { id: deleteRequest.id } });
    expect(closed?.status).toBe("APPROVED");
    expect(closed?.decidedById).toBeNull();
  });
});
