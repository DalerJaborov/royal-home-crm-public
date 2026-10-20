import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";
import { encryptSecret } from "../src/crypto.js";
import { resetCalls } from "../src/lib/telephony/callTracker.js";

/**
 * «Звонок = принятие лида» (владелец 01.09.2026). Кнопка «Принять» никуда не делась
 * (см. lifecycle.ts::/:id/accept, свои тесты) — это ДОПОЛНИТЕЛЬНЫЙ путь: звонок
 * своему ещё не принятому лиду сам принимает его перед набором (routes/clients/
 * communications.ts::/:id/call). Маршрут и до этой правки не блокировал звонок
 * непринятому лиду (сервер сам берёт номер, агенту он не виден) — меняется только
 * то, что после звонка карточка больше не висит формально «не принята».
 */

const runId = Date.now();
// Внутренние номера — из свободного участка пула (helpers/extensionBase.ts), а не из
// двух последних цифр времени: те при параллельном прогоне сталкивались (№201).
const extBase = await reserveExtensionBase(2);
const ext1 = String(extBase);
const ext2 = String(extBase + 1);
const password = "testpass123";

let agentId: string;
let otherAgentId: string;
let tokenAgent: string;
let tokenOther: string;
const clientIds: string[] = [];

const fetchMock = vi.fn();

async function call(token: string, id: string) {
  return request(app).post(`/api/v1/clients/${id}/call`).set("Authorization", `Bearer ${token}`).send({});
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент звонок-принятие", phone: `+992928${runId}`, role: "AGENT", passwordHash, sipExtension: ext1 },
    })
  ).id;
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: "Директор звонок-принятие", phone: `+992929${runId}`, role: "DIRECTOR", passwordHash, sipExtension: ext2 },
    })
  ).id;
  tokenAgent = (await request(app).post("/api/v1/auth/login").send({ phone: `+992928${runId}`, password })).body.accessToken;
  tokenOther = (await request(app).post("/api/v1/auth/login").send({ phone: `+992929${runId}`, password })).body.accessToken;

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", asteriskAriUrl: "http://ari.test:8088", asteriskAriUsername: "royalhome", asteriskAriPassword: encryptSecret("secret") },
    update: { asteriskAriUrl: "http://ari.test:8088", asteriskAriUsername: "royalhome", asteriskAriPassword: encryptSecret("secret") },
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } }).catch(() => {});
  await prisma.$disconnect();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  resetCalls();
});

async function makeClient(overrides: Partial<Parameters<typeof prisma.client.create>[0]["data"]> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент звонок-принятие ${runId}-${clientIds.length}`,
      phone: `+992930${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: null,
      ...overrides,
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("Звонок = принятие лида", () => {
  it("звонок своему непринятому лиду сам его принимает — acceptedAt проставлен ДО ответа станции", async () => {
    const client = await makeClient();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-accept-1" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(tokenAgent, client.id);
    expect(res.status).toBe(200);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.acceptedAt).toBeTruthy();
    const accepted = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "принят агентом" } },
    });
    expect(accepted).toBeTruthy();
  });

  it("уже принятый лид — звонок ничего не ломает, принятие идемпотентно", async () => {
    const acceptedAt = new Date();
    const client = await makeClient({ acceptedAt });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-accept-2" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(tokenAgent, client.id);
    expect(res.status).toBe(200);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.acceptedAt?.getTime()).toBe(acceptedAt.getTime());
  });

  it("kind=OTHER не распределяется агентам — звонок не пытается его \"принять\"", async () => {
    const client = await makeClient({ kind: "OTHER", assignedAgentId: null });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-accept-3" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);

    // OTHER без assignedAgentId — canAccessAssignedAgent пропускает только clients.viewAll,
    // поэтому звонит директор (право есть), сам агент доступа не имеет вовсе.
    const res = await call(tokenOther, client.id);
    expect(res.status).toBe(200);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(reloaded.acceptedAt).toBeNull();
  });

  it("руководитель звонит по чужой карточке — своё принятие агента не подделывает", async () => {
    const client = await makeClient();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-accept-4" }) } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(tokenOther, client.id);
    expect(res.status).toBe(200);

    const reloaded = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    // Руководитель — не назначенный агент, ownAgentIdForAccept для него другой:
    // автопринятие срабатывает только когда звонящий и есть assignedAgentId.
    expect(reloaded.acceptedAt).toBeNull();
  });
});
