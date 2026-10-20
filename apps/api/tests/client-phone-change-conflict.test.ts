import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * СМЕНА ТЕЛЕФОНА НА НОМЕР ДРУГОЙ КАРТОЧКИ (23.09.2026, аудит №20).
 *
 * Проверка занятых номеров на правке считала совпадение с ОСНОВНЫМ номером
 * другой карточки «мягким» (так задумано для создания — там дубль склеивается).
 * На правке склейки нет: точный номер ронял запрос 500 (уникальность в базе),
 * тот же номер в другой записи (без «+») молча заводил второго клиента с тем же
 * телефоном. Номер карточки из Корзины — тоже 500.
 */

const runId = Date.now();
const tail = String(runId).slice(-6);
let agentId = "";
let token = "";
const ids: string[] = [];

async function makeClient(phone: string, extra: Record<string, unknown> = {}) {
  await prisma.client.deleteMany({ where: { phone } });
  const c = await prisma.client.create({
    data: { fullName: `Клиент номер ${runId}-${ids.length}`, phone, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date(), ...extra },
  });
  ids.push(c.id);
  return c;
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент номеров ${runId}`, phone: `+992919${tail}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  token = signAccessToken({ sub: agent.id, role: "AGENT" });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

async function patchPhone(id: string, phone: string) {
  return request(app).patch(`/api/v1/clients/${id}`).set("Authorization", `Bearer ${token}`).send({ phone });
}

describe("Смена телефона на чужой номер", () => {
  it("точный номер другой карточки — понятный отказ, а не сбой", async () => {
    const a = await makeClient(`+992921${tail}`);
    const b = await makeClient(`+992922${tail}`);
    const res = await patchPhone(a.id, b.phone);
    expect(res.status).toBe(409);
    expect((await prisma.client.findUnique({ where: { id: a.id } }))?.phone).toBe(a.phone);
  });

  it("тот же номер в другой записи — отказ, второй клиент с тем же телефоном не появляется", async () => {
    const a = await makeClient(`+992923${tail}`);
    const b = await makeClient(`+992924${tail}`);
    const res = await patchPhone(a.id, b.phone.replace("+", ""));
    expect(res.status).toBe(409);
    expect((await prisma.client.findUnique({ where: { id: a.id } }))?.phone).toBe(a.phone);
  });

  it("номер карточки из Корзины — отказ, а не 500", async () => {
    const a = await makeClient(`+992925${tail}`);
    const trashed = await makeClient(`+992926${tail}`, { deletedAt: new Date() });
    const res = await patchPhone(a.id, trashed.phone);
    expect(res.status).toBe(409);
  });

  it("свой же номер и новый свободный номер сохраняются как раньше", async () => {
    const a = await makeClient(`+992927${tail}`);
    expect((await patchPhone(a.id, a.phone)).status).toBe(200);
    const fresh = `+992928${tail}`;
    await prisma.client.deleteMany({ where: { phone: fresh } });
    expect((await patchPhone(a.id, fresh)).status).toBe(200);
  });
});
