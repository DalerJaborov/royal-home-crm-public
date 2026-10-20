import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { buildCommissionForecast, dushanbeMonthBounds } from "../src/lib/financeForecast.js";

/**
 * ПРОГНОЗ КОМИССИИ К КОНЦУ МЕСЯЦА (задание F2, 14.09.2026).
 *
 * Три сценария задания: нет сделок / только факт / факт + воронка + темп, плюс
 * граница месяца по Душанбе.
 *
 * ПОЧЕМУ СРАВНЕНИЯ ОТНОСИТЕЛЬНЫЕ. Расчёт смотрит на ВСЕ открытые сделки базы
 * (у открытой сделки нет месяца, к которому её можно приписать), а база стенда
 * общая и засеяна. Поэтому каждый шаг снимает базовую линию прямо перед тем,
 * как добавить свои записи, и проверяет разницу. Абсолютные равенства здесь
 * были бы зелёными только на пустой базе и красными у всех остальных.
 *
 * Месяц взят заведомо пустой (2031-03): никакие посевные данные в него не
 * попадают, поэтому факт месяца в начале честно равен нулю.
 */

const runId = Date.now();
const password = "testpass123";
const MONTH = "2031-03";
const { start: MONTH_START, end: MONTH_END } = dushanbeMonthBounds(MONTH);
/** Середина месяца — «сейчас» для расчёта: рабочие дни ещё остались. */
const NOW = new Date(MONTH_START.getTime() + 14 * 24 * 60 * 60 * 1000);
const DAY = 24 * 60 * 60 * 1000;

