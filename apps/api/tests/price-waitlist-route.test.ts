import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { loadMoneyContext } from "../src/lib/money.js";
import { loadPriceWaitlist } from "../src/lib/priceWaitlist.js";
import { loadPriceAdvice } from "../src/lib/loadPriceAdvice.js";
import { loadPropertyHeat } from "../src/lib/propertyHeat.js";

/**
 * Лист ожидания по цене на настоящей базе: состав выборки (те же правила «ждущего» и «подходит», что у подбора),
 * валюты, накопительные ступени, видимость клиентов и отсутствие телефонов в ответе.
 *
 * В базе стенда могут лежать чужие ждущие покупатели без района — они подходят любому объекту. Поэтому числа
 * проверяются РАЗНИЦЕЙ с замером до появления фикстуры, а не абсолютом.
 */

const runId = Date.now();
const password = "testpass123";

let districtId = "";
let otherDistrictId = "";
let agentAId = "";
let agentBId = "";
let managerId = "";
let propertyId = "";
let propertyShortId = 0;
let agentAToken = "";
let managerToken = "";
const clientIds: Record<string, string> = {};
const createdClientIds: string[] = [];
let phoneSeq = 0;

type Base = Awaited<ReturnType<typeof loadPriceWaitlist>>;
let baseline: NonNullable<Base>;

async function makeClient(key: string, data: Record<string, unknown>) {
  phoneSeq += 1;
  const c = await prisma.client.create({
    data: {
      fullName: `Лист-${key}-${runId}`,
      phone: `+99278${String(runId).slice(-7)}${phoneSeq}`,
      status: "NEW",
      kind: "BUYER",
      source: "WEBSITE",
      desiredDistrictId: districtId,
      ...data,
    } as never,
  });
  clientIds[key] = c.id;
  createdClientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Лист-район-${runId}` } })).id;
  otherDistrictId = (await prisma.district.create({ data: { name: `Лист-чужой-${runId}` } })).id;
  agentAId = (await prisma.agent.create({ data: { fullName: "Агент А лист", phone: `+992961${String(runId).slice(-8)}`, role: "AGENT", passwordHash } })).id;
  agentBId = (await prisma.agent.create({ data: { fullName: "Агент Б лист", phone: `+992962${String(runId).slice(-8)}`, role: "AGENT", passwordHash } })).id;
  managerId = (await prisma.agent.create({ data: { fullName: "Руководитель лист", phone: `+992963${String(runId).slice(-8)}`, role: "MANAGER", passwordHash } })).id;

  const property = await prisma.property.create({
    data: {
      title: `Объект листа ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 3,
      price: 400_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentAId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;

  baseline = (await loadPriceWaitlist(propertyId))!;

  const { usdToTjs } = await loadMoneyContext();
  // Допуск бюджета подбора ±10 %: пределы клиентов с допуском — см. ожидания ниже.
  await makeClient("fit", { assignedAgentId: agentAId, budgetMax: 400_000, currency: "TJS", desiredRooms: 3 }); // подходит сейчас
  await makeClient("step5", { assignedAgentId: agentAId, budgetMax: 350_000, currency: "TJS", desiredRooms: 3 }); // 385k → ступень −5 %
  await makeClient("step8", { assignedAgentId: agentBId, budgetMax: 345_000, currency: "TJS", desiredRooms: 3 }); // 379,5k → ступень −8 %
  // Бюджет в долларах: 330 000 сомони по курсу стенда → 363k с допуском → ступень −10 % (360k).
  await makeClient("step10usd", { assignedAgentId: agentBId, budgetMax: Math.round(330_000 / usdToTjs), currency: "USD", desiredRooms: 3 });
  await makeClient("beyond", { assignedAgentId: agentAId, budgetMax: 200_000, currency: "TJS", desiredRooms: 3 }); // не дотянется и при −15 %
  await makeClient("nobudget", { assignedAgentId: agentBId, desiredRooms: 3 }); // бюджет не указан
  // Не должны попасть никуда:
  await makeClient("otherDistrict", { desiredDistrictId: otherDistrictId, assignedAgentId: agentAId, budgetMax: 350_000, desiredRooms: 3 });
  await makeClient("wrongRooms", { assignedAgentId: agentAId, budgetMax: 350_000, desiredRooms: 6 });
  await makeClient("closed", { assignedAgentId: agentAId, budgetMax: 350_000, desiredRooms: 3, status: "DEAL_CLOSED" });
  await makeClient("seller", { assignedAgentId: agentAId, budgetMax: 350_000, desiredRooms: 3, kind: "SELLER" });

  const login = async (phone: string) => {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  };
  agentAToken = await login(`+992961${String(runId).slice(-8)}`);
  managerToken = await login(`+992963${String(runId).slice(-8)}`);
});

