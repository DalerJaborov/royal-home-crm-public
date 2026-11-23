import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import {
  FOREIGN_PHONE_CALL_ERROR,
  INVALID_PHONE_CALL_ERROR,
  isDialable,
  isForeignPhone,
  stationDialRefusal,
  toLocalDialDigits,
} from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { resetCalls } from "../src/lib/telephony/callTracker.js";
import { originateCall } from "../src/lib/telephony/ariClient.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { maskClientPhone } from "../src/lib/clientPhone.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";

/**
 * ИНОСТРАННЫЙ НОМЕР: НИ ЗВОНКА, НИ ЛОЖНОГО «НЕ ОТВЕТИЛ» (17.11.2026).
 *
 * Живой случай: ПР-000835 и ПК-000832 — российские номера из Instagram. Станция
 * агентства набирает только Таджикистан: исходящий маршрут отдаёт транку цифры как
 * есть (`SIP/out/79…`), оператор сбрасывает вызов за 0 секунд, а CRM записывала
 * исход «клиент не ответил». По журналу станции — 53 таких «недозвона», ни одного
 * гудка. Здесь проверяется, что такой звонок не заводится вовсе: ARI не зовётся,
 * в хронологии нет записи CALL, нет исхода NO_ANSWER, агенту — понятная причина.
 */

describe("правило номера (packages/shared)", () => {
  it("российский, американский, «8…» и «00…» — иностранные; таджикский — нет", () => {
    expect(isForeignPhone("+79000000001")).toBe(true);
    expect(isForeignPhone("79000000001")).toBe(true);
    expect(isForeignPhone("89000000001")).toBe(true);
    expect(isForeignPhone("+1 202 000 0001")).toBe(true);
    expect(isForeignPhone("0079000000001")).toBe(true);
    expect(isForeignPhone("+992 93 000 10 01")).toBe(false);
    expect(isForeignPhone("0930001001")).toBe(false);
    expect(isForeignPhone("930001001")).toBe(false);
  });

  it("таджикский номер с опечаткой и обрывок — не «заграница»", () => {
    expect(isForeignPhone("+9929300010011")).toBe(false);
    expect(isForeignPhone("12345")).toBe(false);
    expect(isForeignPhone("")).toBe(false);
    expect(isForeignPhone(null)).toBe(false);
  });

  it("закрытый номер (маска) опознаётся по коду страны в начале", () => {
    expect(isForeignPhone("+799•••••01")).toBe(true);
    expect(isForeignPhone("+992•••••57")).toBe(false);
    // Без «+» по маске страну не понять — решает сервер по настоящим цифрам.
    expect(isForeignPhone("7990•••••01")).toBe(false);
    // Маска — первые четыре ЗНАКА: таджикский номер с пробелом или скобкой после «+»
    // даёт голову «+ 99» / «+(99» — это не заграница (ложный отказ хуже недозвона).
    expect(isForeignPhone("+ 99•••••57")).toBe(false);
    expect(isForeignPhone("+(99•••••57")).toBe(false);
    expect(isForeignPhone("+9•••••57")).toBe(false);
    expect(isForeignPhone("+ 79•••••01")).toBe(true);
  });

  it("одна дверь: таджикский — можно, иностранный и битый — понятная причина", () => {
    expect(stationDialRefusal("+992930001001")).toBeNull();
    expect(stationDialRefusal("+79000000001")).toBe(FOREIGN_PHONE_CALL_ERROR);
    expect(stationDialRefusal("12345")).toBe(INVALID_PHONE_CALL_ERROR);
  });

  it("наборщик не обрезает иностранный номер до девяти «таджикских» цифр", () => {
    // Раньше `+7 900 000 00 01` превращался в `790000000` — и станция набрала бы
    // постороннего человека в Таджикистане.
    const local = toLocalDialDigits("+7 900 000 00 01");
    expect(local).toBe("79000000001");
    expect(isDialable(local)).toBe(false);
    expect(toLocalDialDigits("+992 93 000 10 01")).toBe("930001001");
  });
});

