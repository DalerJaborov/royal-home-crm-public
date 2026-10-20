import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { escalateSellerPropertyMissing, findSellerPropertyMissing } from "../src/lib/sellerPropertyMissingAntifraud.js";
import { dushanbeDateTimeString, dushanbeInputToDate } from "../src/lib/dushanbeTime.js";

/**
 * Антифрод «продавец без объекта» (владелец 21.08.2026, Settings.sellerPropertyMissingWarnDays/
 * CriticalDays) — до 31.08.2026 warnDays читался только для другого (перенос dueAt «Итога
 * приёмки»), criticalDays не читался нигде. Три правила этого файла:
 *  1) закрытие требования — только реальная карточка объекта с sellerClientId, не время;
 *  2) daysSince >= criticalDays — уровень CRITICAL;
 *  3) эскалация ставит securityReview=PENDING РОВНО ОДИН РАЗ (дедуп по null→PENDING).
 */

const runId = Date.now();
const password = "testpass123";
const DAY_MS = 86_400_000;

let districtId: string;
let agentId: string;
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
let savedWarnDays: number | null = null;
let savedCriticalDays: number | null = null;

/** «Сейчас», но гарантированно в рабочих часах по Душанбе (04.09.2026,
 *  escalateSellerPropertyMissing молчит вне них) — реальная календарная дата,
 *  только время сдвинуто на полдень, чтобы day-математика (daysSinceAccepted
 *  в makeSeller считается от реального Date.now()) не разъехалась на дни. */
function workHoursNow(): Date {
  const today = dushanbeDateTimeString(new Date()).slice(0, 10);
  return dushanbeInputToDate(today, "12:00");
}

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeSeller(daysSinceAccepted: number) {
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец антифрода ${runId}-${clientIds.length}`,
      phone: `+992908${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      propertyAcceptedAt: new Date(Date.now() - daysSinceAccepted * DAY_MS),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-антифрод-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент антифрода", phone: `+992964${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  token = await login(agent.phone);

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { sellerPropertyMissingWarnDays: true, sellerPropertyMissingCriticalDays: true },
  });
  savedWarnDays = settings?.sellerPropertyMissingWarnDays ?? null;
  savedCriticalDays = settings?.sellerPropertyMissingCriticalDays ?? null;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { sellerPropertyMissingWarnDays: 3, sellerPropertyMissingCriticalDays: 5 },
  });
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      ...(savedWarnDays !== null ? { sellerPropertyMissingWarnDays: savedWarnDays } : {}),
      ...(savedCriticalDays !== null ? { sellerPropertyMissingCriticalDays: savedCriticalDays } : {}),
    },
  });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.district.delete({ where: { id: districtId } });
});

describe("findSellerPropertyMissing", () => {
  it("свежий приём (< warnDays) — не попадает вовсе", async () => {
    const c = await makeSeller(1);
    const { items } = await findSellerPropertyMissing(new Date());
    expect(items.some((i) => i.id === c.id)).toBe(false);
  });

  it("между warnDays и criticalDays — уровень WARN", async () => {
    const c = await makeSeller(4);
    const { items } = await findSellerPropertyMissing(new Date());
    const found = items.find((i) => i.id === c.id);
    expect(found?.level).toBe("WARN");
  });

  it(">= criticalDays — уровень CRITICAL", async () => {
    const c = await makeSeller(6);
    const { items } = await findSellerPropertyMissing(new Date());
    const found = items.find((i) => i.id === c.id);
    expect(found?.level).toBe("CRITICAL");
  });

  it("объект уже создан с sellerClientId — требование закрыто, в списке нет", async () => {
    const c = await makeSeller(10);
    const p = await prisma.property.create({
      data: {
        title: `Тест-объект-антифрод-${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        assignedAgentId: agentId,
        ownerContact: "+992900000098",
        sellerClientId: c.id,
      },
    });
    propertyIds.push(p.id);
    const { items } = await findSellerPropertyMissing(new Date());
    expect(items.some((i) => i.id === c.id)).toBe(false);
  });

  it("статус LOST — не попадает, даже без объекта и давно принят", async () => {
    const c = await makeSeller(30);
    await prisma.client.update({ where: { id: c.id }, data: { status: "LOST" } });
    const { items } = await findSellerPropertyMissing(new Date());
    expect(items.some((i) => i.id === c.id)).toBe(false);
  });
});

describe("escalateSellerPropertyMissing", () => {
  it("критичный случай без securityReview — ставит PENDING и не повторяет", async () => {
    const c = await makeSeller(6);
    const before = await prisma.client.findUnique({ where: { id: c.id }, select: { securityReview: true } });
    expect(before?.securityReview).toBeNull();

    const first = await escalateSellerPropertyMissing(workHoursNow());
    expect(first.escalated).toBeGreaterThanOrEqual(1);

    const after = await prisma.client.findUnique({ where: { id: c.id }, select: { securityReview: true } });
    expect(after?.securityReview).toBe("PENDING");

    // Повторный тик — уже не наш случай (securityReview не null), эскалация не повторяется.
    const second = await escalateSellerPropertyMissing(workHoursNow());
    const stillOne = await prisma.interaction.count({
      where: { clientId: c.id, notes: { contains: "Антифрод «продавец без объекта»" } },
    });
    expect(stillOne).toBe(1);
    expect(second.escalated).toBe(0);
  });

  it("СБ уже открывала карточку (securityReview=CLEARED) — эскалация не трогает решение", async () => {
    const c = await makeSeller(7);
    await prisma.client.update({ where: { id: c.id }, data: { securityReview: "CLEARED" } });
    await escalateSellerPropertyMissing(workHoursNow());
    const after = await prisma.client.findUnique({ where: { id: c.id }, select: { securityReview: true } });
    expect(after?.securityReview).toBe("CLEARED");
  });

  it("вне рабочих часов молчит (директора/СБ не будим ночью, 04.09.2026)", async () => {
    const c = await makeSeller(6);
    // Явно НЕ рабочие часы: та же реальная дата, что и workHoursNow(), но ночной час.
    const today = dushanbeDateTimeString(new Date()).slice(0, 10);
    const night = dushanbeInputToDate(today, "01:00");
    const result = await escalateSellerPropertyMissing(night);
    expect(result.escalated).toBe(0);
    const after = await prisma.client.findUnique({ where: { id: c.id }, select: { securityReview: true } });
    expect(after?.securityReview).toBeNull();
  });
});
