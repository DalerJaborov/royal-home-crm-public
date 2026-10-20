import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /clients/lost?kind=SELLER|BUYER — «Потерянные» ВНУТРИ раздела.
 *
 * Зачем срез серверный. Владелец 21.09.2026: «должно быть всего 2 раздела —
 * Продавцы, Покупатели, — а когда в них заходишь, потом уже неактивные,
 * потерянные». Раздел «Потерянные» отдаёт не весь список, а двести свежих
 * (потолок выборки, routes/clients/list.ts), поэтому отбор по уже полученной
 * странице соврал бы ровно тогда, когда потерянных много — то есть в
 * единственном случае, когда разделом пользуются.
 *
 * Проверяем и `total`: до этой правки он считался по всем потерянным, и
 * подпись «показаны последние N из M» в разделе продавцов называла бы число
 * покупателей.
 *
 * Фикстуры проверяются по своим id, а не по общему числу: база общая с
 * другими наборами, идущими параллельно.
 */

const runId = Date.now().toString(36);
const password = "testpass123";
let directorToken = "";
let directorPhone = "";
let agentId = "";
let agentPhone = "";
const clientIds: string[] = [];

async function makeLost(kind: "SELLER" | "BUYER") {
  const c = await prisma.client.create({
    data: {
      fullName: `Потерянный ${kind} ${clientIds.length} ${runId}`,
      phone: `+99291${clientIds.length}${runId.slice(-5)}`,
      source: "PHONE_CALL",
      kind,
      status: "LOST",
      escalatedAt: new Date(),
      assignedAgentId: agentId,
    },
  });
  clientIds.push(c.id);
  return c.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  directorPhone = `+992919${runId.slice(-6)}`;
  agentPhone = `+992918${runId.slice(-6)}`;
  await prisma.agent.create({
    data: { fullName: `Директор среза ${runId}`, phone: directorPhone, role: "DIRECTOR", passwordHash },
  });
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент среза ${runId}`, phone: agentPhone, role: "AGENT", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: directorPhone, password });
  directorToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [directorPhone, agentPhone] } } });
});

describe("GET /clients/lost?kind=", () => {
  it("отдаёт только свой вид, а без параметра — оба", async () => {
    const sellerId = await makeLost("SELLER");
    const buyerId = await makeLost("BUYER");

    const sellers = await request(app)
      .get("/api/v1/clients/lost?kind=SELLER")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(sellers.status).toBe(200);
    const sellerIds = sellers.body.items.map((c: { id: string }) => c.id);
    expect(sellerIds).toContain(sellerId);
    expect(sellerIds).not.toContain(buyerId);
    // Каждая строка среза — действительно продавец, а не только наши двое.
    for (const item of sellers.body.items as { kind: string }[]) expect(item.kind).toBe("SELLER");

    const buyers = await request(app)
      .get("/api/v1/clients/lost?kind=BUYER")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(buyers.status).toBe(200);
    const buyerIds = buyers.body.items.map((c: { id: string }) => c.id);
    expect(buyerIds).toContain(buyerId);
    expect(buyerIds).not.toContain(sellerId);

    // `total` тоже по срезу, иначе подпись «показаны N из M» называет чужое число.
    expect(sellers.body.total + buyers.body.total).toBeLessThanOrEqual(
      (await request(app).get("/api/v1/clients/lost").set("Authorization", `Bearer ${directorToken}`)).body.total
    );

    // Старая ссылка без параметра и посторонняя строка — прежнее поведение.
    const both = await request(app).get("/api/v1/clients/lost?kind=ЧТО-ТО").set("Authorization", `Bearer ${directorToken}`);
    expect(both.status).toBe(200);
    const bothIds = both.body.items.map((c: { id: string }) => c.id);
    expect(bothIds).toEqual(expect.arrayContaining([sellerId, buyerId]));
  });
});
