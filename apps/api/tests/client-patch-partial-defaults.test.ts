import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ЧАСТИЧНЫЙ PATCH НЕ ДОЛЖЕН ПОДСТАВЛЯТЬ ЗАВОДСКИЕ ЗНАЧЕНИЯ (19.09.2026,
 * жалоба владельца: «не получается изменять имя клиента, выдаёт ошибку»
 * и «статусы не меняются»).
 *
 * `clientUpdateSchema` собиралась как `clientBaseSchema.partial()`, а у трёх
 * полей базовой схемы стоит `.default()` (status="NEW", kind="BUYER",
 * currency="TJS"). В zod 4 `.partial()` делает поле необязательным, но
 * `.default()` внутри него ПРОДОЛЖАЕТ подставлять значение, когда ключа в
 * запросе нет. Поэтому запрос «поменяй только имя» доезжал до маршрута как
 * «поменяй имя И поставь статус Новый, тип Покупатель, валюту сомони»:
 *
 *   · агенту сервер отвечал 403 «Состояние покупателя ставит CRM» — имя не
 *     менялось вовсе;
 *   · руководителю правка проходила, но сбрасывала статус на «Новый», писала
 *     в хронологию ложную смену статуса и ставила statusSetManuallyAt — то
 *     есть замораживала автоматику статусов на неделю после каждой правки;
 *   · у продавца kind молча становился BUYER, и карточка пропадала из вкладки
 *     «Продавцы».
 */

const runId = Date.now();
const password = "testpass123";
let agentId: string;
let agentToken: string;
let directorToken: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент частичной правки", phone: `+992961${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  await prisma.agent.create({
    data: { fullName: "Директор частичной правки", phone: `+992962${runId}`, role: "DIRECTOR", passwordHash },
  });
  agentToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992961${runId}`, password })).body
    .accessToken;
  directorToken = (await request(app).post("/api/v1/auth/login").send({ phone: `+992962${runId}`, password })).body
    .accessToken;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [`+992961${runId}`, `+992962${runId}`] } } });
  await prisma.$disconnect();
});

async function createClient(token: string, data: Record<string, unknown>) {
  const created = await request(app).post("/api/v1/clients").set("Authorization", `Bearer ${token}`).send(data);
  expect(created.status).toBe(201);
  clientIds.push(created.body.id);
  return created.body.id as string;
}

describe("PATCH клиента только с одним полем", () => {
  it("агент переименовывает клиента, который уже не «Новый»", async () => {
    const id = await createClient(agentToken, {
      fullName: "Старое имя",
      phone: `+99290${runId}1`,
      source: "PHONE_CALL",
    });
    await prisma.client.update({ where: { id }, data: { status: "CONTACTED" } });

    const patched = await request(app)
      .patch(`/api/v1/clients/${id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ fullName: "Новое имя" });

    expect(patched.status).toBe(200);
    expect(patched.body.fullName).toBe("Новое имя");
    const after = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("CONTACTED");
  });

  it("правка имени не сбрасывает статус, тип и валюту и не морозит автоматику", async () => {
    const id = await createClient(directorToken, {
      fullName: "Продавец Салим",
      phone: `+99290${runId}2`,
      source: "PHONE_CALL",
      kind: "SELLER",
      currency: "USD",
      budgetMax: 50000,
    });
    await prisma.client.update({ where: { id }, data: { status: "HOT", statusSetManuallyAt: null } });

    const patched = await request(app)
      .patch(`/api/v1/clients/${id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ fullName: "Продавец Салим Каримов" });

    expect(patched.status).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(after.fullName).toBe("Продавец Салим Каримов");
    expect(after.status).toBe("HOT");
    expect(after.kind).toBe("SELLER");
    expect(after.currency).toBe("USD");
    // Автоматика статусов замирает на неделю после РУЧНОЙ смены статуса
    // (lib/clientAutoStatus.ts). Правка имени такой сменой не является.
    expect(after.statusSetManuallyAt).toBeNull();

    const history = await prisma.interaction.findMany({ where: { clientId: id } });
    expect(history.some((h) => h.type === "STATUS_CHANGE")).toBe(false);
  });

  it("явно присланный статус по-прежнему меняется", async () => {
    const id = await createClient(directorToken, {
      fullName: "Смена статуса вручную",
      phone: `+99290${runId}3`,
      source: "PHONE_CALL",
    });

    const patched = await request(app)
      .patch(`/api/v1/clients/${id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ status: "HOT" });

    expect(patched.status).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("HOT");
    expect(after.statusSetManuallyAt).not.toBeNull();
  });
});
