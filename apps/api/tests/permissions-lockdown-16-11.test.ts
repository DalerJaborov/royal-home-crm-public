import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { PERMISSION_IDS, ROLE_PRESETS, resolvePermissions, type PermissionId } from "@royal-home/shared";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

/**
 * ЗАМОК ОПАСНЫХ ПРАВ РОП И МАРКЕТИНГА (владелец 16.11.2026, аудит прав 15.11).
 * Номера телефонов — только директору; сделку продавец сам себе не закрывает и
 * не переоценивает; выплату отмечают деньги компании; каналы компании подключает
 * директор; боевой режим рекламы — директор.
 */

const runId = Date.now();
let ropId: string;
let marketingId: string;
let directorId: string;
let districtId: string;
let ropToken: string;
let marketingToken: string;
let directorToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

describe("номера телефонов — только директору (чистые права)", () => {
  const roles = ["ADMIN", "MANAGER", "HEAD_OF_SALES", "MARKETING", "SECURITY", "AGENT", "EDITOR"] as const;
  const phoneRights: PermissionId[] = ["clients.viewPhone", "properties.viewOwners"];

  it("директор видит оба права", () => {
    const perms = resolvePermissions("DIRECTOR", null);
    for (const id of phoneRights) expect(perms.has(id)).toBe(true);
  });

  it.each(roles)("%s не получает их ни из пресета, ни личной галочкой", (role) => {
    const perms = resolvePermissions(role, { granted: phoneRights, revoked: [] });
    for (const id of phoneRights) expect(perms.has(id)).toBe(false);
    for (const id of phoneRights) expect(ROLE_PRESETS[role]).not.toContain(id);
  });
});

