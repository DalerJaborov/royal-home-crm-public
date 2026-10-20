import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Правило «отказной лид» (70/30 риелтор/интейкер) отменено владельцем 09.09.2026,
 * а сама доля интейка («за приём объекта») — 11.09.2026: агент вводит только две
 * суммы (риелтор/компания), commissionIntakeAmount у новых сделок всегда 0.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let directorId: string;
let realtorId: string;
let intakeId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект сделки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      // Цена 200 000 при комиссии 2% даёт 4 000: компания 2 000, агентская часть 2 000.
      price: 200000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      intakeAgentId: intakeId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeClient(refusalCount: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент сделки ${runId}-${clientIds.length}`,
      phone: `+99294${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: realtorId,
      acceptedAt: new Date(),
      refusalCount,
    },
  });
  clientIds.push(c.id);
  return c;
}

/**
 * Создаёт сделку и закрывает её через новый двухшаговый путь (19.08.2026):
 * агент отправляет на закрытие с суммами (не процентами) — realtor/company
 * задаёт вызывающий тест, сервер их только складывает и снимает снапшот
 * refusedLeadSplit по факту на момент отправки (0,5% «за приём объекта»
 * отменены 11.09.2026 — суммы интейка агент больше не вводит).
 * Возвращает снапшот долей.
 */
async function closeDeal(refusalCount: number, sums: { realtor: number; company: number }) {
  const [client, property] = await Promise.all([makeClient(refusalCount), makeProperty()]);
  // «Отправить на закрытие» доступно только после проведённого показа.
  await prisma.interaction.create({
    data: {
      clientId: client.id,
      agentId: realtorId,
      propertyId: property.id,
      type: "SHOWING",
      notes: "Показ",
      completedAt: new Date(),
    },
  });
  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientId: client.id, propertyId: property.id, agentId: realtorId });
  expect(created.status).toBe(201);
  dealIds.push(created.body.id);

  const submitted = await request(app)
    .patch(`/api/v1/deals/${created.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      stage: "PENDING_APPROVAL",
      soldPrice: Number(property.price),
      commissionRealtorAmount: sums.realtor,
      commissionCompanyAmount: sums.company,
    });
  expect(submitted.status).toBe(200);

  const closed = await request(app)
    .patch(`/api/v1/deals/${created.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ stage: "COMPLETED" });
  expect(closed.status).toBe(200);

  const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
  return {
    total: Number(deal!.commissionAmount),
    company: Number(deal!.commissionCompanyAmount),
    realtor: Number(deal!.commissionRealtorAmount),
    intake: Number(deal!.commissionIntakeAmount),
    flag: deal!.refusedLeadSplit,
    id: deal!.id,
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-сделка-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор сделок", phone: `+992946${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  realtorId = (
    await prisma.agent.create({
      data: { fullName: "Риелтор продавший", phone: `+992945${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  intakeId = (
    await prisma.agent.create({
      data: { fullName: "Агент приведший объект", phone: `+992944${runId}`, role: "AGENT", passwordHash },
    })
  ).id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  grantElevation(director.id);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, realtorId, intakeId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Комиссия суммой (19.08.2026) — агент вводит сумму, сервер только складывает", () => {
  it("суммы, введённые агентом, сохраняются как есть — commissionAmount = их сумма, доля интейка 0", async () => {
    const d = await closeDeal(0, { realtor: 1000, company: 3000 });
    expect(d.total).toBe(4000);
    expect(d.company).toBe(3000);
    expect(d.realtor).toBe(1000);
    expect(d.intake).toBe(0);
    // Клиент без отказов на момент отправки — флаг снимается по факту, не по вводу агента.
    expect(d.flag).toBe(false);
  });

  /**
   * ПРАВИЛО «ОТКАЗНОЙ ЛИД» ОТМЕНЕНО (владелец 09.09.2026). Раньше флаг фиксировался
   * по `refusalCount > 0` покупателя, и агентская часть делилась 70/30 в пользу
   * продавшего. Отказ случался на стороне ПОКУПАТЕЛЯ, а долю терял ИНТЕЙКЕР — агент,
   * принявший объект, который к тому отказу отношения не имел; плюс счётчик
   * пожизненный, и один давний отказ стоил интейкеру доли на каждой будущей сделке.
   * САМА ДОЛЯ ИНТЕЙКА ОТМЕНЕНА (владелец 11.09.2026): интейкер денег со сделки
   * больше не получает ни при каких условиях, включая отказной лид.
   *
   * Теперь у новых закрытий флаг всегда false, а суммы — те, что ввёл агент.
   */
  it("прошлые отказы покупателя на новую сделку больше не влияют", async () => {
    const d = await closeDeal(1, { realtor: 1000, company: 3000 });
    expect(d.total).toBe(4000);
    expect(d.company).toBe(3000);
    expect(d.realtor).toBe(1000);
    expect(d.intake).toBe(0);
    expect(d.flag).toBe(false);
  });

  it("сумма долей всегда равна commissionAmount — просто их сложение", async () => {
    const d = await closeDeal(2, { realtor: 1300, company: 2700 });
    expect(d.company + d.realtor + d.intake).toBe(d.total);
    expect(d.total).toBe(4000);
  });
});

describe("Переоценка уже закрытой сделки — старый процентный пересчёт (легаси-путь)", () => {
  it("правило зафиксировано снапшотом: повторный отказ ПОСЛЕ сделки его не меняет, доля интейка остаётся 0", async () => {
    const d = await closeDeal(0, { realtor: 1000, company: 3000 });
    expect(d.flag).toBe(false);
    // Клиент отказал уже после закрытия — пересчёт суммы не должен сменить правило.
    await prisma.client.updateMany({ where: { id: clientIds[clientIds.length - 1] }, data: { refusalCount: 5 } });
    const res = await request(app)
      .patch(`/api/v1/deals/${d.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ commissionAmount: 8000 });
    expect(res.status).toBe(200);
    const after = await prisma.deal.findUnique({ where: { id: d.id } });
    expect(after!.refusedLeadSplit).toBe(false);
    // Переоценка масштабирует старый снапшот пропорционально (1000/3000 → 2000/6000).
    expect(Number(after!.commissionRealtorAmount)).toBe(2000);
    expect(Number(after!.commissionCompanyAmount)).toBe(6000);
    expect(Number(after!.commissionIntakeAmount)).toBe(0);
  });
});
