import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";
import { encryptSecret } from "../src/crypto.js";
import { resetCalls } from "../src/lib/telephony/callTracker.js";

/**
 * РУЧНОЙ НАБОР НОМЕРА (владелец 11.08.2026: «а если надо набрать номер?»).
 *
 * Кнопка «Позвонить» звонит только туда, где уже есть карточка клиента. Этот
 * маршрут — единственное место, где номер может быть каким угодно: найти
 * существующего клиента по хвосту номера или завести нового, назначив звонящего
 * ответственным сразу (в отличие от входящего — здесь звонок сделан осознанно).
 */

const runId = Date.now();
// Внутренние номера — из свободного участка пула (helpers/extensionBase.ts), а не из
// двух последних цифр времени: те при параллельном прогоне сталкивались (№201).
const extBase = await reserveExtensionBase(2);
const ext1 = String(extBase);
const ext2 = String(extBase + 1);
const password = "testpass123";

// findClientByPhoneDigits сравнивает ПОСЛЕДНИЕ 9 ЦИФР номера — поэтому у каждого
// тестового телефона клиента должен быть свой, непересекающийся хвост. base8 общий
// (для очистки одним `contains`), а ведущая цифра-маркер делает хвост уникальным.
const base8 = String(runId).slice(-8);
const phoneFor = (marker: string) => `+992${marker}${base8}`;

let agentWithExtId: string;
let agentNoExtId: string;
let tokenWithExt: string;
let tokenNoExt: string;
let existingClientId: string;
let existingClientAgentId: string;
let tokenOtherAgent: string;

const fetchMock = vi.fn();

async function dial(token: string, phone: string) {
  return request(app).post("/api/v1/clients/dial").set("Authorization", `Bearer ${token}`).send({ phone });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const withExt = await prisma.agent.create({
    data: {
      fullName: "Оператор с SIP (набор)",
      phone: `+992937${runId}`,
      role: "AGENT",
      passwordHash,
      sipExtension: ext1,
    },
  });
  agentWithExtId = withExt.id;
  const noExt = await prisma.agent.create({
    data: { fullName: "Оператор без SIP (набор)", phone: `+992936${runId}`, role: "AGENT", passwordHash },
  });
  agentNoExtId = noExt.id;

  const otherAgent = await prisma.agent.create({
    data: {
      fullName: "Чужой агент (набор)",
      phone: `+992935${runId}`,
      role: "AGENT",
      passwordHash,
      sipExtension: ext2,
    },
  });
  existingClientAgentId = otherAgent.id;
  existingClientId = (
    await prisma.client.create({
      data: {
        fullName: `Уже в базе ${runId}`,
        phone: phoneFor("1"),
        source: "PHONE_CALL",
        assignedAgentId: otherAgent.id,
        acceptedAt: new Date(),
      },
    })
  ).id;

  for (const [phone, setToken] of [
    [withExt.phone, (t: string) => (tokenWithExt = t)],
    [noExt.phone, (t: string) => (tokenNoExt = t)],
    [otherAgent.phone, (t: string) => (tokenOtherAgent = t)],
  ] as const) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    setToken(res.body.accessToken);
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      asteriskAriUrl: "http://ari.test:8088",
      asteriskAriUsername: "royalhome",
      asteriskAriPassword: encryptSecret("secret"),
    },
    update: {
      asteriskAriUrl: "http://ari.test:8088",
      asteriskAriUsername: "royalhome",
      asteriskAriPassword: encryptSecret("secret"),
    },
  });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { phone: { contains: base8 } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentWithExtId, agentNoExtId, existingClientAgentId] } } });
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } })
    .catch(() => {});
  await prisma.$disconnect();
});

afterEach(async () => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  // Один и тот же новый номер набирается в нескольких тестах — заведённые ЗА
  // ТЕСТОМ карточки убираем, чтобы следующий тест снова видел «клиента нет».
  await prisma.client.deleteMany({ where: { phone: { contains: base8 }, id: { not: existingClientId } } });
  resetCalls();
});

