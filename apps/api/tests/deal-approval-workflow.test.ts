import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Закрытие сделки в два шага (19.08.2026, просьба владельца): агент указывает
 * фактическую цену и комиссию суммой (не процентом) и отправляет на закрытие
 * (PENDING_APPROVAL) — деньги ещё не выплачены, объект ещё не «Продано».
 * Только руководитель одобряет (COMPLETED) или отправляет назад на доработку
 * (обратно на CONTRACT_SIGNED).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let directorId: string;
let agentId: string;
let directorToken: string;
let agentToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент одобрения ${runId}-${clientIds.length}`,
      phone: `+992961${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект одобрения ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, одобрение",
      condition: "GOOD",
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

async function makeDealReadyToSubmit() {
  const [client, property] = await Promise.all([makeClient(), makeProperty()]);
  await prisma.interaction.create({
    data: { clientId: client.id, propertyId: property.id, agentId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
  });
  const created = await request(app)
    .post("/api/v1/deals")
    .set("Authorization", `Bearer ${agentToken}`)
    .send({ clientId: client.id, propertyId: property.id, agentId });
  dealIds.push(created.body.id);
  return { dealId: created.body.id as string, property };
}

const submitBody = {
  stage: "PENDING_APPROVAL",
  soldPrice: 95000,
  commissionRealtorAmount: 500,
  commissionCompanyAmount: 1000,
};

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-одобрение-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор одобрения", phone: `+992962${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент одобрения", phone: `+992963${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const [dirLogin, agentLogin] = await Promise.all([
    request(app).post("/api/v1/auth/login").send({ phone: director.phone, password }),
    request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password }),
  ]);
  expect(dirLogin.status).toBe(200);
  expect(agentLogin.status).toBe(200);
  directorToken = dirLogin.body.accessToken as string;
  agentToken = agentLogin.body.accessToken as string;
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Агент отправляет сделку на закрытие", () => {
  it("агент сам вводит цену и суммы комиссии — разрешено", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send(submitBody);
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("PENDING_APPROVAL");
  });

  /**
   * Ночная проверка 24.09.2026, круг «Сделки, деньги», находка №1: до этой
   * правки на отправке на закрытие писались только soldPrice и доли, а
   * commissionAmount оставался оценкой с создания (2 % от цены объявления =
   * 2000) — и именно её директор видел в «Решить сейчас», колонке «Ждёт
   * одобрения», на телефоне и в пульте. Сумма, по которой он решает, обязана
   * быть суммой введённых агентом долей.
   */
  it("после отправки на закрытие commissionAmount — сумма введённых долей, а не оценка от цены объявления", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send(submitBody);
    expect(res.status).toBe(200);
    expect(Number(res.body.commissionAmount)).toBe(1500);
    // Процент — от фактической цены продажи (1500 / 95000), а не 2 % от объявления.
    expect(Number(res.body.commissionPercent)).toBeCloseTo(1.5789, 4);

    const list = await request(app)
      .get("/api/v1/deals?stage=PENDING_APPROVAL")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(list.status).toBe(200);
    const row = (list.body as { id: string; commissionAmount: number | string }[]).find((d) => d.id === dealId);
    expect(row).toBeTruthy();
    expect(Number(row!.commissionAmount)).toBe(1500);
  });

  it("агент не может завершить сделку сам — только руководитель", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ stage: "COMPLETED" });
    expect(res.status).toBe(403);
  });

  it("агент не может отправить сделку назад на доработку — тоже дело руководителя", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ stage: "CONTRACT_SIGNED" });
    expect(res.status).toBe(403);
  });
});

describe("Руководитель одобряет или отправляет на доработку", () => {
  it("директор одобряет — сделка завершена, объект продан", async () => {
    const { dealId, property } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const approved = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(approved.status).toBe(200);

    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.status).toBe("SOLD");
  });

  it("директор отправляет назад на доработку — объект остаётся в продаже, агент может исправить и переотправить", async () => {
    const { dealId, property } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const rejected = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "CONTRACT_SIGNED", rejectReason: "Цена не согласована с продавцом" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.stage).toBe("CONTRACT_SIGNED");
    // Пачка 8 (11.09.2026): отклонение обнуляет суммы закрытия — повторная
    // отправка тех же цифр без исправления больше не проходит молча.
    expect(rejected.body.soldPrice).toBeNull();
    expect(rejected.body.commissionAmount).toBeNull();
    expect(rejected.body.commissionRealtorAmount).toBeNull();
    expect(rejected.body.commissionCompanyAmount).toBeNull();

    const propertyMid = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyMid?.status).not.toBe("SOLD");

    // Переотправка с исправленными суммами.
    const resubmitted = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ ...submitBody, soldPrice: 96000 });
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.stage).toBe("PENDING_APPROVAL");
  });

  it("отклонение без причины отвергается — директору нужно объяснить агенту, что поправить", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const rejected = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "CONTRACT_SIGNED" });
    expect(rejected.status).toBe(400);
  });

  it("после отклонения повторная отправка без новых сумм отвергается (были обнулены)", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);
    const rejected = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "CONTRACT_SIGNED", rejectReason: "Комиссия занижена" });
    expect(rejected.status).toBe(200);

    const resubmitWithoutSums = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ stage: "PENDING_APPROVAL" });
    expect(resubmitWithoutSums.status).toBe(400);
  });
});

describe("Завершённая сделка терминальна", () => {
  it("COMPLETED нельзя вернуть в CANCELLED — только новая сделка", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);
    const approved = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(approved.status).toBe(200);

    const cancelAttempt = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "CANCELLED" });
    expect(cancelAttempt.status).toBe(409);

    const after = await prisma.deal.findUnique({ where: { id: dealId } });
    expect(after?.stage).toBe("COMPLETED");
  });
});

describe("Пачка 8: пост-коммит закрытия идёт через очередь, не fire-and-forget", () => {
  it("закрытие сделки ставит задание deal-close-followup с dedupeKey на сделку", async () => {
    const { dealId, property } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);
    const approved = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(approved.status).toBe(200);

    const job = await prisma.backgroundJob.findUnique({
      where: { dedupeKey: `deal-close-followup:${dealId}` },
    });
    expect(job).not.toBeNull();
    expect(job?.type).toBe("deal-close-followup");
    expect((job?.payload as { propertyId?: string })?.propertyId).toBe(property.id);

    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: `deal-close-followup:${dealId}` } });
  });
});

describe("Суммы комиссии вне отправки на закрытие — снова дело руководителя", () => {
  it("агент не может просто так поправить суммы уже отправленной сделки", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const res = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ commissionRealtorAmount: 999 });
    expect(res.status).toBe(403);
  });

  it("директор правит цифры уже отправленной сделки на месте — без «на доработку» и без одобрения", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const edited = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ soldPrice: 97000, commissionRealtorAmount: 900, commissionCompanyAmount: 1300 });
    expect(edited.status).toBe(200);
    // Стадия не меняется правкой — сделка остаётся «ждёт одобрения», одобрение отдельным действием.
    expect(edited.body.stage).toBe("PENDING_APPROVAL");

    const approved = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(approved.status).toBe(200);
    // Одобрение фиксирует ПОПРАВЛЕННЫЕ директором цифры, а не то, что прислал агент изначально.
    expect(Number(approved.body.commissionAmount)).toBe(2200);
  });

  // Ночная проверка 24.09.2026, находка №1 (вторая половина): правка долей
  // директором на ждущей сделке тоже обязана обновить commissionAmount СРАЗУ —
  // до одобрения строка «комиссия …» показывала прежнюю оценку с создания.
  it("правка долей директором до одобрения сразу обновляет commissionAmount", async () => {
    const { dealId } = await makeDealReadyToSubmit();
    await request(app).patch(`/api/v1/deals/${dealId}`).set("Authorization", `Bearer ${agentToken}`).send(submitBody);

    const edited = await request(app)
      .patch(`/api/v1/deals/${dealId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ soldPrice: 97000, commissionRealtorAmount: 900, commissionCompanyAmount: 1300 });
    expect(edited.status).toBe(200);
    expect(edited.body.stage).toBe("PENDING_APPROVAL");
    expect(Number(edited.body.commissionAmount)).toBe(2200);
  });
});
