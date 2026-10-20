import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { createLeadFromChannel } from "../src/leads.js";
import { StaffPhoneLeadError, STAFF_PHONE_ERROR_CODE } from "../src/lib/staffPhoneGuard.js";

/**
 * НОМЕР СОТРУДНИКА — НЕ НОМЕР КЛИЕНТА (прод, 14.09.2026, см. lib/staffPhoneGuard.ts).
 * Агент Маъруф позвонил в офис со своего номера «пошутить» — CRM завела клиента и
 * поставила его же номер продавцом в два объекта. Эти тесты стерегут все входы,
 * которыми номер сотрудника мог попасть в карточку клиента или в контакт продавца.
 */

const runId = Date.now();
const t = String(runId).slice(-6);
const password = "testpass123";

// Тот же номер сотрудника в трёх формах записи — ровно то, что сравнение по
// хвосту (phoneTail) обязано считать одним и тем же номером.
const staffDigits = `900${t}`; // 9 цифр
const staffPhoneBare = staffDigits; // "900123456"
const staffPhonePlus = `+992${staffDigits}`; // "+992900123456"
const staffPhoneSpaced = `992 ${staffDigits.slice(0, 3)} ${staffDigits.slice(3, 6)} ${staffDigits.slice(6)}`; // "992 900 123 456"

const firedDigits = `901${t}`;
const firedPhonePlus = `+992${firedDigits}`;

const clientIds: string[] = [];
const propertyIds: string[] = [];
let districtId: string;
let staffAgentId: string;
let firedAgentId: string;
let guardAdminId: string;
let adminToken: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);

  const staffAgent = await prisma.agent.create({
    data: { fullName: `Сотрудник-номер ${runId}`, phone: staffPhonePlus, role: "AGENT", passwordHash, isActive: true },
  });
  staffAgentId = staffAgent.id;

  const fired = await prisma.agent.create({
    data: { fullName: `Уволенный ${runId}`, phone: firedPhonePlus, role: "AGENT", passwordHash, isActive: false },
  });
  firedAgentId = fired.id;

  const admin = await prisma.agent.create({
    data: { fullName: `Админ гварда ${runId}`, phone: `+992999${t}`, role: "ADMIN", passwordHash },
  });
  guardAdminId = admin.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken as string;

  districtId = (await prisma.district.create({ data: { name: `Тест-район-гвард-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([staffAgentId, firedAgentId, guardAdminId]);
  await prisma.$disconnect();
});

describe("POST /clients — номер действующего сотрудника", () => {
  it.each([
    ["без кода страны", staffPhoneBare],
    ["с плюсом и кодом страны", staffPhonePlus],
    ["с пробелами, без плюса", staffPhoneSpaced],
  ])("отбивается 409 независимо от формы записи (%s)", async (_label, phone) => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: `Кто-то ${runId}`, phone, source: "WALK_IN" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(STAFF_PHONE_ERROR_CODE);
    expect(res.body.error).toContain(`Сотрудник-номер ${runId}`);
    const created = await prisma.client.findFirst({ where: { phone }, select: { id: true } });
    expect(created).toBeNull();
  });

  it("уволенный сотрудник (isActive=false) не блокирует создание", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: `Клиент бывшего сотрудника ${runId}`, phone: firedPhonePlus, source: "WALK_IN" });
    expect(res.status).toBe(201);
    clientIds.push(res.body.id);
  });
});

describe("PATCH /clients/:id — номер сотрудника в extraPhones", () => {
  it("409, карточка не меняется", async () => {
    const created = await prisma.client.create({
      data: {
        fullName: `Правка запасного ${runId}`,
        phone: `+992903${t}`,
        source: "WALK_IN",
        assignedAgentId: staffAgentId, // сам сотрудник ведёт эту карточку — не мешает проверке номера
        acceptedAt: new Date(),
      },
    });
    clientIds.push(created.id);

    const res = await request(app)
      .patch(`/api/v1/clients/${created.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ extraPhones: [staffPhonePlus] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(STAFF_PHONE_ERROR_CODE);

    const after = await prisma.client.findUnique({ where: { id: created.id }, select: { extraPhones: true } });
    expect(after?.extraPhones).toEqual([]);
  });
});

describe("POST /properties — ownerContact на номер сотрудника", () => {
  it("409 до транзакции, Client SELLER не создан", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "APARTMENT",
        areaSqm: 50,
        rooms: 2,
        floor: 3,
        totalFloors: 9,
        windowCount: 3,
        price: 300000,
        currency: "TJS",
        districtId,
        address: `Тест гвард-объект ${runId}`,
        condition: "GOOD",
        ownerContact: staffPhonePlus,
        intakeAgentId: staffAgentId,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(STAFF_PHONE_ERROR_CODE);
    if (res.body?.id) propertyIds.push(res.body.id);

    const sellerCard = await prisma.client.findFirst({ where: { phone: staffPhonePlus }, select: { id: true } });
    expect(sellerCard).toBeNull();
    const property = await prisma.property.findFirst({ where: { address: `Тест гвард-объект ${runId}` } });
    expect(property).toBeNull();
  });
});