afterAll(async () => {
  await prisma.propertyInterestEvent.deleteMany({ where: { propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, managerId] } } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, otherDistrictId] } } });
  await prisma.$disconnect();
});

describe("loadPriceWaitlist на настоящей базе", () => {
  it("ступени накопительные и монотонные, фикстура даёт ожидаемую прибавку к замеру до неё", async () => {
    const now = (await loadPriceWaitlist(propertyId))!;
    expect(now.fitNow - baseline.fitNow).toBe(1);
    expect(now.overBudget - baseline.overBudget).toBe(4); // step5, step8, step10usd, beyond
    expect(now.beyondLadder - baseline.beyondLadder).toBe(1);
    expect(now.noBudget - baseline.noBudget).toBe(1);
    // Ступени: −3 %, −5 %, −8 %, −10 %, −15 % → прибавка к базе: 0, 1, 2, 3, 3.
    expect(now.steps.map((s, i) => s.additional - baseline.steps[i].additional)).toEqual([0, 1, 2, 3, 3]);
    expect(now.steps.map((s) => s.price)).toEqual([388_000, 380_000, 368_000, 360_000, 340_000]);
    for (let i = 1; i < now.steps.length; i++) {
      expect(now.steps[i].total).toBeGreaterThanOrEqual(now.steps[i - 1].total);
    }
    expect(now.enoughData).toBe(true);
    expect(now.price).toBe(400_000);
    expect(now.onSale).toBe(true);
  });

  it("клиенты из чужого района, с лишними комнатами, закрытые сделкой и продавцы в выборку не попадают", async () => {
    const all = (await loadPriceWaitlist(propertyId))!.visibleClients.map((c) => c.id);
    for (const key of ["otherDistrict", "wrongRooms", "closed", "seller", "nobudget", "beyond"]) {
      expect(all).not.toContain(clientIds[key]);
    }
    for (const key of ["fit", "step5", "step8", "step10usd"]) expect(all).toContain(clientIds[key]);
  });

  it("лист ожидания под агента А содержит только его клиентов, а числа — по всем", async () => {
    const own = (await loadPriceWaitlist(propertyId, { visibleToAgentId: agentAId }))!;
    expect(own.visibleScope).toBe("own");
    const ids = own.visibleClients.map((c) => c.id);
    expect(ids).toContain(clientIds.fit);
    expect(ids).toContain(clientIds.step5);
    expect(ids).not.toContain(clientIds.step8);
    expect(ids).not.toContain(clientIds.step10usd);
    // Числа те же, что у руководителя.
    const all = (await loadPriceWaitlist(propertyId))!;
    expect(own.steps).toEqual(all.steps);
    expect(own.overBudget).toBe(all.overBudget);
  });

  it("несуществующий и удалённый объект — null", async () => {
    expect(await loadPriceWaitlist("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("GET /properties/:id/price-waitlist", () => {
  it("без токена — 401, несуществующий объект — 404", async () => {
    expect((await request(app).get(`/api/v1/properties/${propertyShortId}/price-waitlist`)).status).toBe(401);
    const res = await request(app).get("/api/v1/properties/999999999/price-waitlist").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(404);
  });

  it("агент: только свои клиенты в visibleClients, чужих нет; в ответе нет телефонов вообще", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyShortId}/price-waitlist`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.visibleScope).toBe("own");
    const ids = (res.body.visibleClients as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(clientIds.step5);
    expect(ids).not.toContain(clientIds.step8);
    expect(ids).not.toContain(clientIds.step10usd);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("+99278");
    expect(json).not.toContain("phone");
    // Чужие клиенты учтены в числах, но не названы.
    expect(res.body.steps).toHaveLength(5);
    expect(res.body.overBudget - baseline.overBudget).toBe(4);
  });

  it("номер телефона внутри имени клиента закрыт маской без права clients.viewPhone — и в имени, и во всём JSON", async () => {
    // Клиент, заведённый до 20.08.2026: номер лежит прямо в имени («Входящий +992…»). Создаётся и убирается внутри теста,
    // чтобы не сдвигать числа соседних проверок (они считают разницей с замером).
    const phone = `+99277${String(runId).slice(-7)}`;
    const digits = phone.replace(/\D/g, "");
    const c = await makeClient("namephone", {
      fullName: `Входящий ${phone}`,
      assignedAgentId: agentAId,
      budgetMax: 400_000,
      currency: "TJS",
      desiredRooms: 3,
    });
    try {
      for (const path of ["price-waitlist", "price-advice"]) {
        const res = await request(app).get(`/api/v1/properties/${propertyShortId}/${path}`).set("Authorization", `Bearer ${agentAToken}`);
        expect(res.status).toBe(200);
        const list = (path === "price-waitlist" ? res.body : res.body.waitlist).visibleClients as { id: string; fullName: string }[];
        const mine = list.find((x) => x.id === c.id);
        expect(mine, path).toBeDefined();
        expect(mine!.fullName).toMatch(/^Входящий /);
        expect(mine!.fullName).not.toContain(phone);
        expect(mine!.fullName).not.toContain(digits.slice(3));
        const json = JSON.stringify(res.body);
        expect(json).not.toContain(phone);
        expect(json).not.toContain(digits);
      }
    } finally {
      await prisma.client.deleteMany({ where: { id: c.id } });
    }
  });

  it("руководитель: видит всех подходящих клиентов", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyShortId}/price-waitlist`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.visibleScope).toBe("all");
    const ids = (res.body.visibleClients as { id: string }[]).map((c) => c.id);
    for (const key of ["fit", "step5", "step8", "step10usd"]) expect(ids).toContain(clientIds[key]);
  });
});

describe("GET /properties/:id/price-advice", () => {
  it("отдаёт совет и температуру, без телефонов и без денег рекламы", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyShortId}/price-advice`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(["hold", "consider_drop", "insufficient_data"]).toContain(res.body.advice.verdict);
    expect(Array.isArray(res.body.advice.evidence)).toBe(true);
    expect(typeof res.body.heat.score).toBe("number");
    expect(["холодный", "тёплый", "горячий"]).toContain(res.body.heat.word);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("+99278");
    expect(json).not.toContain("spendTjs");
  });

  it("лестница приходит внутри совета тем же расчётом: ступени как у /price-waitlist, агент — только свои клиенты", async () => {
    const adv = await request(app).get(`/api/v1/properties/${propertyShortId}/price-advice`).set("Authorization", `Bearer ${agentAToken}`);
    const wl = await request(app).get(`/api/v1/properties/${propertyShortId}/price-waitlist`).set("Authorization", `Bearer ${agentAToken}`);
    expect(adv.status).toBe(200);
    expect(adv.body.waitlist.steps).toEqual(wl.body.steps);
    expect(adv.body.waitlist.visibleScope).toBe("own");
    const ids = (adv.body.waitlist.visibleClients as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(clientIds.step5);
    expect(ids).not.toContain(clientIds.step8);
    const mgr = await request(app).get(`/api/v1/properties/${propertyShortId}/price-advice`).set("Authorization", `Bearer ${managerToken}`);
    expect(mgr.body.waitlist.visibleScope).toBe("all");
    expect((mgr.body.waitlist.visibleClients as { id: string }[]).map((c) => c.id)).toContain(clientIds.step8);
  });

  it("без токена — 401, несуществующий объект — 404", async () => {
    expect((await request(app).get(`/api/v1/properties/${propertyShortId}/price-advice`)).status).toBe(401);
    const res = await request(app).get("/api/v1/properties/999999999/price-advice").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(404);
  });

  it("загрузчик: объект без интереса получает честный вердикт и холодную температуру", async () => {
    const bundle = (await loadPriceAdvice(propertyId, { dealsOwnAgentId: null, viewerId: agentAId }))!;
    expect(bundle.heat.label).toBe("cold");
    expect(bundle.advice.verdict).not.toBe("consider_drop"); // 20-дневный объект без интереса: «данных мало» или «держать»
  });
});

describe("loadPropertyHeat на настоящей базе", () => {
  it("события интереса греют объект, пачка из нескольких объектов — без отдельного запроса на каждый", async () => {
    const before = (await loadPropertyHeat([propertyId])).get(propertyId)!;
    await prisma.propertyInterestEvent.createMany({
      data: [
        ...Array.from({ length: 3 }, () => ({ propertyId, kind: "SHOWING" })),
        ...Array.from({ length: 4 }, () => ({ propertyId, kind: "SHARE_OPENED" })),
      ],
    });
    const map = await loadPropertyHeat([propertyId, "00000000-0000-4000-8000-000000000001"]);
    const after = map.get(propertyId)!;
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.label).toBe("hot");
    expect(map.get("00000000-0000-4000-8000-000000000001")!.score).toBe(0);
    expect((await loadPropertyHeat([])).size).toBe(0);
  });
});