describe("originateCall — последний сторож", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("иностранный номер на станцию не уходит", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await originateCall({ url: "http://ari.test:8088", username: "u", password: "p" }, "1006", "+79000000001");
    expect(res.ok).toBe(false);
    expect(res.notDialable).toBe(true);
    expect(res.error).toBe(FOREIGN_PHONE_CALL_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("звонок из CRM на иностранный номер", () => {
  const runId = Date.now();
  const tail9 = String(runId).slice(-9);
  const password = "testpass123";
  const fetchMock = vi.fn();
  let agentId = "";
  let token = "";
  let foreignClientId = "";
  let tajikClientId = "";
  const foreignPhone = `+79${tail9}`;
  const dialForeign = `+78${tail9}`;

  beforeAll(async () => {
    const base = await reserveExtensionBase(2);
    const passwordHash = await bcrypt.hash(password, 4);
    const agent = await prisma.agent.create({
      data: { fullName: "Агент для иностранного номера", phone: `+992915${runId}`, role: "AGENT", passwordHash, sipExtension: `${base}` },
    });
    agentId = agent.id;
    token = signAccessToken({ sub: agent.id, role: "AGENT" });
    await prisma.client.deleteMany({ where: { phone: { in: [foreignPhone, dialForeign] } } });
    foreignClientId = (
      await prisma.client.create({
        data: {
          fullName: `Клиент с российским номером ${runId}`,
          phone: foreignPhone,
          source: "INSTAGRAM",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
        },
      })
    ).id;
    tajikClientId = (
      await prisma.client.create({
        data: {
          fullName: `Клиент с таджикским номером ${runId}`,
          phone: `+992${tail9}`,
          whatsappPhone: foreignPhone.replace("+79", "+77"),
          source: "INSTAGRAM",
          assignedAgentId: agentId,
          acceptedAt: new Date(),
        },
      })
    ).id;
    await prisma.settings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", asteriskAriUrl: "http://ari.test:8088", asteriskAriUsername: "royalhome", asteriskAriPassword: encryptSecret("secret") },
      update: { asteriskAriUrl: "http://ari.test:8088", asteriskAriUsername: "royalhome", asteriskAriPassword: encryptSecret("secret") },
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    resetCalls();
  });

  afterAll(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: { in: [foreignClientId, tajikClientId] } } });
    await prisma.client.deleteMany({ where: { id: { in: [foreignClientId, tajikClientId] } } });
    await prisma.client.deleteMany({ where: { phone: { contains: tail9 }, assignedAgentId: agentId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
  });

  it("кнопка «Позвонить» — 422 с причиной; ARI не зовётся, «не ответил» не пишется", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app).post(`/api/v1/clients/${foreignClientId}/call`).set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("not_dialable");
    expect(res.body.error).toBe(FOREIGN_PHONE_CALL_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
    const calls = await prisma.interaction.findMany({ where: { clientId: foreignClientId, type: "CALL" } });
    expect(calls).toHaveLength(0);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: foreignClientId }, select: { lastAgentAttemptAt: true } });
    // Звонка не было — и попыткой это не считается: связаться надо перепиской.
    expect(client.lastAgentAttemptAt).toBeNull();
  });

  it("дополнительный иностранный номер (WhatsApp) — тот же отказ, без звонка", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app)
      .post(`/api/v1/clients/${tajikClientId}/call`)
      .set("Authorization", `Bearer ${token}`)
      // Агент номера не видит: сайт шлёт маску, которую ему показали (открытые цифры не принимаются).
      .send({ phone: maskClientPhone(foreignPhone.replace("+79", "+77")) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("not_dialable");
    expect(res.body.error).toBe(FOREIGN_PHONE_CALL_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ручной набор иностранного номера — отказ ДО создания карточки", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app).post("/api/v1/clients/dial").set("Authorization", `Bearer ${token}`).send({ phone: dialForeign });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(FOREIGN_PHONE_CALL_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.client.count({ where: { phone: { in: [dialForeign, dialForeign.replace("+", "")] } } })).toBe(0);
  });

  it("таджикский номер звонит как раньше (ARI вызван)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: `chan-${runId}` }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app).post(`/api/v1/clients/${tajikClientId}/call`).set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    const originate = fetchMock.mock.calls.find(([url]) => String(url).includes("/ari/channels?"));
    expect(originate).toBeTruthy();
    expect(String(originate![0])).toContain(`extension=${tail9}`);
  });
});
