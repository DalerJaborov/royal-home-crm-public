import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Продавец при создании объекта (владелец 21.08.2026: «если продавца нет —
 * например сосед — создать его прямо при добавлении объекта; если есть —
 * выбрать из своего списка; привязка без ограничений»).
 *
 * Три правила этого файла:
 *  1) sellerName + ownerContact на ЛЮБОМ объекте (не только offSite) заводят
 *     карточку Client{kind: SELLER} и связывают её через sellerClientId;
 *  2) существующая карточка с тем же номером НЕ дублируется — даже если она
 *     заведена ПОКУПАТЕЛЕМ (бот часто ошибается с kind): unique(phone) раньше
 *     ронял всё создание объекта;
 *  3) выбранная карточка (clientId) сама даёт «Контакт владельца»: агент без
 *     права clients.viewPhone видит номер замаскированным, и эти точки не
 *     должны попадать в ownerContact.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

/**
 * Дубли по адресу при создании (routes/properties/crud.ts, Пачка 9) режут
 * второй объект с тем же районом+адресом+этажом+площадью ±2 м² — этот файл
 * заводит несколько объектов у одного продавца, каждому нужен свой адрес,
 * иначе второй и последующие ловят 409 вместо 201.
 */
let addressCounter = 0;
function propertyPayload(extra: Record<string, unknown>) {
  addressCounter += 1;
  return {
    type: "APARTMENT",
    areaSqm: 50,
    rooms: 2,
    floor: 4,
    totalFloors: 9,
    windowCount: 2,
    price: 300000,
    currency: "TJS",
    districtId,
    address: `Тестовая, продавец-автосоздание ${runId}-${addressCounter}`,
    condition: "GOOD",
    ...extra,
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-продавец-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент автосоздания продавца", phone: `+992962${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.district.delete({ where: { id: districtId } });
});

