import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { waitFor } from "./helpers/waitFor.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * НОЧНАЯ ПРОВЕРКА 24.09.2026, М12-в: поля с сотрудниками в Настройках
 * (callbackOperatorAgentId — дежурный оператор обратных звонков,
 * videoMontajerAgentId — монтажёр, incomingDutyAgentIds — дежурные по
 * входящим) не проверялись на существование и активность сотрудника —
 * комментарий в схеме прямо говорил, что это забота фонового кода
 * ("agent_not_found" в журнале входящих), а не сохранения. Владелец решил:
 * проверять.
 *
 * 25.09.2026 (правило «нашёл баг — ищи весь класс»): те же два поведения
 * добавлены и для liveVoiceTransferAgentId (консультант на телефоне,
 * робозвонок) — та же форма поля, та же дыра.
 *
 * Два поведения на все поля:
 *  1. PATCH /settings отклоняет id уволенного/замороженного сотрудника (400).
 *  2. Увольнение/заморозка сотрудника, УЖЕ стоящего в одной из этих настроек,
 *     снимает его оттуда сама (routes/agents.ts, lib/agentSettingsCleanup.ts) —
 *     страховка на случай, если он был назначен ДО увольнения.
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let workingAgentId: string;
let firedAgentId: string;
let frozenAgentId: string;
let deactivatableAgentId: string;
let freezableAgentId: string;
let deactivatableAgentId2: string;
let freezableAgentId2: string;
let savedSettings: {
  callbackOperatorAgentId: string | null;
  videoMontajerAgentId: string | null;
  incomingDutyAgentIds: string[];
  liveVoiceTransferAgentId: string | null;
} | null = null;

function patchSettings(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

function patchAgent(id: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/v1/agents/${id}`).set("Authorization", `Bearer ${adminToken}`).send(body);
}

function freezeAgent(id: string, body: Record<string, unknown>) {
  return request(app).post(`/api/v1/agents/${id}/freeze`).set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ проверки сотрудника в настройках", phone: `+992980${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const working = await prisma.agent.create({
    data: { fullName: "Работающий сотрудник", phone: `+992981${runId}`, role: "AGENT", passwordHash: "x" },
  });
  workingAgentId = working.id;

  const fired = await prisma.agent.create({
    data: {
      fullName: "Уволенный сотрудник",
      phone: `+992982${runId}`,
      role: "AGENT",
      passwordHash: "x",
      isActive: false,
    },
  });
  firedAgentId = fired.id;

  const frozen = await prisma.agent.create({
    data: {
      fullName: "Замороженный сотрудник",
      phone: `+992983${runId}`,
      role: "AGENT",
      passwordHash: "x",
      frozenAt: new Date(),
      frozenReason: "Тест ночной проверки 24.09.2026",
    },
  });
  frozenAgentId = frozen.id;

  const deactivatable = await prisma.agent.create({
    data: { fullName: "Сотрудник на отключение", phone: `+992984${runId}`, role: "AGENT", passwordHash: "x" },
  });
  deactivatableAgentId = deactivatable.id;

  const freezable = await prisma.agent.create({
    data: { fullName: "Сотрудник на заморозку", phone: `+992985${runId}`, role: "AGENT", passwordHash: "x" },
  });
  freezableAgentId = freezable.id;

  const deactivatable2 = await prisma.agent.create({
    data: { fullName: "Сотрудник на отключение 2", phone: `+992987${runId}`, role: "AGENT", passwordHash: "x" },
  });
  deactivatableAgentId2 = deactivatable2.id;

  const freezable2 = await prisma.agent.create({
    data: { fullName: "Сотрудник на заморозку 2", phone: `+992988${runId}`, role: "AGENT", passwordHash: "x" },
  });
  freezableAgentId2 = freezable2.id;

  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: {
      callbackOperatorAgentId: true,
      videoMontajerAgentId: true,
      incomingDutyAgentIds: true,
      liveVoiceTransferAgentId: true,
    },
  });
});

afterAll(async () => {
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.auditLog.deleteMany({
    where: {
      action: { in: ["AGENT_DEACTIVATED_REMOVED_FROM_SETTINGS", "AGENT_FROZEN_REMOVED_FROM_SETTINGS"] },
      OR: [deactivatableAgentId, freezableAgentId, deactivatableAgentId2, freezableAgentId2].map((agentId) => ({
        meta: { path: ["agentId"], equals: agentId },
      })),
    },
  });
  await deleteAgentsWithTraces([
    adminId,
    workingAgentId,
    firedAgentId,
    frozenAgentId,
    deactivatableAgentId,
    freezableAgentId,
    deactivatableAgentId2,
    freezableAgentId2,
  ]);
  await prisma.$disconnect();
});