let districtId: string;
let directorId: string;
let agentId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeDeal(data: {
  stage: "COMPLETED" | "NEGOTIATION" | "CONTRACT_SIGNED";
  startedAt: Date;
  closedAt?: Date;
  commissionAmount?: number;
  price?: number;
}): Promise<string> {
  const n = dealIds.length;
  const client = await prisma.client.create({
    data: { fullName: `Клиент прогноза ${runId}-${n}`, phone: `+99290${String(runId).slice(-6)}${n}`, source: "WALK_IN" },
  });
  clientIds.push(client.id);
  const property = await prisma.property.create({
    data: {
      title: `Объект прогноза ${runId}-${n}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: data.price ?? 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
    },
  });
  propertyIds.push(property.id);
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id,
      propertyId: property.id,
      agentId,
      stage: data.stage,
      startedAt: data.startedAt,
      closedAt: data.closedAt ?? null,
      commissionAmount: data.commissionAmount ?? null,
      currency: "TJS",
    },
  });
  dealIds.push(deal.id);
  return deal.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-прогноз-${runId}` } })).id;
  const director = await prisma.agent.create({
    data: { fullName: "Директор прогноза", phone: `+992937${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент прогноза", phone: `+992938${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
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

describe("прогноз комиссии к концу месяца", () => {
  it("сценарий 1: сделок нет — факт ноль, темп не считается, причина названа словами", async () => {
    const f = await buildCommissionForecast(MONTH, NOW);
    expect(f.month).toBe(MONTH);
    expect(f.factTjs).toBe(0);
    // Закрытых сделок в трёх месяцах перед 2031-03 нет вовсе — темп честно не считаем.
    expect(f.lowHistory).toBe(true);
    expect(f.paceTjs).toBeNull();
    // Верхняя оценка без темпа равна ожидаемой, а не «ожидаемая плюс ноль наугад».
    expect(f.highTjs).toBe(f.expectedTjs);
    expect(f.lowTjs).toBeLessThanOrEqual(f.expectedTjs);
    expect(f.reasons.length).toBeGreaterThan(0);
    expect(f.workdaysLeft).toBeGreaterThan(0);
  });

  it("сценарий 2: только факт — закрытые сделки месяца попадают в факт и в обе оценки", async () => {
    const before = await buildCommissionForecast(MONTH, NOW);
    await makeDeal({
      stage: "COMPLETED",
      startedAt: new Date(MONTH_START.getTime() + DAY),
      closedAt: new Date(MONTH_START.getTime() + 3 * DAY),
      commissionAmount: 5000,
    });
    await makeDeal({
      stage: "COMPLETED",
      startedAt: new Date(MONTH_START.getTime() + DAY),
      closedAt: new Date(MONTH_START.getTime() + 5 * DAY),
      commissionAmount: 3000,
    });

    const after = await buildCommissionForecast(MONTH, NOW);
    expect(after.factTjs).toBe(before.factTjs + 8000);
    expect(after.expectedTjs).toBe(before.expectedTjs + 8000);
    expect(after.lowTjs).toBe(before.lowTjs + 8000);
    expect(after.reasons.join(" ")).toContain("закрытые сделки");
    // Процент плана считается от ожидаемой, а не от факта.
    if (after.planTjs > 0) {
      expect(after.percentOfPlan).toBe(Math.round((after.expectedTjs / after.planTjs) * 100));
    }
  });

  it("сценарий 3: факт + воронка + темп — стадия входит со своим весом, темп только в верхнюю оценку", async () => {
    // История: три закрытые сделки в трёх месяцах перед MONTH, срок каждой ~5 дней.
    // Она даёт и средний срок сделки, и среднюю комиссию за рабочий день.
    for (let i = 3; i >= 1; i--) {
      const closed = new Date(MONTH_START.getTime() - i * 30 * DAY);
      await makeDeal({
        stage: "COMPLETED",
        startedAt: new Date(closed.getTime() - 5 * DAY),
        closedAt: closed,
        commissionAmount: 6000,
      });
    }

    // Базовая линия снимается ПОСЛЕ истории: появившийся средний срок меняет
    // состав воронки по всей базе, и сравнивать с линией «до» было бы нечестно.
    const before = await buildCommissionForecast(MONTH, NOW);
    expect(before.lowHistory).toBe(false);
    expect(before.paceTjs).not.toBeNull();

    const beforeStage = before.stages.find((s) => s.stage === "CONTRACT_SIGNED");
    await makeDeal({
      stage: "CONTRACT_SIGNED",
      startedAt: new Date(MONTH_START.getTime() + DAY),
      commissionAmount: 10000,
    });
    await makeDeal({
      stage: "CONTRACT_SIGNED",
      startedAt: new Date(MONTH_START.getTime() + 2 * DAY),
      commissionAmount: 2000,
    });

    const after = await buildCommissionForecast(MONTH, NOW);
    const stage = after.stages.find((s) => s.stage === "CONTRACT_SIGNED");
    expect(stage).toBeDefined();
    expect(stage!.count).toBe((beforeStage?.count ?? 0) + 2);
    expect(stage!.amountTjs).toBe((beforeStage?.amountTjs ?? 0) + 12000);
    // Вес стадии по умолчанию — 0.8 (DEAL_STAGE_WIN_PROBABILITY_DEFAULT).
    expect(stage!.probability).toBe(0.8);
    expect(after.expectedTjs).toBe(before.expectedTjs + 12000 * 0.8);
    // Вероятность 0.8 не ниже порога нижней оценки — сделки попадают и в неё.
    expect(after.lowTjs).toBe(before.lowTjs + 12000 * 0.8);
    // Темп идёт только в верхнюю оценку и с множителем 0.5.
    expect(after.highTjs).toBe(after.expectedTjs + (after.paceTjs ?? 0));
    expect(after.highTjs).toBeGreaterThan(after.expectedTjs);
    expect(after.reasons.join(" ")).toContain("договор подписан");
  });

  it("граница месяца — по Душанбе, а не по UTC", async () => {
    const before = await buildCommissionForecast(MONTH, NOW);
    // 23:59 последнего дня месяца по Душанбе — это ещё МАРТ.
    await makeDeal({
      stage: "COMPLETED",
      startedAt: new Date(MONTH_END.getTime() - 5 * DAY),
      closedAt: new Date(MONTH_END.getTime() - 60_000),
      commissionAmount: 1500,
    });
    // 00:00 первого дня следующего месяца по Душанбе — это уже АПРЕЛЬ, хотя по
    // UTC всё ещё 31 марта (19:00). Ровно на этом раньше уезжали месячные суммы.
    await makeDeal({
      stage: "COMPLETED",
      startedAt: new Date(MONTH_END.getTime() - 5 * DAY),
      closedAt: new Date(MONTH_END.getTime() + 60_000),
      commissionAmount: 9999,
    });

    const after = await buildCommissionForecast(MONTH, NOW);
    expect(after.factTjs).toBe(before.factTjs + 1500);

    const next = await buildCommissionForecast("2031-04", new Date(MONTH_END.getTime() + DAY));
    expect(next.factTjs).toBe(9999);
  });

  it("эндпоинт отдаёт прогноз и отбивает кривой месяц", async () => {
    const ok = await request(app)
      .get(`/api/v1/finance/forecast?month=${MONTH}`)
      .set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.month).toBe(MONTH);
    expect(typeof ok.body.expectedTjs).toBe("number");
    expect(Array.isArray(ok.body.reasons)).toBe(true);
    expect(ok.body.reasons.length).toBeLessThanOrEqual(3);

    const bad = await request(app)
      .get("/api/v1/finance/forecast?month=март")
      .set("Authorization", `Bearer ${token}`);
    expect(bad.status).toBe(400);

    const anon = await request(app).get("/api/v1/finance/forecast");
    expect(anon.status).toBe(401);
  });
});
