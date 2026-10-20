import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ЛЕНТА ЗВОНКОВ ПОСЛЕ ПОКАЗА В КОНТРОЛЕ РУКОВОДИТЕЛЯ (17.09.2026).
 *
 * Опросов после показа было построено два, владелец выбрал один. Экран при этом
 * НЕ переделывался — «внедрять мягко, не портя что построено»: путь тот же,
 * форма ответа та же, поменялся только источник. Здесь это и проверяется:
 * старый контракт цел, данные приходят из `PostShowingCall`, расшифровка и
 * запись подтягиваются из разговора живого голоса.
 */

const runId = Date.now();
const password = "testpass123";
const HOUR = 60 * 60 * 1000;

let directorId: string;
let agentId: string;
let clientId: string;
let propertyId: string;
let districtId: string;
let token: string;
let phoneSeq = 0;

function phone(): string {
  phoneSeq++;
  return `+9925${String(runId).slice(-6)}${String(phoneSeq).padStart(2, "0")}`;
}

async function makeCall(options: {
  channelId?: string;
  outcome?: "AGENT_COMPLAINT" | "NOT_SUITABLE";
  quote?: string;
  redFlags?: string[];
  dialed?: boolean;
}): Promise<string> {
  const showing = await prisma.interaction.create({
    data: { clientId, agentId, type: "SHOWING", propertyId, notes: "Показ", nextActionDate: new Date(Date.now() - 3 * HOUR) },
  });
  const call = await prisma.postShowingCall.create({
    data: {
      showingId: showing.id,
      clientId,
      agentId,
      propertyId,
      scheduledFor: new Date(Date.now() - 2 * HOUR),
      status: options.outcome ? "DONE" : "GIVEN_UP",
      attempts: options.dialed === false ? 0 : 2,
      lastAttemptAt: options.dialed === false ? null : new Date(Date.now() - HOUR),
      talkedAt: options.outcome ? new Date(Date.now() - HOUR) : null,
      channelId: options.channelId ?? null,
      outcome: options.outcome ?? null,
      quote: options.quote ?? null,
      redFlags: options.redFlags ?? [],
    },
  });
  return call.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-лента-${runId}` } })).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор Ленты", phone: phone(), role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент Ленты", phone: phone(), role: "AGENT", passwordHash } })
  ).id;
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: (await prisma.agent.findUniqueOrThrow({ where: { id: directorId }, select: { phone: true } })).phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель ленты ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект ленты ${runId}`,
        type: "APARTMENT",
        areaSqm: 48,
        price: 42000,
        currency: "TJS",
        districtId,
        address: "Тест",
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.liveVoiceSession.deleteMany({ where: { clientId } });
  await prisma.postShowingCall.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.liveVoiceSession.deleteMany({ where: { clientId } });
  await prisma.postShowingCall.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
});

function feed(query = "") {
  return request(app).get(`/api/v1/oversight/showing-survey-calls${query}`).set("Authorization", `Bearer ${token}`);
}

describe("лента опросов после показа", () => {
  it("отдаёт звонки в прежней форме, с именами агента и клиента", async () => {
    await makeCall({ outcome: "NOT_SUITABLE" });

    const res = await feed();
    expect(res.status).toBe(200);
    const row = res.body.items[0];
    expect(row.client.fullName).toContain("Покупатель ленты");
    expect(row.agent.fullName).toBe("Агент Ленты");
    expect(row.property.title).toContain("Объект ленты");
    expect(row.calledAt).not.toBeNull();
    // Поля старого контракта на месте — фронт переписывать не пришлось.
    expect(row).toHaveProperty("transcriptPreview");
    expect(row).toHaveProperty("hasRecording");
    expect(row).toHaveProperty("redFlags");
    expect(row).toHaveProperty("escalatedAt");
  });

  it("запись, по которой не набирали номер, в ленте звонков не показывается", async () => {
    await makeCall({ dialed: false });

    expect((await feed()).body.items).toHaveLength(0);
  });

  it("«только с находками» показывает красный исход и прячет обычный", async () => {
    await makeCall({ outcome: "NOT_SUITABLE" });
    const flagged = await makeCall({ outcome: "AGENT_COMPLAINT", quote: "он дал свой номер", redFlags: ["дал личный номер"] });

    const res = await feed("?onlyFlagged=1");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(flagged);
    // Подпись чипа читается и без словаря на фронте.
    expect(res.body.items[0].redFlags[0].category).toBe("Жалоба на сотрудника");
    expect(res.body.items[0].escalatedAt).not.toBeNull();
    expect(res.body.items[0].quote).toBe("он дал свой номер");
  });

  it("расшифровка и запись подтягиваются из разговора живого голоса", async () => {
    const channelId = `chan-feed-${runId}`;
    const id = await makeCall({ outcome: "NOT_SUITABLE", channelId });
    await prisma.liveVoiceSession.create({
      data: {
        channelId,
        clientId,
        transcript: "Бот: как прошёл просмотр?\nКлиент: кухня маленькая",
        recordingUrl: "live-voice/test.wav",
      },
    });

    const list = await feed();
    expect(list.body.items[0].transcriptPreview).toContain("кухня маленькая");
    expect(list.body.items[0].hasRecording).toBe(true);

    const detail = await request(app)
      .get(`/api/v1/oversight/showing-survey-calls/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.transcript).toContain("кухня маленькая");
  });

  it("звонка нет — 404, а не пустая строка", async () => {
    const res = await request(app)
      .get(`/api/v1/oversight/showing-survey-calls/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
