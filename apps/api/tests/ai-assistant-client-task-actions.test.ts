import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorFromAccess } from "../src/ai/assistant/actor.js";
import { loadAgentAccess } from "../src/auth/middleware.js";
import { pluginDeclarations, runAuditedTool } from "../src/ai/assistant.js";
import { prisma } from "../src/db.js";
import { cancelAssistantAction, confirmAssistantAction, createPendingAssistantAction } from "../src/lib/assistantActions.js";
import { cleanupAssistantActionAgents } from "./helpers/assistantActionFixture.js";

const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
const clients = new Set<string>();
let ownerId: string;
let otherId: string;
let securityId: string;
let ownerPhone: string;
let clientId: string;
let firstTask: string;
let secondTask: string;
let originalRoyalScore: boolean | null = null;
const actor = (agentId: string, channel: "crm" | "telegram" = "telegram", telegramPrivate = true) => ({
  agentId, channel, telegramPrivate, can: () => true,
});

async function fixtureClient(input: Partial<Parameters<typeof prisma.client.create>[0]["data"]> = {}) {
  const row = await prisma.client.create({
    data: {
      fullName: "Ассистент тест",
      phone: phone(),
      source: "PHONE_CALL",
      assignedAgentId: ownerId,
      acceptedAt: new Date(),
      ...input,
    },
  });
  clients.add(row.id);
  return row;
}

function fixtureTask(forClient: string, day = 2) {
  return prisma.interaction.create({ data: {
    type: "SYSTEM", notes: "Тест", nextAction: "Позвонить по договору",
    nextActionDate: new Date(Date.UTC(2031, 3, day, 12)), clientId: forClient, actorKind: "AI", subjectAgentId: ownerId,
  } });
}

beforeAll(async () => {
  ownerPhone = phone();
  const owner = await prisma.agent.create({ data: { fullName: "Тест Шабнам агент", phone: ownerPhone, role: "AGENT", passwordHash: "x" } });
  const other = await prisma.agent.create({ data: { fullName: "Тест Шабнам второй", phone: phone(), role: "AGENT", passwordHash: "x" } });
  const security = await prisma.agent.create({ data: { fullName: "Тест Шабнам безопасность", phone: phone(), role: "SECURITY", passwordHash: "x" } });
  [ownerId, otherId, securityId] = [owner.id, other.id, security.id];
  clientId = (await fixtureClient()).id;
  firstTask = (await fixtureTask(clientId)).id;
  secondTask = (await fixtureTask(clientId, 3)).id;
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  originalRoyalScore = settings.royalScoreEnabled;
  await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreEnabled: true } });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: [...clients] } } });
  if (originalRoyalScore !== null) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreEnabled: originalRoyalScore } });
  }
  await cleanupAssistantActionAgents([ownerId, otherId, securityId]);
  await prisma.$disconnect();
});

const clientArgs = (number = phone()) => ({ fullName: "Сафия тест", phone: number, source: "REFERRAL" });

