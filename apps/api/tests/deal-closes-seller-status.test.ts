import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ЗАПАС ПО ЧАСАМ, А НЕ ПО ТИКАМ.
 *
 * Потолки ожидания в этом файле стоят в ТИКАХ, а предел vitest — в СЕКУНДАХ, и
 * друг про друга они не знают: один `runBackgroundJobsTick()` выполняет партию
 * ЦЕЛИКОМ, до десяти заданий, среди которых бывают тяжёлые чужие
 * (`clip-compress` и прочий ffmpeg, оставленные прошедшими файлами этого же
 * процесса). На засорённой очереди нескольких тиков хватает, чтобы перебрать
 * двадцать секунд, и тест падает «Test timed out in 20000ms» при исправном
 * коде — в одиночку тот же файл проходит за секунды. Живые падения 24.09.2026:
 * `stuck-work.test.ts` (#855), `background-jobs.test.ts`.
 *
 * Гасить проверку нельзя, ускорить чужую партию отсюда невозможно — значит
 * нужен честный запас по времени, и даётся он всему файлу, а не отдельным
 * тестам: до очереди дотягиваются и те, что зовут её через помощников.
 */
vi.setConfig({ testTimeout: 90_000 });


// Без этого импорта runBackgroundJobsTick() находит задание "deal-close-followup" без
// зарегистрированного обработчика (jobs/handlers.ts регистрирует их side-effect'ом
// импорта, а не сам runner) — тот же приём, что в tests/stuck-conversations-retry.test.ts.
await import("../src/jobs/handlers.js");
const { runBackgroundJobsTick } = await import("../src/jobs/runner.js");

/**
 * 05.09.2026 — найдено на живом примере на проде: продавец объекта мог быть
 * вручную помечен «Сделка закрыта» через дропдаун статуса на его карточке
 * (apps/web/src/pages/ClientDetail.tsx, ManualStatus), и это была ПРОСТО
 * текстовая метка — ни комиссия, ни Royal Score, ни перевод объекта в
 * «Продано» не запускались (вся эта механика жила только в routes/deals.ts
 * и касалась исключительно покупателя, Property.sellerClientId с Deal
 * никак не связан).
 *
 * Починка симметрична уже существующему правилу для покупателя (ТЗ
 * 12.08.2026, «Состояние покупателя ставит CRM»): «Сделка закрыта» продавцу
 * теперь ставит сама deals.ts в момент реального закрытия сделки по его
 * объекту, а ручная правка именно этого значения через PATCH /clients/:id
 * заблокирована на сервере (routes/clients/card.ts).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeSeller() {
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец сделки ${runId}-${clientIds.length}`,
      phone: `+992950${runId}${clientIds.length}`,
      kind: "SELLER",
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeBuyer() {
  const c = await prisma.client.create({
    data: {
      fullName: `Покупатель сделки ${runId}-${clientIds.length}`,
      phone: `+992951${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      status: "NEW",
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(sellerClientId: string | null) {
  const p = await prisma.property.create({
    data: {
      title: `Объект продавца ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
      sellerClientId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-продавец-сделка-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор продавца-сделки", phone: `+992944${runId}`, role: "DIRECTOR", passwordHash },
  });
  const agent = await prisma.agent.create({
    data: { fullName: "Агент продавца-сделки", phone: `+992945${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  const dRes = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(dRes.status).toBe(200);
  grantElevation(director.id);
  token = dRes.body.accessToken as string;

  const aRes = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(aRes.status).toBe(200);
  (globalThis as { __agentToken?: string }).__agentToken = aRes.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.pendingSummary.deleteMany({ where: { kind: "property", subjectId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [`+992944${runId}`, `+992945${runId}`] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Закрытие сделки проставляет продавцу «Сделка закрыта» само", () => {
  it("продавец объекта переходит в DEAL_CLOSED при завершении сделки, с записью в хронологии", async () => {
    const seller = await makeSeller();
    const buyer = await makeBuyer();
    const property = await makeProperty(seller.id);

    await prisma.interaction.create({
      data: { clientId: buyer.id, agentId, propertyId: property.id, type: "SHOWING", notes: "Показ", completedAt: new Date() },
    });

    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: buyer.id, propertyId: property.id, agentId });
    expect(created.status).toBe(201);
    dealIds.push(created.body.id);

    const submitted = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 100000, commissionRealtorAmount: 2000, commissionCompanyAmount: 2000 });
    expect(submitted.status).toBe(200);

    const closed = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED" });
    expect(closed.status).toBe(200);

    const sellerAfter = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(sellerAfter?.status).toBe("DEAL_CLOSED");

    const history = await prisma.interaction.findFirst({
      where: { clientId: seller.id, type: "SYSTEM", notes: { contains: "Сделка закрыта" } },
    });
    expect(history).not.toBeNull();

    // Покупатель — уже существующее поведение, не должно было сломаться.
    const buyerAfter = await prisma.client.findUnique({ where: { id: buyer.id } });
    expect(buyerAfter?.status).toBe("DEAL_CLOSED");
  });

  // Отмену УЖЕ завершённой сделки код не допускает вовсе (deals.ts:347-348,
  // «Завершённую сделку нельзя вернуть на предыдущий этап» — намеренное
  // правило, не связанное с этой правкой), поэтому откат продавца из
  // DEAL_CLOSED при isCancelling — тот же защитный код, что уже существовал
  // для покупателя (deals.ts, ветка otherClosedClientDeals === 0), и по факту
  // недостижим тем же путём, каким недостижим он был у покупателя. Отдельный
  // тест на это не пишем — он проверял бы поведение, которое бизнес-правило
  // прямо запрещает.

  /**
   * НАХОДКА АУДИТА 13.09.2026: раньше этот же блок в routes/deals.ts закрывал
   * продавца сырым `updateMany({ where: { status: { not: "DEAL_CLOSED" } } })`
   * при ЛЮБОМ завершении сделки — не глядя, остались ли у него другие объекты
   * в работе. lib/sellerCardState.ts (decideSellerCardState) уже знает и уже
   * тестирует это правило («продан ОДИН объект из трёх» не закрывает карточку) —
   * здесь проверяем именно вход через реальный HTTP-путь закрытия сделки,
   * который эту функцию раньше не вызывал вовсе.
   */
  it("продавец с двумя объектами не закрывается, пока второй ещё в работе", async () => {
    const seller = await makeSeller();
    const buyer = await makeBuyer();
    const soldProperty = await makeProperty(seller.id);
    // Второй объект того же продавца остаётся в дефолтном статусе AVAILABLE —
    // "в работе" по IN_WORK_STATUSES (lib/sellerCardState.ts).
    const stillInWorkProperty = await makeProperty(seller.id);

    await prisma.interaction.create({
      data: { clientId: buyer.id, agentId, propertyId: soldProperty.id, type: "SHOWING", notes: "Показ", completedAt: new Date() },
    });

    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: buyer.id, propertyId: soldProperty.id, agentId });
    expect(created.status).toBe(201);
    dealIds.push(created.body.id);

    const submitted = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "PENDING_APPROVAL", soldPrice: 100000, commissionRealtorAmount: 2000, commissionCompanyAmount: 2000 });
    expect(submitted.status).toBe(200);

    const closed = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "COMPLETED" });
    expect(closed.status).toBe(200);

    // Проданный объект реально ушёл в SOLD — только карточка продавца остаётся открытой.
    const soldPropertyAfter = await prisma.property.findUnique({ where: { id: soldProperty.id } });
    expect(soldPropertyAfter?.status).toBe("SOLD");
    const untouchedProperty = await prisma.property.findUnique({ where: { id: stillInWorkProperty.id } });
    expect(untouchedProperty?.status).toBe("AVAILABLE");

    const sellerAfter = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(sellerAfter?.status).not.toBe("DEAL_CLOSED");
    expect(sellerAfter?.status).toBe("NEW");

    // И в хронологии продавца НЕТ преждевременной записи «Сделка закрыта».
    const history = await prisma.interaction.findFirst({
      where: { clientId: seller.id, type: "SYSTEM", notes: { contains: "Сделка закрыта" } },
    });
    expect(history).toBeNull();
  });
});

describe("«Сделка закрыта» продавцу агент не ставит вручную", () => {
  it("PATCH со status=DEAL_CLOSED от рядового агента на карточке продавца — 403", async () => {
    const seller = await makeSeller();
    const agentToken = (globalThis as { __agentToken?: string }).__agentToken as string;

    const res = await request(app)
      .patch(`/api/v1/clients/${seller.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "DEAL_CLOSED" });
    expect(res.status).toBe(403);

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("NEW");
  });

  it("15.09.2026: остальные статусы продавца агент тоже больше не меняет вручную — запрет расширен с DEAL_CLOSED на любой статус", async () => {
    const seller = await makeSeller();
    const agentToken = (globalThis as { __agentToken?: string }).__agentToken as string;

    const res = await request(app)
      .patch(`/api/v1/clients/${seller.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ status: "HOT" });
    expect(res.status).toBe(403);

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("NEW");
  });

  it("15.09.2026: руководство (clients.assign) по-прежнему может поправить статус продавца вручную — escape hatch не тронут", async () => {
    const seller = await makeSeller();

    const res = await request(app)
      .patch(`/api/v1/clients/${seller.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "HOT" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("HOT");
  });
});
