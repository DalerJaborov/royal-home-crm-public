import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";
import { encryptSecret } from "../src/crypto.js";
import { applyStationDialResult, finishCall, resetCalls } from "../src/lib/telephony/callTracker.js";
import { ROLE_PRESETS } from "@royal-home/shared";

/**
 * «РАЗБОР УДАЛЁННОГО КЛИЕНТА» (владелец 16.11.2026, lib/archiveReviewCall.ts): РОП звонит клиенту из
 * Корзины через АТС — без восстановления карточки, смены хозяина и автопринятия; звонок не рабочий
 * звонок агента; номер маской; след в журнале действий; история и причина — в ручке /trash/:id/review.
 */

const runId = Date.now();
const extBase = await reserveExtensionBase(4);
const password = "testpass123";
const RAW_PHONE = `+99293${String(runId).slice(-7)}`;
const RAW_DIGITS = RAW_PHONE.replace("+", "");

const ids = { rop: "", owner: "", director: "", manager: "", client: "", live: "" };
const tokens = { rop: "", owner: "", director: "", manager: "" };
const fetchMock = vi.fn();

function call(token: string, id: string) {
  return request(app).post(`/api/v1/clients/${id}/call`).set("Authorization", `Bearer ${token}`).send({});
}

async function login(phone: string) {
  return (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const mk = async (fullName: string, phone: string, role: "HEAD_OF_SALES" | "AGENT" | "DIRECTOR" | "MANAGER", ext: number) =>
    (await prisma.agent.create({ data: { fullName, phone, role, passwordHash, sipExtension: String(ext) } })).id;
  ids.rop = await mk("РОП разбор-корзины", `+992941${runId}`, "HEAD_OF_SALES", extBase);
  ids.owner = await mk("Агент бывший хозяин", `+992942${runId}`, "AGENT", extBase + 1);
  ids.director = await mk("Директор разбор-корзины", `+992943${runId}`, "DIRECTOR", extBase + 2);
  ids.manager = await mk("Менеджер без права", `+992944${runId}`, "MANAGER", extBase + 3);
  tokens.rop = await login(`+992941${runId}`);
  tokens.owner = await login(`+992942${runId}`);
  tokens.director = await login(`+992943${runId}`);
  tokens.manager = await login(`+992944${runId}`);

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", asteriskAriUrl: "http://ari.test:8088", asteriskAriUsername: "royalhome", asteriskAriPassword: encryptSecret("secret") },
    update: { asteriskAriUrl: "http://ari.test:8088", asteriskAriUsername: "royalhome", asteriskAriPassword: encryptSecret("secret") },
  });

  const deleted = await prisma.client.create({
    data: {
      fullName: `Удалённый клиент ${runId}`,
      phone: RAW_PHONE,
      source: "PHONE_CALL",
      status: "CONTACTED",
      assignedAgentId: ids.owner,
      acceptedAt: null,
      deletedAt: new Date(),
      deletedById: ids.director,
    },
  });
  ids.client = deleted.id;
  const live = await prisma.client.create({
    data: { fullName: `Живой клиент ${runId}`, phone: `+99294${String(runId).slice(-8)}`, source: "PHONE_CALL", assignedAgentId: ids.owner, acceptedAt: new Date() },
  });
  ids.live = live.id;
  await prisma.auditLog.create({
    data: { action: "TRASH", entityType: "Client", entityId: ids.client, agentId: ids.director, agentName: "Директор разбор-корзины", meta: { phone: RAW_PHONE } },
  });
  await prisma.clientDeleteRequest.create({
    data: { clientId: ids.client, requestedById: ids.owner, reason: "DUPLICATE", comment: "Этот человек уже есть", status: "APPROVED", decidedById: ids.director, decidedAt: new Date() },
  });
});

afterAll(async () => {
  const clientIds = [ids.client, ids.live].filter(Boolean);
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  const agentIds = [ids.rop, ids.owner, ids.director, ids.manager].filter(Boolean);
  await prisma.interaction.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } }).catch(() => {});
  await prisma.$disconnect();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  resetCalls();
});

function stationOk(channelId: string) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: channelId }) } as Response);
  vi.stubGlobal("fetch", fetchMock);
}

describe("право на разбор удалённого", () => {
  it("пресет РОПа содержит право, а у рядового агента его нет", () => {
    expect(ROLE_PRESETS.HEAD_OF_SALES).toContain("clients.callArchived");
    expect(ROLE_PRESETS.AGENT).not.toContain("clients.callArchived");
  });
});