describe("личные действия Шабнам", () => {
  it("объявляет инструменты в CRM и личке, а группы и пересланная речь не могут их вызвать", async () => {
    const access = { role: "AGENT", permissions: new Set<never>() };
    const privateTg = actorFromAccess(ownerId, access, "telegram-private");
    const group = actorFromAccess(ownerId, access, "telegram-group");
    const crm = actorFromAccess(ownerId, access, "crm-private");
    for (const name of ["create_client", "complete_task"]) {
      expect(pluginDeclarations(privateTg, true, "telegram").map(row => row.name)).toContain(name);
      expect(pluginDeclarations(crm, true, "crm").map(row => row.name)).toContain(name);
      expect(pluginDeclarations(group, true, "telegram").map(row => row.name)).not.toContain(name);
      const result = await runAuditedTool({ name, args: {} }, privateTg, {
        channel: "telegram", confirmUi: false, readOnly: true, writeBudget: { left: 1 },
      });
      expect(result).toMatchObject({ code: "READ_ONLY_TURN" });
    }
    await expect(createPendingAssistantAction(actor(ownerId, "telegram", false), "create_client", clientArgs()))
      .rejects.toMatchObject({ code: "PRIVATE_CHAT_REQUIRED" });
  });

  it("готовит короткое превью, создаёт карточку один раз, привязывает к автору и маскирует номер", async () => {
    const args = clientArgs();
    const tg = actor(ownerId);
    const localNumber = args.phone.slice(-9);
    const pending = await createPendingAssistantAction(tg, "create_client", { ...args, phone: localNumber });
    expect(pending.preview.becomes).toMatchObject({ Имя: args.fullName, Телефон: expect.stringContaining("••") });
    expect(JSON.stringify(pending.preview)).not.toContain(localNumber);
    expect(await prisma.client.count({ where: { phone: args.phone } })).toBe(0);
    await expect(confirmAssistantAction(pending.id, actor(ownerId, "telegram", false)))
      .rejects.toMatchObject({ code: "PRIVATE_CHAT_REQUIRED" });
    await expect(cancelAssistantAction(pending.id, actor(ownerId, "telegram", false)))
      .rejects.toMatchObject({ code: "PRIVATE_CHAT_REQUIRED" });
    const outcome = await confirmAssistantAction(pending.id, tg);
    const created = await prisma.client.findUniqueOrThrow({ where: { phone: args.phone } });
    clients.add(created.id);
    expect(created).toMatchObject({
      assignedAgentId: ownerId, acceptedAt: expect.any(Date), assignReason: "self_created", kind: "BUYER", requirementsFieldsKind: "BUYER",
    });
    expect(outcome.action.result).toMatchObject({ clientId: created.id, href: `/clients/${created.shortId}` });
    expect(await confirmAssistantAction(pending.id, tg)).toMatchObject({ replay: true });
    await expect(createPendingAssistantAction(tg, "create_client", args))
      .rejects.toMatchObject({ code: "CLIENT_PHONE_IN_USE" });
  });

  it("не раскрывает чужие карточки и блокирует занятые, удалённые и служебные телефоны", async () => {
    const alternate = phone();
    const trash = await fixtureClient({ deletedAt: new Date() });
    await fixtureClient({ fullName: "Закрытое имя", assignedAgentId: otherId, extraPhones: [alternate] });
    const cases = [
      [alternate.slice(-9), "CLIENT_PHONE_IN_USE"], [trash.phone, "CLIENT_IN_TRASH"], [ownerPhone, "STAFF_PHONE"],
    ];
    for (const [number, code] of cases) {
      const error = await createPendingAssistantAction(actor(ownerId, "crm"), "create_client", clientArgs(number)).catch((err: unknown) => err);
      expect(error).toMatchObject({ code, extra: {} });
      expect(String(error)).not.toContain("Закрытое имя");
    }
    await expect(createPendingAssistantAction(actor(ownerId), "create_client", { fullName: "Фарзона" }))
      .rejects.toMatchObject({ code: "BAD_ARGS", message: "Какой у клиента номер?" });
  });

  it("при двух сотрудниках и разных форматах одного номера создаёт только одну карточку", async () => {
    const args = clientArgs();
    const first = await createPendingAssistantAction(actor(ownerId), "create_client", args);
    const second = await createPendingAssistantAction(actor(otherId, "crm"), "create_client", { ...args, phone: args.phone.slice(-9) });
    const results = await Promise.allSettled([
      confirmAssistantAction(first.id, actor(ownerId)),
      confirmAssistantAction(second.id, actor(otherId, "crm")),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const found = await prisma.client.findMany({ where: { phone: args.phone } });
    for (const row of found) clients.add(row.id);
    expect(found).toHaveLength(1);
  });

  it("возвращает обе похожие задачи, завершает только выбранную и начисляет баллы один раз", async () => {
    const privateTg = actorFromAccess(ownerId, { role: "AGENT", permissions: new Set() }, "telegram-private");
    const candidates = await runAuditedTool({ name: "find_open_tasks", args: { clientId, q: "договору" } }, privateTg, {
      channel: "telegram", confirmUi: true, writeBudget: { left: 1 },
    });
    expect(candidates).toMatchObject({ items: [{ interactionId: firstTask }, { interactionId: secondTask }], hasMore: false });
    await expect(createPendingAssistantAction(actor(ownerId), "complete_task", { clientId }))
      .rejects.toMatchObject({ code: "BAD_ARGS", message: "Какую задачу закрыть?" });
    await expect(createPendingAssistantAction(actor(otherId), "complete_task", { interactionId: firstTask }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createPendingAssistantAction(actor(securityId, "crm"), "complete_task", { interactionId: firstTask }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const pending = await createPendingAssistantAction(actor(ownerId), "complete_task", { interactionId: secondTask });
    expect(pending.preview.was).toMatchObject({ Задача: "Позвонить по договору", Срок: expect.stringContaining("2031-04-03") });
    expect(await prisma.interaction.findUnique({ where: { id: secondTask } })).toMatchObject({ completedAt: null });
    await confirmAssistantAction(pending.id, actor(ownerId));
    expect(await confirmAssistantAction(pending.id, actor(ownerId))).toMatchObject({ replay: true });
    expect(await prisma.interaction.findUnique({ where: { id: secondTask } })).toMatchObject({
      completedAt: expect.any(Date), nextAction: "Позвонить по договору",
    });
    expect(await prisma.interaction.findUnique({ where: { id: firstTask } })).toMatchObject({ completedAt: null });
    expect(await prisma.royalScoreEvent.count({ where: { sourceId: secondTask, agentId: ownerId, kind: "task_on_time" } })).toBe(1);
  });

  it("при переносе после превью требует свежего подтверждения", async () => {
    const crm = actor(ownerId, "crm");
    const pending = await createPendingAssistantAction(crm, "complete_task", { interactionId: firstTask });
    await prisma.interaction.update({ where: { id: firstTask }, data: { nextActionDate: new Date("2031-04-07T08:00:00Z") } });
    await expect(confirmAssistantAction(pending.id, crm)).rejects.toMatchObject({ code: "STALE" });
    expect(await prisma.interaction.findUnique({ where: { id: firstTask } })).toMatchObject({ completedAt: null });
  });

  it("rolls back task, score and audit if writing the assistant result failed, then allows one retry", async () => {
    const crm = actor(ownerId, "crm");
    const tg = actor(ownerId);
    const args = { interactionId: firstTask };
    const pending = await createPendingAssistantAction(crm, "complete_task", args);
    const pendingFromTelegram = await createPendingAssistantAction(tg, "complete_task", args);
    expect(pendingFromTelegram.id).toBe(pending.id);
    await prisma.$executeRaw`CREATE FUNCTION "task_action_fixture_result_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tool = 'complete_task' AND NEW.status = 'EXECUTED' THEN
          RAISE EXCEPTION 'injected assistant action result failure';
        END IF;
        RETURN NEW;
      END;
    $$`;
    try {
      await prisma.$executeRaw`CREATE TRIGGER "task_action_fixture_result_failure" BEFORE UPDATE ON "AssistantAction"
        FOR EACH ROW EXECUTE FUNCTION "task_action_fixture_result_failure"()`;
      await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "CONFIRM_RETRY" });
      expect(await prisma.interaction.findUnique({ where: { id: firstTask } })).toMatchObject({ completedAt: null });
      expect(await prisma.royalScoreEvent.count({ where: { sourceId: firstTask, agentId: ownerId } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: "ASSISTANT_COMPLETE_TASK", meta: { path: ["actionId"], equals: pending.id } } })).toBe(0);
      expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({
        status: "PENDING", confirmedAt: null, executedAt: null,
      });
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS "task_action_fixture_result_failure" ON "AssistantAction"`;
      await prisma.$executeRaw`DROP FUNCTION "task_action_fixture_result_failure"()`;
    }
    const outcomes = await Promise.all([confirmAssistantAction(pending.id, crm), confirmAssistantAction(pending.id, tg)]);
    expect(outcomes.map((outcome) => outcome.replay).sort()).toEqual([false, true]);
    expect(outcomes[0].action.result).toEqual(outcomes[1].action.result);
    expect(await prisma.interaction.findUnique({ where: { id: firstTask } })).toMatchObject({ completedAt: expect.any(Date) });
    expect(await prisma.royalScoreEvent.count({ where: { sourceId: firstTask, agentId: ownerId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "ASSISTANT_COMPLETE_TASK", meta: { path: ["actionId"], equals: pending.id } } })).toBe(1);
  });

  it("recovers the stored result if the database commit acknowledgement is lost", async () => {
    const client = await fixtureClient();
    const task = await fixtureTask(client.id);
    const tg = actor(ownerId);
    const pending = await createPendingAssistantAction(tg, "complete_task", { interactionId: task.id });
    const realTransaction = prisma.$transaction.bind(prisma);
    const transaction = vi.spyOn(prisma, "$transaction");
    transaction.mockImplementationOnce((async (...args: Parameters<typeof realTransaction>) => {
      await realTransaction(...args);
      throw new Error("injected loss of commit acknowledgement");
    }) as typeof prisma.$transaction);
    try {
      const recovered = await confirmAssistantAction(pending.id, tg);
      expect(recovered).toMatchObject({ action: { status: "EXECUTED", result: { interactionId: task.id } }, replay: true });
      expect(await confirmAssistantAction(pending.id, actor(ownerId, "crm"))).toMatchObject({
        action: { status: "EXECUTED", result: recovered.action.result }, replay: true,
      });
    } finally {
      transaction.mockRestore();
    }
    expect(await prisma.royalScoreEvent.count({ where: { sourceId: task.id, agentId: ownerId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "ASSISTANT_COMPLETE_TASK", meta: { path: ["actionId"], equals: pending.id } } })).toBe(1);
  });

  it("checks current role and assignment before closing or replaying a task", async () => {
    const client = await fixtureClient();
    const task = await fixtureTask(client.id);
    const tg = actor(ownerId);
    const pending = await createPendingAssistantAction(tg, "complete_task", { interactionId: task.id });
    await prisma.agent.update({ where: { id: ownerId }, data: { role: "SHAREHOLDER" } });
    try {
      await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "FORBIDDEN", extra: {} });
      expect(await prisma.interaction.findUnique({ where: { id: task.id } })).toMatchObject({ completedAt: null });
      expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({ status: "PENDING" });
    } finally {
      await prisma.agent.update({ where: { id: ownerId }, data: { role: "AGENT" } });
    }
    await confirmAssistantAction(pending.id, tg);
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: otherId } });
    await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "FORBIDDEN", extra: {} });
    await expect(cancelAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "FORBIDDEN", extra: {} });
    expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({ status: "EXECUTED" });
  });

  it("does not guess whether the assistant completed a legacy confirmed task", async () => {
    const client = await fixtureClient();
    const task = await fixtureTask(client.id);
    const tg = actor(ownerId);
    const pending = await createPendingAssistantAction(tg, "complete_task", { interactionId: task.id });
    await prisma.assistantAction.update({
      where: { id: pending.id }, data: { status: "CONFIRMED", confirmedAt: new Date() },
    });
    await prisma.interaction.update({ where: { id: task.id }, data: { completedAt: new Date() } });
    await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "IN_PROGRESS" });
    expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({
      status: "CONFIRMED", executedAt: null, result: null,
    });
  });

  it("rolls back the client and all audit when final confirmation fails, then retries once", async () => {
    const args = clientArgs();
    const tg = actor(ownerId);
    const pending = await createPendingAssistantAction(tg, "create_client", args);
    const auditsBefore = await prisma.auditLog.count({ where: { agentId: ownerId, entityType: "Client" } });
    await prisma.$executeRaw`CREATE FUNCTION "client_action_fixture_result_failure"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tool = 'create_client' AND NEW.status = 'EXECUTED' THEN
          RAISE EXCEPTION 'injected create client final result failure';
        END IF;
        RETURN NEW;
      END;
    $$`;
    try {
      await prisma.$executeRaw`CREATE TRIGGER "client_action_fixture_result_failure" BEFORE UPDATE ON "AssistantAction"
        FOR EACH ROW EXECUTE FUNCTION "client_action_fixture_result_failure"()`;
      await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "CONFIRM_RETRY" });
      const unexpected = await prisma.client.findUnique({ where: { phone: args.phone } });
      if (unexpected) clients.add(unexpected.id);
      expect(unexpected).toBeNull();
      expect(await prisma.auditLog.count({ where: { agentId: ownerId, entityType: "Client" } })).toBe(auditsBefore);
      expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({
        status: "PENDING", confirmedAt: null, executedAt: null, result: null,
      });
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS "client_action_fixture_result_failure" ON "AssistantAction"`;
      await prisma.$executeRaw`DROP FUNCTION "client_action_fixture_result_failure"()`;
    }
    const outcomes = await Promise.all([confirmAssistantAction(pending.id, actor(ownerId, "crm")), confirmAssistantAction(pending.id, tg)]);
    expect(outcomes.map((outcome) => outcome.replay).sort()).toEqual([false, true]);
    const created = await prisma.client.findUniqueOrThrow({ where: { phone: args.phone } });
    clients.add(created.id);
    expect(created).toMatchObject({ assignedAgentId: ownerId, acceptedAt: expect.any(Date) });
    for (const outcome of outcomes) expect(outcome.action).toMatchObject({
      status: "EXECUTED", result: { clientId: created.id, shortId: created.shortId, href: `/clients/${created.shortId}` },
    });
    expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({
      status: "EXECUTED", result: outcomes[0].action.result, idempotencyKey: null,
    });
    const audit = await prisma.auditLog.findMany({
      where: { entityType: "Client", entityId: created.id }, select: { action: true, meta: true }, orderBy: { action: "asc" },
    });
    expect(audit.map(({ action }) => action)).toEqual(["ASSISTANT_CREATE_CLIENT", "CLIENT_AGENT_CHANGE", "CLIENT_CREATE"]);
    expect(audit[0].meta).toMatchObject({ actionId: pending.id });
    await expect(createPendingAssistantAction(tg, "create_client", args)).rejects.toMatchObject({ code: "CLIENT_PHONE_IN_USE" });
    expect(await prisma.client.count({ where: { phone: args.phone } })).toBe(1);
  });

  it("checks the author and fresh role before creation, and current client scope on replay", async () => {
    const args = clientArgs();
    const tg = actor(ownerId);
    const pending = await createPendingAssistantAction(tg, "create_client", args);
    await expect(confirmAssistantAction(pending.id, actor(otherId, "crm"))).rejects.toMatchObject({
      code: "FORBIDDEN", extra: {},
    });

    // Warm the standard auth cache, then simulate a role change made by another process.
    expect(await loadAgentAccess(ownerId)).toMatchObject({ role: "AGENT" });
    await prisma.agent.update({ where: { id: ownerId }, data: { role: "SHAREHOLDER" } });
    try {
      await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "FORBIDDEN", extra: {} });
      expect(await prisma.client.count({ where: { phone: args.phone } })).toBe(0);
      expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({ status: "PENDING" });
    } finally {
      await prisma.agent.update({ where: { id: ownerId }, data: { role: "AGENT" } });
    }

    const executed = await confirmAssistantAction(pending.id, tg);
    const client = await prisma.client.findUniqueOrThrow({ where: { phone: args.phone } });
    clients.add(client.id);
    expect(await confirmAssistantAction(pending.id, tg)).toMatchObject({ replay: true, action: { result: executed.action.result } });
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: otherId } });
    await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "FORBIDDEN", extra: {} });
    await expect(cancelAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "FORBIDDEN", extra: {} });
    expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({
      status: "EXECUTED", result: executed.action.result,
    });
  });

  it("does not infer a result for a legacy confirmed create_client from a matching phone", async () => {
    const args = clientArgs();
    const tg = actor(ownerId);
    const pending = await createPendingAssistantAction(tg, "create_client", args);
    await prisma.assistantAction.update({ where: { id: pending.id }, data: { status: "CONFIRMED", confirmedAt: new Date() } });
    await fixtureClient({ phone: args.phone, assignedAgentId: otherId });
    await expect(confirmAssistantAction(pending.id, tg)).rejects.toMatchObject({ code: "IN_PROGRESS" });
    expect(await prisma.assistantAction.findUnique({ where: { id: pending.id } })).toMatchObject({
      status: "CONFIRMED", executedAt: null, result: null,
    });
  });
});