describe("createLeadFromChannel — номер сотрудника", () => {
  it("карточка не заводится, бросает StaffPhoneLeadError", async () => {
    await expect(
      createLeadFromChannel({
        fullName: `Лид с номером сотрудника ${runId}`,
        phone: staffPhonePlus,
        source: "INSTAGRAM",
      })
    ).rejects.toBeInstanceOf(StaffPhoneLeadError);

    const created = await prisma.client.findFirst({ where: { phone: staffPhonePlus }, select: { id: true } });
    expect(created).toBeNull();
  });
});

/**
 * СТАРЫЕ ЗАПИСИ С НОМЕРОМ СОТРУДНИКА ОСТАЮТСЯ РЕДАКТИРУЕМЫМИ (ревью 17.09.2026).
 * На проде такие уже есть (клиент №38, объекты №41/№44 — заведены до защиты), а формы
 * редактирования шлют phone/extraPhones/ownerContact целиком даже без правки. Без
 * исключения для уже имеющегося номера их нельзя было бы поправить ни в одном поле.
 * Зато выбор такой карточки продавцом нового объекта — та же дыра, и он закрыт.
 */
describe("Старые записи с номером сотрудника", () => {
  const legacyStaffPhone = `+992902${t}`;
  let legacyAgentId: string;
  let legacyClientId: string;
  let legacyPropertyId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    legacyAgentId = (
      await prisma.agent.create({
        data: { fullName: `Сотрудник-легаси ${runId}`, phone: legacyStaffPhone, role: "AGENT", passwordHash, isActive: true },
      })
    ).id;
    legacyClientId = (
      await prisma.client.create({
        data: {
          fullName: `Легаси карточка ${runId}`,
          phone: legacyStaffPhone,
          source: "PHONE_CALL",
          kind: "SELLER",
          assignedAgentId: staffAgentId,
          acceptedAt: new Date(),
        },
      })
    ).id;
    clientIds.push(legacyClientId);
    legacyPropertyId = (
      await prisma.property.create({
        data: {
          title: `Легаси объект ${runId}`,
          type: "APARTMENT",
          areaSqm: 55,
          price: 45000,
          currency: "TJS",
          districtId,
          address: `Легаси адрес ${runId}`,
          condition: "GOOD",
          status: "AVAILABLE",
          intakeAgentId: staffAgentId,
          createdById: staffAgentId,
          assignedAgentId: staffAgentId,
          ownerContact: legacyStaffPhone,
          sellerClientId: legacyClientId,
        },
      })
    ).id;
    propertyIds.push(legacyPropertyId);
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: legacyAgentId } });
  });

  it("PATCH /clients/:id с неизменённым номером сотрудника проходит (форма шлёт phone целиком)", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${legacyClientId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: `Легаси карточка переименована ${runId}`, phone: legacyStaffPhone, extraPhones: [] });
    expect(res.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: legacyClientId }, select: { fullName: true } });
    expect(after?.fullName).toBe(`Легаси карточка переименована ${runId}`);
  });

  it("PATCH /properties/:id с неизменённым ownerContact сотрудника проходит", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${legacyPropertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ownerContact: legacyStaffPhone, price: 46000 });
    expect(res.status).toBe(200);
    const after = await prisma.property.findUnique({ where: { id: legacyPropertyId }, select: { price: true } });
    expect(Number(after?.price)).toBe(46000);
  });

  it("PATCH /properties/:id с ДРУГИМ номером сотрудника в ownerContact — 409", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${legacyPropertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ownerContact: staffPhonePlus });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(STAFF_PHONE_ERROR_CODE);
  });

  it("POST /properties с выбранной карточкой продавца на номере сотрудника — 409", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "APARTMENT",
        areaSqm: 50,
        rooms: 2,
        floor: 3,
        totalFloors: 9,
        windowCount: 3,
        price: 300000,
        currency: "TJS",
        districtId,
        address: `Тест гвард-карточка ${runId}`,
        condition: "GOOD",
        clientId: legacyClientId,
        intakeAgentId: staffAgentId,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(STAFF_PHONE_ERROR_CODE);
    if (res.body?.id) propertyIds.push(res.body.id);
    const property = await prisma.property.findFirst({ where: { address: `Тест гвард-карточка ${runId}` } });
    expect(property).toBeNull();
  });
});
