import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { DEFAULT_EVENT_POINTS } from "../src/lib/scoreJournal.js";

/**
 * Royal Score: «Карточка клиента полностью заполнена» (таблица владельца, п. 10) —
 * начисляется на переходе пусто→заполнено, не на каждом сохранении.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let agentToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function waitForEvent(sourceId: string): Promise<{ delta: number } | null> {
  // recordScoreEvent зовётся из routes/clients/card.ts без await — общий помощник
  // опроса вместо самописного цикла (tests/helpers/waitFor.ts).
  try {
    return await waitFor(
      () => prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId, kind: "card_filled" } }),
      { label: `балл card_filled по ${sourceId}` }
    );
  } catch {
    return null;
  }
}

/** Счётчик «этих» баллов, устоявшийся: обе проверки «не начислили» — им ждать нечего. */
function settledCount(sourceId: string): Promise<number> {
  return waitForSettled(() =>
    prisma.royalScoreEvent.count({ where: { agentId, sourceId, kind: "card_filled" } })
  );
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-карточка-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент карточки", phone: `+992980${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentToken = await login(`+992980${runId}`);
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.client.deleteMany({ where: { assignedAgentId: agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Заполнение карточки клиента", () => {
  it("переход пусто → заполнено начисляет card_filled", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Пустая карточка ${runId}`,
        phone: `+992981${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });

    const res = await request(app)
      .patch(`/api/v1/clients/${client.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ budgetMax: 500000, desiredDistrictId: districtId, desiredRooms: 2 });
    expect(res.status).toBe(200);

    const event = await waitForEvent(client.id);
    expect(event).not.toBeNull();
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.card_filled);
  });

  it("повторное сохранение уже заполненной карточки баллов не добавляет", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Уже заполнена ${runId}`,
        phone: `+992982${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
        budgetMax: 400000,
        desiredDistrictId: districtId,
        desiredRooms: 3,
      },
    });

    await request(app)
      .patch(`/api/v1/clients/${client.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ requirementsNotes: "не первый этаж" });

    const count = await settledCount(client.id);
    expect(count).toBe(0);
  });

  it("частичное заполнение (без района) баллов не начисляет", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Частично ${runId}`,
        phone: `+992983${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });

    await request(app)
      .patch(`/api/v1/clients/${client.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ budgetMax: 300000 });

    const count = await settledCount(client.id);
    expect(count).toBe(0);
  });

  it("очистка и повторное заполнение не начисляет баллы второй раз", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Дважды заполняют ${runId}`,
        phone: `+992984${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });

    await request(app)
      .patch(`/api/v1/clients/${client.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ budgetMax: 500000, desiredDistrictId: districtId, desiredRooms: 2 });
    await waitForEvent(client.id);

    await request(app)
      .patch(`/api/v1/clients/${client.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ desiredRooms: null, requirementsNotes: null });
    await request(app)
      .patch(`/api/v1/clients/${client.id}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ desiredRooms: 3 });

    await waitForEvent(client.id);
    const count = await settledCount(client.id);
    expect(count).toBe(1);
  });
});