describe("опасные права РОП и маркетинга сняты из пресетов", () => {
  it("РОП: нет правки чужих карточек и звука звонков, работа продаж цела", () => {
    const p = resolvePermissions("HEAD_OF_SALES", null);
    expect(p.has("properties.editForeign")).toBe(false);
    expect(p.has("calls.hearRecording")).toBe(false);
    expect(p.has("deals.complete")).toBe(true);
  });
  it("маркетинг: нет выгрузки, расшифровок и звука; фото и видео по-прежнему ведёт", () => {
    const p = resolvePermissions("MARKETING", null);
    for (const id of ["properties.export", "calls.transcripts", "calls.hearRecording"] as const) expect(p.has(id)).toBe(false);
    expect(p.has("properties.moderate")).toBe(true);
    expect(p.has("properties.editForeign")).toBe(true);
  });
  it("все id из пресетов существуют", () => {
    for (const ids of Object.values(ROLE_PRESETS)) for (const id of ids) expect(PERMISSION_IDS).toContain(id);
  });
});

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-замок-${runId}` } })).id;
  const mk = (role: "HEAD_OF_SALES" | "MARKETING" | "DIRECTOR", n: number) =>
    prisma.agent.create({ data: { fullName: `Замок ${role} ${runId}`, phone: `+99294${runId}${n}`, role, passwordHash: "x" } });
  const [rop, marketing, director] = await Promise.all([mk("HEAD_OF_SALES", 1), mk("MARKETING", 2), mk("DIRECTOR", 3)]);
  ropId = rop.id;
  marketingId = marketing.id;
  directorId = director.id;
  ropToken = signAccessToken({ sub: rop.id, role: "HEAD_OF_SALES" });
  marketingToken = signAccessToken({ sub: marketing.id, role: "MARKETING" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([ropId, marketingId, directorId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function makeDeal(agentId: string, stage: "COMPLETED" | "CONTRACT_SIGNED") {
  const n = dealIds.length;
  const property = await prisma.property.create({
    data: {
      title: `Объект замок ${runId}-${n}`, type: "APARTMENT", areaSqm: 50, price: 100000, currency: "TJS", districtId,
      address: "Тестовая, замок", condition: "GOOD", status: stage === "COMPLETED" ? "SOLD" : "AVAILABLE",
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(property.id);
  const client = await prisma.client.create({
    data: { fullName: `Клиент замок ${runId}-${n}`, phone: `+99295${n}${runId}`, source: "PHONE_CALL", kind: "BUYER",
      status: stage === "COMPLETED" ? "DEAL_CLOSED" : "CONTACTED", assignedAgentId: agentId, acceptedAt: new Date() },
  });
  clientIds.push(client.id);
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id, propertyId: property.id, agentId, stage,
      ...(stage === "COMPLETED"
        ? { soldPrice: 98000, commissionAmount: 2940, commissionRealtorAmount: 1470, commissionCompanyAmount: 1470, closedAt: new Date() }
        : {}),
    },
  });
  dealIds.push(deal.id);
  return deal;
}

describe("сделки: продавец сам себе не закрывает и не переоценивает", () => {
  it("РОП не отмечает выплату комиссии, директор отмечает", async () => {
    const deal = await makeDeal(ropId, "COMPLETED");
    const denied = await request(app).post(`/api/v1/deals/${deal.id}/payout`).set("Authorization", `Bearer ${ropToken}`).send({});
    expect(denied.status).toBe(403);
    const ok = await request(app).post(`/api/v1/deals/${deal.id}/payout`).set("Authorization", `Bearer ${directorToken}`).send({});
    expect(ok.status).toBe(200);
  });

  it("РОП не переписывает комиссию закрытой сделки", async () => {
    const deal = await makeDeal(ropId, "COMPLETED");
    const res = await request(app).patch(`/api/v1/deals/${deal.id}`).set("Authorization", `Bearer ${ropToken}`)
      .send({ commissionAmount: 9999 });
    expect(res.status).toBe(403);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).commissionAmount?.toString()).toBe("2940");
  });

  it("РОП не аннулирует свою закрытую сделку, директор может", async () => {
    const deal = await makeDeal(ropId, "COMPLETED");
    const denied = await request(app).post(`/api/v1/deals/${deal.id}/annul`).set("Authorization", `Bearer ${ropToken}`)
      .send({ reason: "сам себе" });
    expect(denied.status).toBe(403);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("COMPLETED");
    const ok = await request(app).post(`/api/v1/deals/${deal.id}/annul`).set("Authorization", `Bearer ${directorToken}`)
      .send({ reason: "проверка директором" });
    expect(ok.status).toBe(200);
  });

  it("РОП не закрывает свою сделку сам", async () => {
    const deal = await makeDeal(ropId, "CONTRACT_SIGNED");
    const res = await request(app).patch(`/api/v1/deals/${deal.id}`).set("Authorization", `Bearer ${ropToken}`)
      .send({ stage: "COMPLETED", soldPrice: 98000, commissionRealtorAmount: 1470, commissionCompanyAmount: 1470, commissionAmount: 2940 });
    expect(res.status).toBe(403);
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).stage).toBe("CONTRACT_SIGNED");
  });
});

describe("каналы и реклама: маркетолог не переключает аккаунты компании", () => {
  it.each([
    ["post", "/api/v1/ads/connect"],
    ["post", "/api/v1/ads/disconnect"],
    ["get", "/api/v1/tiktok/oauth/start"],
    ["post", "/api/v1/tiktok/disconnect"],
    ["get", "/api/v1/threads/oauth/start"],
    ["post", "/api/v1/threads/disconnect"],
    ["get", "/api/v1/search-console/oauth/start"],
    ["post", "/api/v1/search-console/disconnect"],
  ] as const)("%s %s — маркетингу 403", async (method, url) => {
    const res = await request(app)[method](url).set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(403);
  });

  it("боевой режим автопродвижения маркетинг не включает", async () => {
    const res = await request(app).patch("/api/v1/ads/reels-autoboost").set("Authorization", `Bearer ${marketingToken}`)
      .send({ enabled: true, dryRun: false, adSetId: "123456789" });
    expect(res.status).toBe(403);
  });
});

describe("маркетинг не меняет цену чужого объекта", () => {
  it("PATCH цены чужого объекта — 403", async () => {
    const property = await prisma.property.create({
      data: { title: `Цена замок ${runId}`, type: "APARTMENT", areaSqm: 50, price: 100000, currency: "TJS", districtId,
        address: "Тестовая, цена", condition: "GOOD", status: "AVAILABLE", assignedAgentId: directorId },
    });
    propertyIds.push(property.id);
    const res = await request(app).patch(`/api/v1/properties/${property.id}`).set("Authorization", `Bearer ${marketingToken}`)
      .send({ price: 1 });
    expect(res.status).toBe(403);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price.toString()).toBe("100000");
  });
});