describe("продавец при создании объекта", () => {
  it("обычный (не offSite) объект с именем и телефоном заводит карточку продавца", async () => {
    const phone = `+992901${String(runId).slice(-6)}1`;
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ ownerContact: phone, sellerName: "Сосед Валиджон" }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);

    const created = await prisma.property.findUnique({
      where: { id: res.body.id },
      select: { sellerClientId: true, offSite: true },
    });
    expect(created?.offSite).toBe(false);
    expect(created?.sellerClientId).toBeTruthy();

    const seller = await prisma.client.findUnique({ where: { id: created!.sellerClientId! } });
    expect(seller?.kind).toBe("SELLER");
    expect(seller?.fullName).toBe("Сосед Валиджон");
    clientIds.push(seller!.id);
  });

  it("существующая карточка ПОКУПАТЕЛЯ с тем же номером привязывается, а не дублируется", async () => {
    const phone = `+992902${String(runId).slice(-6)}2`;
    const buyer = await prisma.client.create({
      data: {
        fullName: `Покупатель-он-же-продавец ${runId}`,
        phone,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(buyer.id);

    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ ownerContact: phone, sellerName: "Имя из формы" }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);

    const created = await prisma.property.findUnique({
      where: { id: res.body.id },
      select: { sellerClientId: true },
    });
    // Привязана СУЩЕСТВУЮЩАЯ карточка — второй Client с тем же номером не появился.
    expect(created?.sellerClientId).toBe(buyer.id);
    const sameNumber = await prisma.client.count({ where: { phone } });
    expect(sameNumber).toBe(1);
  });

  it("выбранная карточка даёт настоящий номер вместо замаскированного и ownerContact можно не заполнять", async () => {
    const phone = `+992903${String(runId).slice(-6)}3`;
    const seller = await prisma.client.create({
      data: {
        fullName: `Продавец по карточке ${runId}`,
        phone,
        source: "WHATSAPP",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(seller.id);

    // Ровно то, что раньше уезжало с формы у агента без clients.viewPhone.
    const masked = "+992•••••93";
    const withMasked = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ clientId: seller.id, ownerContact: masked }));
    expect(withMasked.status).toBe(201);
    propertyIds.push(withMasked.body.id);
    const savedMasked = await prisma.property.findUnique({
      where: { id: withMasked.body.id },
      select: { ownerContact: true, sellerClientId: true },
    });
    expect(savedMasked?.sellerClientId).toBe(seller.id);
    expect(savedMasked?.ownerContact).toBe(phone);

    // Совсем без ownerContact — схема пропускает, сервер берёт номер из карточки.
    const withoutContact = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ clientId: seller.id }));
    expect(withoutContact.status).toBe(201);
    propertyIds.push(withoutContact.body.id);
    const savedEmpty = await prisma.property.findUnique({
      where: { id: withoutContact.body.id },
      select: { ownerContact: true },
    });
    expect(savedEmpty?.ownerContact).toBe(phone);
  });

  it("у одного продавца может быть несколько объектов", async () => {
    const phone = `+992904${String(runId).slice(-6)}4`;
    const first = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ ownerContact: phone, sellerName: "Многоквартирный Рустам" }));
    expect(first.status).toBe(201);
    propertyIds.push(first.body.id);
    const second = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ ownerContact: phone, sellerName: "Многоквартирный Рустам", address: `Вторая, ${runId}` }));
    expect(second.status).toBe(201);
    propertyIds.push(second.body.id);

    const a = await prisma.property.findUnique({ where: { id: first.body.id }, select: { sellerClientId: true } });
    const b = await prisma.property.findUnique({ where: { id: second.body.id }, select: { sellerClientId: true } });
    expect(a?.sellerClientId).toBeTruthy();
    expect(a?.sellerClientId).toBe(b?.sellerClientId);
    clientIds.push(a!.sellerClientId!);

    /**
     * БЕЗ ИМЕНИ КАРТОЧКА ВСЁ РАВНО ЗАВОДИТСЯ (владелец 09.09.2026). Раньше
     * привязка требовала И имени, И телефона, а имя в форме необязательно: агент
     * вписывал номер, имя оставлял пустым — объект оставался «ничьим», и тревога
     * «продавец без объекта» била по добросовестному человеку. Телефон обязателен
     * всегда, значит привязать есть по чему; имя ставится заглушкой.
     */
    const nameless = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ ownerContact: `+992905${String(runId).slice(-6)}5` }));
    expect(nameless.status).toBe(201);
    propertyIds.push(nameless.body.id);
    const savedNameless = await prisma.property.findUnique({
      where: { id: nameless.body.id },
      select: { sellerClientId: true },
    });
    expect(savedNameless?.sellerClientId).toBeTruthy();
    clientIds.push(savedNameless!.sellerClientId!);
    const placeholder = await prisma.client.findUnique({
      where: { id: savedNameless!.sellerClientId! },
      select: { fullName: true, kind: true },
    });
    expect(placeholder?.kind).toBe("SELLER");
    expect(placeholder?.fullName).toBe("Собственник объекта");
  });

  it("номер продавца у карточки в Корзине — объект создаётся и привязывается к ней, а не падает 500 (23.09.2026)", async () => {
    // Поиск живой карточки её не видит (deletedAt IS NULL), создание новой
    // упирается в unique(phone). Раньше запасной поиск шёл внутри той же,
    // уже сорванной транзакции базы — и всё создание объекта падало 500.
    const phone = `+992913${String(runId).slice(-6)}`;
    await prisma.client.deleteMany({ where: { phone } });
    const trashed = await prisma.client.create({
      data: {
        fullName: `Продавец в Корзине ${runId}`,
        phone,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        deletedAt: new Date(),
      },
    });
    clientIds.push(trashed.id);

    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${token}`)
      .send(propertyPayload({ ownerContact: phone, sellerName: "Тот же продавец" }));
    expect(res.status).toBe(201);
    propertyIds.push(res.body.id);

    const created = await prisma.property.findUnique({ where: { id: res.body.id }, select: { sellerClientId: true } });
    expect(created?.sellerClientId).toBe(trashed.id);
    expect(await prisma.client.count({ where: { phone } })).toBe(1);
  });
});