describe("POST /clients/dial", () => {
  it("слишком короткий номер отклоняется без обращения к ARI", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const res = await dial(tokenWithExt, "123");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("у агента без SIP-номера — понятная ошибка, а карточка всё равно заводится", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const freshPhone = phoneFor("2");
    const res = await dial(tokenNoExt, freshPhone);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/внутренний номер/i);
    // Карточка заводится ДО попытки звонка (иначе некому назначать ответственного)
    // и остаётся, даже если сам звонок не прошёл: та же логика, что у входящих —
    // след в базе важнее аккуратного отката. Повторный набор с настроенным SIP
    // найдёт эту же карточку, а не заведёт вторую.
    expect(await prisma.client.count({ where: { phone: freshPhone } })).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("незнакомый номер: заводит карточку, назначает звонящего и звонит", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "dial-channel-1" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const freshPhone = phoneFor("3");

    const res = await dial(tokenWithExt, freshPhone);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channelId: "dial-channel-1" });
    /**
     * ИМЯ КАРТОЧКИ — МАСКА, А НЕ НОМЕР (30.08.2026, разбор приватности).
     *
     * До этой правки сюда писались набранные цифры целиком, и карточка навсегда
     * называлась открытым номером. Имя уходит агенту везде — в список, календарь,
     * push, — а право `clients.viewPhone` там не проверяется, то есть номер утекал
     * мимо него. То же правило и тем же видом уже применено к входящим
     * (lib/telephony/incomingCalls.ts). Настоящий номер лежит в поле `phone`.
     */
    expect(res.body.client?.fullName).toMatch(/^Исходящий \*{3}\d{2}$/);
    expect(res.body.client?.fullName).not.toContain(freshPhone.slice(0, 8));

    const created = await prisma.client.findFirst({ where: { phone: freshPhone } });
    expect(created).not.toBeNull();
    expect(created?.source).toBe("PHONE_CALL");
    // Ответственный — сразу звонящий: он осознанно набрал этот номер, в отличие
    // от входящего, где до квалификации ответственного нет по замыслу.
    expect(created?.assignedAgentId).toBe(agentWithExtId);
  });

  it("повторный набор того же нового номера не плодит вторую карточку", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "dial-channel-2" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const freshPhone = phoneFor("4");

    const first = await dial(tokenWithExt, freshPhone);
    expect(first.status).toBe(200);
    resetCalls(); // второй звонок в том же тесте иначе упёрся бы в hasLiveCall

    const second = await dial(tokenWithExt, freshPhone);
    expect(second.status).toBe(200);
    expect(second.body.client?.id).toBe(first.body.client?.id);
    expect(await prisma.client.count({ where: { phone: freshPhone } })).toBe(1);
  });

  it("номер уже принадлежит чужому клиенту — звонит по общему правилу доступа, ответственного не меняет", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "dial-channel-3" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const existingPhone = phoneFor("1");

    // Своему клиенту — можно.
    const own = await dial(tokenOtherAgent, existingPhone);
    expect(own.status).toBe(200);
    expect(own.body.client?.id).toBe(existingClientId);
    const stillAssigned = await prisma.client.findUniqueOrThrow({ where: { id: existingClientId } });
    expect(stillAssigned.assignedAgentId).toBe(existingClientAgentId);
    resetCalls();

    // Чужому — нельзя, и звонка не происходит.
    fetchMock.mockClear();
    const foreign = await dial(tokenWithExt, existingPhone);
    expect(foreign.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("номер лежит в Корзине — звонок всё равно идёт, карточка не восстанавливается молча", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "dial-channel-trashed" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const trashedPhone = phoneFor("5");
    const trashed = await prisma.client.create({
      data: {
        fullName: `В Корзине ${runId}`,
        phone: trashedPhone,
        source: "PHONE_CALL",
        assignedAgentId: agentWithExtId,
        deletedAt: new Date(),
      },
    });

    const res = await dial(tokenWithExt, trashedPhone);
    expect(res.status).toBe(200);
    expect(res.body.client?.id).toBe(trashed.id);
    expect(fetchMock).toHaveBeenCalled();

    const stillTrashed = await prisma.client.findUniqueOrThrow({ where: { id: trashed.id } });
    expect(stillTrashed.deletedAt).not.toBeNull();
  });
});
