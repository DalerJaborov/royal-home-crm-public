import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ПРОДАВЕЦ, ВПИСАННЫЙ В СВОЙ ЖЕ ОБЪЕКТ, — НЕ НИЧЕЙНЫЙ ЛИД (12.09.2026).
 *
 * Владелец завёл тестовый объект, на последнем шаге мастера вписал продавца — и
 * через несколько минут получил этого же человека окном «Новый клиент · Принять
 * / Отклонить», с записью в истории «лид назначен утренней волной распределения
 * (поступил вне рабочих часов)».
 *
 * Механизм: `routes/properties/crud.ts` заводил карточку продавца со
 * `status: "NEW"` и БЕЗ `assignedAgentId` — то есть неотличимо от лида с улицы.
 * Дальше её штатно подбирала волна разбора
 * (`services/leads/reassignment.ts::assignPendingLeads`, выборка
 * `{ assignedAgentId: null, status: { in: ["NEW", "CONTACTED", "HOT", "COLD"] } }`)
 * и раздавала агентам.
 *
 * Цена ошибки выше, чем лишнее окно: волна могла отдать продавца ДРУГОМУ агенту,
 * и тот, кто принёс объект, терял собственника своего же объекта — ровно то, что
 * правило «свой объект» и должно защищать.
 *
 * Тест держит два утверждения, и второе важнее первого:
 *  1. карточка сразу принадлежит интейкеру и уже принята (`acceptedAt`);
 *  2. выборка утренней волны её НЕ ВИДИТ — проверяется тем же условием, что
 *     стоит в самой волне, а не пересказом этого условия словами.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentToken: string;
let agentId: string;
let agentPhone: string;
let sellerPhone: string;
const propertyIds: string[] = [];
const clientIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-продавец-${runId}` } })).id;
  agentPhone = `+992954${runId.toString().slice(-6)}`;
  const agent = await prisma.agent.create({
    data: {
      fullName: "Агент, принёсший объект",
      phone: agentPhone,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentId = agent.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agentPhone, password });
  agentToken = res.body.accessToken as string;
  // Номер заведомо новый — карточки продавца с ним ещё нет, значит сработает
  // именно ветка автосоздания, а не привязка к существующему клиенту.
  sellerPhone = `+992955${runId.toString().slice(-6)}`;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function createPropertyWithSeller() {
  const res = await request(app)
    .post("/api/v1/properties")
    .set("Authorization", `Bearer ${agentToken}`)
    .send({
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 62,
      floor: 3,
      totalFloors: 9,
      windowCount: 4,
      price: 515000,
      currency: "TJS",
      districtId,
      address: `Тестовая улица ${runId}`,
      condition: "GOOD",
      sellerName: "Шухрат Тестовый",
      ownerContact: sellerPhone,
    });
  expect(res.status).toBe(201);
  propertyIds.push(res.body.id as string);
  return res.body as { id: string; sellerClientId: string | null };
}

describe("Карточка продавца из мастера объекта", () => {
  it("сразу принадлежит тому, кто принёс объект, и уже принята", async () => {
    const property = await createPropertyWithSeller();
    expect(property.sellerClientId).toBeTruthy();
    clientIds.push(property.sellerClientId!);

    const seller = await prisma.client.findUniqueOrThrow({
      where: { id: property.sellerClientId! },
      select: { assignedAgentId: true, acceptedAt: true, kind: true },
    });
    expect(seller.kind).toBe("SELLER");
    expect(seller.assignedAgentId).toBe(agentId);
    // Пустой acceptedAt — это и есть «лид ждёт, пока его примут»: именно он
    // зажигает окно «Принять / Отклонить».
    expect(seller.acceptedAt).not.toBeNull();
  });

  it("не попадает в выборку утренней волны распределения", async () => {
    // Условие дословно то же, что в assignPendingLeads: проверяем поведение
    // волны, а не свой пересказ её фильтра.
    const wouldBeDistributed = await prisma.client.findFirst({
      where: {
        id: { in: clientIds },
        assignedAgentId: null,
        escalatedAt: null,
        kind: { not: "OTHER" },
        deletedAt: null,
        status: { in: ["NEW", "CONTACTED", "HOT", "COLD"] },
        duplicateReviewOfClientId: null,
      },
      select: { id: true },
    });
    expect(wouldBeDistributed).toBeNull();
  });
});