describe("POST /clients/:id/call по карточке из Корзины", () => {
  it("РОП звонит: 200, карточка остаётся в Корзине, хозяин и приём не меняются, номер не отдаётся", async () => {
    stationOk("ch-archive-1");
    const res = await call(tokens.rop, ids.client);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(RAW_DIGITS);

    const client = await prisma.client.findUniqueOrThrow({ where: { id: ids.client } });
    expect(client.deletedAt).not.toBeNull();
    expect(client.assignedAgentId).toBe(ids.owner);
    expect(client.acceptedAt).toBeNull();
    expect(client.status).toBe("CONTACTED");

    const row = await prisma.interaction.findFirstOrThrow({ where: { clientId: ids.client, type: "CALL" }, orderBy: { createdAt: "desc" } });
    expect(row.archiveReview).toBe(true);
    expect(row.agentId).toBe(ids.rop);
    expect(row.notes).toContain("разбор удалённого клиента");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: ids.client, action: "ARCHIVE_REVIEW_CALL" } });
    expect(audit.agentId).toBe(ids.rop);
    expect(JSON.stringify(audit.meta)).not.toContain(RAW_DIGITS);
    expect((audit.meta as { ownerAgentId: string }).ownerAgentId).toBe(ids.owner);
  });

  it("директор тоже может", async () => {
    stationOk("ch-archive-2");
    const res = await call(tokens.director, ids.client);
    expect(res.status).toBe(200);
  });

  it("хозяин-агент и сотрудник без права — отказ, звонка нет", async () => {
    const before = await prisma.interaction.count({ where: { clientId: ids.client, type: "CALL" } });
    stationOk("ch-archive-3");
    const owner = await call(tokens.owner, ids.client);
    expect([403, 409]).toContain(owner.status);
    const manager = await call(tokens.manager, ids.client);
    expect([403, 409]).toContain(manager.status);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.interaction.count({ where: { clientId: ids.client, type: "CALL" } })).toBe(before);
  });

  it("недозвон разбора не двигает карточку: ни исхода, ни задачи, ни статуса", async () => {
    stationOk("ch-archive-4");
    const res = await call(tokens.rop, ids.client);
    expect(res.status).toBe(200);
    applyStationDialResult("ch-archive-4", { status: "NOANSWER", answeredSeconds: null });
    await finishCall("ch-archive-4");

    await vi.waitFor(async () => {
      const row = await prisma.interaction.findFirstOrThrow({ where: { clientId: ids.client, type: "CALL", archiveReview: true }, orderBy: { createdAt: "desc" } });
      expect(row.callAttempt).toBe("NO_ANSWER");
    });
    const last = await prisma.interaction.findFirstOrThrow({ where: { clientId: ids.client, type: "CALL" }, orderBy: { createdAt: "desc" } });
    expect(last.notes.startsWith("Разбор удалённого клиента")).toBe(true);
    expect(last.outcome).toBeNull();
    expect(last.nextAction).toBeNull();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: ids.client } });
    expect(client.status).toBe("CONTACTED");
    expect(client.deletedAt).not.toBeNull();
    expect(await prisma.interaction.count({ where: { clientId: ids.client, autoTaskKind: { not: null } } })).toBe(0);
  });

  it("живая карточка: обычный звонок агента не помечается разбором", async () => {
    stationOk("ch-archive-5");
    const res = await call(tokens.owner, ids.live);
    expect(res.status).toBe(200);
    const row = await prisma.interaction.findFirstOrThrow({ where: { clientId: ids.live, type: "CALL" } });
    expect(row.archiveReview).toBe(false);
  });
});

describe("GET /clients/trash/:id/review", () => {
  it("РОП видит кто удалил, хозяина, причину, журнал и звонки; настоящего номера нет", async () => {
    const res = await request(app).get(`/api/v1/clients/trash/${ids.client}/review`).set("Authorization", `Bearer ${tokens.rop}`);
    expect(res.status).toBe(200);
    expect(res.body.client.deletedBy.fullName).toBe("Директор разбор-корзины");
    expect(res.body.client.owner.fullName).toBe("Агент бывший хозяин");
    expect(res.body.deleteRequest.reasonLabel).toMatch(/Дубль/);
    expect(res.body.deleteRequest.requestedBy.fullName).toBe("Агент бывший хозяин");
    expect(res.body.audit.some((a: { label: string }) => a.label === "Удалил в Корзину")).toBe(true);
    expect(res.body.interactions.some((i: { archiveReview?: boolean }) => i.archiveReview === true)).toBe(true);
    expect(res.body.canCall).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(RAW_DIGITS);
  });

  it("имя с номером маскируется, ночная уборка подписана «автоматически», хозяин берётся из lastAgentId", async () => {
    const phone = `+99295${String(runId).slice(-7)}`;
    const c = await prisma.client.create({
      data: {
        fullName: `Входящий ${phone}`,
        phone,
        source: "PHONE_CALL",
        assignedAgentId: null,
        lastAgentId: ids.owner,
        deletedAt: new Date(),
        deletedById: ids.director,
      },
    });
    try {
      const res = await request(app).get(`/api/v1/clients/trash/${c.id}/review`).set("Authorization", `Bearer ${tokens.rop}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(phone.replace("+", ""));
      expect(res.body.client.deletedAutomatically).toBe(true);
      expect(res.body.client.deletedBy).toBeNull();
      expect(res.body.client.owner.fullName).toBe("Агент бывший хозяин");
    } finally {
      await prisma.client.delete({ where: { id: c.id } });
    }
  });

  it("«Показать более ранние»: курсор отдаёт только записи старше указанной", async () => {
    const all = await request(app).get(`/api/v1/clients/trash/${ids.client}/review`).set("Authorization", `Bearer ${tokens.rop}`);
    expect(all.body.interactions.length).toBeGreaterThan(0);
    expect(all.body.hasMore).toBe(false);
    const old = await request(app)
      .get(`/api/v1/clients/trash/${ids.client}/review?before=2000-01-01T00:00:00.000Z&beforeId=ffffffff`)
      .set("Authorization", `Bearer ${tokens.rop}`);
    expect(old.status).toBe(200);
    expect(old.body.interactions).toEqual([]);
    const future = await request(app)
      .get(`/api/v1/clients/trash/${ids.client}/review?before=2100-01-01T00:00:00.000Z&beforeId=ffffffff`)
      .set("Authorization", `Bearer ${tokens.rop}`);
    expect(future.body.interactions.length).toBe(all.body.interactions.length);
  });

  it("агент без права «Архив» — 403; живая карточка — 404", async () => {
    const agent = await request(app).get(`/api/v1/clients/trash/${ids.client}/review`).set("Authorization", `Bearer ${tokens.owner}`);
    expect(agent.status).toBe(403);
    const live = await request(app).get(`/api/v1/clients/trash/${ids.live}/review`).set("Authorization", `Bearer ${tokens.rop}`);
    expect(live.status).toBe(404);
  });
});