describe("PATCH /settings — сотрудник в поле обязан ещё работать", () => {
  it("уволенный в callbackOperatorAgentId — 400 с человеческим текстом", async () => {
    const res = await patchSettings({ callbackOperatorAgentId: firedAgentId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/уволен/);
    expect(res.body.error).toMatch(/Уволенный сотрудник/);

    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { callbackOperatorAgentId: true },
    });
    expect(fresh?.callbackOperatorAgentId).toBe(savedSettings?.callbackOperatorAgentId ?? null);
  });

  it("замороженный в videoMontajerAgentId — 400 с человеческим текстом", async () => {
    const res = await patchSettings({ videoMontajerAgentId: frozenAgentId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/заморожен/);
    expect(res.body.error).toMatch(/Замороженный сотрудник/);

    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
    expect(fresh?.videoMontajerAgentId).toBe(savedSettings?.videoMontajerAgentId ?? null);
  });

  it("несуществующий id в videoMontajerAgentId — 400", async () => {
    const res = await patchSettings({ videoMontajerAgentId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/не найден/);
  });

  it("уволенный внутри incomingDutyAgentIds — 400, даже если остальные в списке работают", async () => {
    const res = await patchSettings({ incomingDutyAgentIds: [workingAgentId, firedAgentId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/уволен/);

    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { incomingDutyAgentIds: true } });
    expect(fresh?.incomingDutyAgentIds).toEqual(savedSettings?.incomingDutyAgentIds ?? []);
  });

  it("работающий сотрудник — 200, значение сохраняется", async () => {
    const res = await patchSettings({ callbackOperatorAgentId: workingAgentId });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { callbackOperatorAgentId: true },
    });
    expect(fresh?.callbackOperatorAgentId).toBe(workingAgentId);
  });

  it("null (снять оператора) — 200, проверка не мешает очистке поля", async () => {
    const res = await patchSettings({ callbackOperatorAgentId: null });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { callbackOperatorAgentId: true },
    });
    expect(fresh?.callbackOperatorAgentId).toBeNull();
  });

  it("список из работающих сотрудников — 200, incomingDutyAgentIds сохраняется целиком", async () => {
    const res = await patchSettings({ incomingDutyAgentIds: [workingAgentId, deactivatableAgentId] });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { incomingDutyAgentIds: true } });
    expect(fresh?.incomingDutyAgentIds).toEqual([workingAgentId, deactivatableAgentId]);
  });

  // 25.09.2026 — та же проверка для поля, добавленного разбором класса.
  it("замороженный в liveVoiceTransferAgentId — 400 с человеческим текстом", async () => {
    const res = await patchSettings({ liveVoiceTransferAgentId: frozenAgentId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/заморожен/);
    expect(res.body.error).toMatch(/Замороженный сотрудник/);

    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { liveVoiceTransferAgentId: true },
    });
    expect(fresh?.liveVoiceTransferAgentId).toBe(savedSettings?.liveVoiceTransferAgentId ?? null);
  });

  it("работающий сотрудник в liveVoiceTransferAgentId — 200", async () => {
    const res = await patchSettings({
      liveVoiceTransferAgentId: workingAgentId,
    });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { liveVoiceTransferAgentId: true },
    });
    expect(fresh?.liveVoiceTransferAgentId).toBe(workingAgentId);
  });
});

