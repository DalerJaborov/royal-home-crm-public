import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Слияние дубликатов клиента: что переезжает на основную карточку.
 *
 * Карточка дубликата после слияния уходит в Корзину, поэтому всё, что читается
 * только по clientId, обязано переехать заранее — иначе оно исчезает вместе с ней.
 * На предложении ИИ по карточке это и поймали (аудит 09.08.2026): работа модели
 * уже оплачена, агент ждёт баннер, а баннера нет и никто не знает почему.
 *
 * Маршрута этого не касался ни один тест — при том что операция необратима.
 */

const runId = Date.now();
const phone = `+9929${String(runId).slice(-8)}`;
let adminId = "";
let agentId = "";
let token = "";
let primaryId = "";
let duplicateId = "";
let districtId = "";
let sellerId = "";
let propertyId = "";

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ слияния ${runId}`,
      phone: `+99291${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  token = signAccessToken({ sub: admin.id, role: "ADMIN" });

  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент слияния ${runId}`,
      phone: `+99292${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agentId = agent.id;

  const primary = await prisma.client.create({
    data: { fullName: `Основной ${runId}`, phone, kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agent.id },
  });
  primaryId = primary.id;
  // Тот же человек, записанный второй раз: номер отличается кодом страны, а девять
  // значащих цифр совпадают — именно так дубликаты и заводятся руками.
  const duplicate = await prisma.client.create({
    data: {
      fullName: `Дубликат ${runId}`,
      phone: phone.replace("+992", "992"),
      kind: "BUYER",
      source: "WALK_IN",
      assignedAgentId: agent.id,
    },
  });
  duplicateId = duplicate.id;
  districtId = (await prisma.district.create({ data: { name: `Слияние-район-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  if (propertyId) await prisma.property.deleteMany({ where: { id: propertyId } });
  if (districtId) await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.cardSuggestion.deleteMany({ where: { clientId: { in: [primaryId, duplicateId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [primaryId, duplicateId] } } });
  await prisma.client.deleteMany({ where: { id: { in: [primaryId, duplicateId, sellerId].filter(Boolean) } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
});

describe("Слияние дубликатов клиента", () => {
  it("переносит хронологию и незакрытое предложение ИИ на основную карточку", async () => {
    const interaction = await prisma.interaction.create({
      data: { clientId: duplicateId, agentId, type: "CALL", notes: "Разговор по дубликату" },
    });
    const suggestion = await prisma.cardSuggestion.create({
      data: { clientId: duplicateId, agentId, rooms: 2, notes: "Ищет двушку", evidence: ["двушку бы"] },
    });

    const res = await request(app)
      .post("/api/v1/clients/merge")
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryId, duplicateId });
    expect(res.status).toBe(200);

    const movedInteraction = await prisma.interaction.findUnique({ where: { id: interaction.id } });
    expect(movedInteraction?.clientId).toBe(primaryId);

    const movedSuggestion = await prisma.cardSuggestion.findUnique({ where: { id: suggestion.id } });
    expect(movedSuggestion?.clientId).toBe(primaryId);

    // Дубликат ушёл в Корзину, а не удалён физически: слияние обратимо только так.
    const trashed = await prisma.client.findUnique({ where: { id: duplicateId } });
    expect(trashed?.deletedAt).not.toBeNull();
  });

  /**
   * П-9/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): если у
   * дубля был СВОЙ агент (не тот, что у основной карточки), слияние — неявная
   * передача клиента: держатель дубля молча теряет его. AuditLog обязан это
   * зафиксировать на карточке-дубль.
   */
  it("дубль с ДРУГИМ агентом — AuditLog CLIENT_AGENT_CHANGE на карточке-дубле, source merge", async () => {
    const otherAgent = await prisma.agent.create({
      data: {
        fullName: `Другой агент слияния ${runId}`,
        phone: `+99293${String(runId).slice(-7)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    });
    const otherPrimary = await prisma.client.create({
      data: { fullName: `Основной-2 ${runId}`, phone: `+9929${String(runId).slice(-8)}1`, kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agentId },
    });
    const otherDuplicate = await prisma.client.create({
      data: {
        fullName: `Дубликат-2 ${runId}`,
        phone: `992${String(runId).slice(-8)}1`,
        kind: "BUYER",
        source: "WALK_IN",
        assignedAgentId: otherAgent.id,
      },
    });

    const res = await request(app)
      .post("/api/v1/clients/merge")
      .set("Authorization", `Bearer ${token}`)
      .send({ primaryId: otherPrimary.id, duplicateId: otherDuplicate.id });
    expect(res.status).toBe(200);

    const auditRow = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityType: "Client", entityId: otherDuplicate.id, action: "CLIENT_AGENT_CHANGE" },
      })
    );
    expect(auditRow).not.toBeNull();
    expect(auditRow?.agentId).toBe(adminId);
    expect((auditRow?.meta as Record<string, unknown> | null)?.source).toBe("merge");
    expect((auditRow?.meta as Record<string, unknown> | null)?.from).toBe(otherAgent.id);

    await prisma.client.deleteMany({ where: { id: { in: [otherPrimary.id, otherDuplicate.id] } } });
    await prisma.agent.deleteMany({ where: { id: otherAgent.id } });
  });
});