describe("Увольнение/заморозка снимает сотрудника из Настроек", () => {
  it("отключение учётки чистит поля, где сотрудник был назначен, и пишет в журнал", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        callbackOperatorAgentId: deactivatableAgentId,
        incomingDutyAgentIds: [workingAgentId, deactivatableAgentId],
      },
    });

    const res = await patchAgent(deactivatableAgentId, { isActive: false });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { callbackOperatorAgentId: true, incomingDutyAgentIds: true },
    });
    expect(fresh?.callbackOperatorAgentId).toBeNull();
    expect(fresh?.incomingDutyAgentIds).toEqual([workingAgentId]);

    // logSystemAudit пишет "в отрыве" (без await) — читаем через waitFor, а не
    // голым findFirst сразу после ответа (ловушка CLAUDE.md).
    const entry = await waitFor(
      () =>
        prisma.auditLog.findFirst({
          where: {
            action: "AGENT_DEACTIVATED_REMOVED_FROM_SETTINGS",
            entityId: "singleton",
            meta: { path: ["agentId"], equals: deactivatableAgentId },
          },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись об отключённом в журнале" }
    );
    expect(entry).toBeTruthy();
    const meta = entry!.meta as { agentId?: string; fields?: string[] };
    expect(meta.agentId).toBe(deactivatableAgentId);
    expect(meta.fields).toEqual(expect.arrayContaining(["callbackOperatorAgentId", "incomingDutyAgentIds"]));
  });

  it("заморозка чистит videoMontajerAgentId и пишет в журнал", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: freezableAgentId } });

    const res = await freezeAgent(freezableAgentId, { reason: "Тест: заморозка снимает из Настроек" });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
    expect(fresh?.videoMontajerAgentId).toBeNull();

    const entry = await waitFor(
      () =>
        prisma.auditLog.findFirst({
          where: {
            action: "AGENT_FROZEN_REMOVED_FROM_SETTINGS",
            entityId: "singleton",
            meta: { path: ["agentId"], equals: freezableAgentId },
          },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись о заморозке в журнале" }
    );
    expect(entry).toBeTruthy();
    const meta = entry!.meta as { agentId?: string; fields?: string[] };
    expect(meta.agentId).toBe(freezableAgentId);
    expect(meta.fields).toEqual(["videoMontajerAgentId"]);
  });

  it("отключение учётки чистит liveVoiceTransferAgentId (25.09.2026, разбор класса)", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceTransferAgentId: deactivatableAgentId2 } });

    const res = await patchAgent(deactivatableAgentId2, { isActive: false });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceTransferAgentId: true } });
    expect(fresh?.liveVoiceTransferAgentId).toBeNull();

    const entry = await waitFor(
      () =>
        prisma.auditLog.findFirst({
          where: {
            action: "AGENT_DEACTIVATED_REMOVED_FROM_SETTINGS",
            entityId: "singleton",
            meta: { path: ["agentId"], equals: deactivatableAgentId2 },
          },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись об отключённом (liveVoiceTransferAgentId) в журнале" }
    );
    expect(entry).toBeTruthy();
    const meta = entry!.meta as { agentId?: string; fields?: string[] };
    expect(meta.agentId).toBe(deactivatableAgentId2);
    expect(meta.fields).toEqual(["liveVoiceTransferAgentId"]);
  });

  it("заморозка чистит liveVoiceTransferAgentId (25.09.2026, разбор класса)", async () => {
    // A different operation's audit must never satisfy this operation's wait,
    // even when timestamp ordering puts that older operation first.
    await prisma.auditLog.create({
      data: {
        action: "AGENT_FROZEN_REMOVED_FROM_SETTINGS",
        entityType: "Settings",
        entityId: "singleton",
        agentName: "Система",
        meta: { agentId: freezableAgentId, fields: ["videoMontajerAgentId"] },
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceTransferAgentId: freezableAgentId2 } });

    const res = await freezeAgent(freezableAgentId2, { reason: "Тест: заморозка снимает консультанта на телефоне" });
    expect(res.status).toBe(200);

    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { liveVoiceTransferAgentId: true },
    });
    expect(fresh?.liveVoiceTransferAgentId).toBeNull();

    const entry = await waitFor(
      () =>
        prisma.auditLog.findFirst({
          where: {
            action: "AGENT_FROZEN_REMOVED_FROM_SETTINGS",
            entityId: "singleton",
            meta: { path: ["agentId"], equals: freezableAgentId2 },
          },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись о заморозке (liveVoiceTransferAgentId) в журнале" }
    );
    expect(entry).toBeTruthy();
    const meta = entry!.meta as { agentId?: string; fields?: string[] };
    expect(meta.agentId).toBe(freezableAgentId2);
    expect(meta.fields).toEqual(["liveVoiceTransferAgentId"]);
  });

  it("увольнение сотрудника, не стоящего ни в одной из этих настроек, журнал не трогает", async () => {
    const bystander = await prisma.agent.create({
      data: { fullName: "Сторонний сотрудник", phone: `+992986${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const auditWhere = {
      action: "AGENT_DEACTIVATED_REMOVED_FROM_SETTINGS",
      entityId: "singleton",
      meta: { path: ["agentId"], equals: bystander.id },
    };
    const before = await prisma.auditLog.count({ where: auditWhere });
    const res = await patchAgent(bystander.id, { isActive: false });
    expect(res.status).toBe(200);

    // Ждём то же время, за которое реакция успела бы сработать, и проверяем,
    // что счётчик НЕ вырос (waitForSettled под эту же задачу, но здесь
    // достаточно короткой паузы: writeAudit пишется практически сразу, если бы
    // писался вовсе).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await prisma.auditLog.count({ where: auditWhere });
    expect(after).toBe(before);
    await deleteAgentsWithTraces([bystander.id]);
  });
});
