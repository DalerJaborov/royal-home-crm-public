import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import * as OTPAuth from "otpauth";
import type { PermissionId } from "@royal-home/shared";

/**
 * «РЕЖИМ ДИРЕКТОРА» ШАБНАМ (17.11.2026, ai/assistant/tools/directorTools.ts).
 *
 * Держим:
 *  - агент без права получает отказ и в чтении, и в записи (права как у маршрута);
 *  - рубильник: без кода Authenticator — 428, без включённого Authenticator — 412,
 *    из CRM без подтверждения личности — 428; с кодом — переключено, в журнале
 *    SETTINGS_UPDATE и ASSISTANT_SET_SWITCH; откат возвращает прежнее;
 *  - белый список рубильников не содержит ключей, бота для клиентов, звонков, рассылок,
 *    рекламы и платного (сторож ломается нарочно — проверено, что он краснеет);
 *  - решение по заявке: отказ без причины не принимается; отказ с причиной пишет журнал;
 *    «Принять», которое не выполнилось (FAILED), НЕ выдаётся за «готово»;
 *    заявка на удаление клиента — клиент в Корзине;
 *  - журнал ошибок: чтение и «разобрано» с откатом;
 *  - список не длиннее 10 строк и «ещё N»;
 *  - в общей группе Telegram инструменты скрыты.
 */

const sendPushToAgent = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
  closeLeadPushNotifications: vi.fn(async () => {}),
}));

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { grantElevation, revokeElevation } = await import("../src/lib/stepUp.js");
const { invalidateAgentAccess, loadAgentAccess } = await import("../src/auth/middleware.js");
await import("../src/ai/assistant/tools/index.js");
const { findAssistantToolPlugin, listAssistantToolPlugins } = await import("../src/ai/assistant/tools/index.js");
const { DIRECTOR_TOOL_NAMES } = await import("../src/ai/assistant/tools/directorTools.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { pluginDeclarations } = await import("../src/ai/assistant.js");
const { assistantActorFor, groupHiddenToolsForTests } = await import("../src/telegram/assistantBot.js");
const broker = await import("../src/lib/assistantActions.js");
const { SETTINGS_SWITCHES, assertSwitchWhitelistSafe, isForbiddenSwitchKey } = await import("../src/lib/settingsSwitches.js");
const { Prisma } = await import("../src/generated/prisma/client.js");
const { createCardLinkEvidence } = await import("../src/ai/assistant/cardLinkEvidence.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor } = await import("./helpers/waitFor.js");

type Actor = import("../src/lib/assistantActions.js").AssistantActionActor;

const runId = `${Date.now()}`.slice(-7) + randomInt(100, 999);
const phone = () => `+99293${randomInt(1_000_000, 9_999_999)}`;
const SECRET = new OTPAuth.Secret({ size: 20 }).base32;
const agentIds: string[] = [];
const propertyIds: string[] = [];
const clientIds: string[] = [];
const errorIds: string[] = [];
let districtId = "";
let directorId = "";
let noTotpDirectorId = "";
let agentId = "";

/** Рубильник для проверки — без влияния на соседние тесты (только месячный отчёт по крону). */
const SWITCH_KEY = "problemReportMonthlyEnabled";
let switchBefore: boolean | null = null;

async function agent(fullName: string, role: string, extra: Record<string, unknown> = {}) {
  const row = await prisma.agent.create({ data: { fullName, phone: phone(), role: role as never, passwordHash: "x", ...extra } });
  agentIds.push(row.id);
  return row;
}

async function telegramActor(id: string): Promise<Actor> {
  invalidateAgentAccess(id);
  const access = (await loadAgentAccess(id))!;
  return { agentId: id, channel: "telegram", telegramPrivate: true, can: (p: PermissionId) => access.permissions.has(p) };
}
async function crmActor(id: string): Promise<Actor> {
  invalidateAgentAccess(id);
  const access = (await loadAgentAccess(id))!;
  return { agentId: id, channel: "crm", can: (p: PermissionId) => access.permissions.has(p) };
}
const verified = async (id = directorId): Promise<Actor> => ({ ...(await telegramActor(id)), stepUpVerified: true });

async function assistantActor(id: string) {
  invalidateAgentAccess(id);
  const access = (await loadAgentAccess(id))!;
  return actorFromAccess(id, access, "crm-private");
}

async function runRead(name: string, args: Record<string, unknown>, id: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента чтения ${name}`);
  return (await plugin.run(args, { actor: await assistantActor(id) })) as Record<string, unknown>;
}

async function makeProperty(title: string) {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 50000,
      currency: "TJS",
      districtId,
      address: `Директорская, ${propertyIds.length + 1}`,
      condition: "GOOD",
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Режим-директора-${runId}` } })).id;
  directorId = (await agent(`Директор режима ${runId}`, "DIRECTOR", { totpEnabled: true, totpSecret: encryptSecret(SECRET) })).id;
  noTotpDirectorId = (await agent(`Директор без кода ${runId}`, "DIRECTOR")).id;
  agentId = (await agent(`Агент режима ${runId}`, "AGENT")).id;
  const settings = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as unknown as Record<string, unknown> | null;
  switchBefore = typeof settings?.[SWITCH_KEY] === "boolean" ? (settings[SWITCH_KEY] as boolean) : null;
});

afterAll(async () => {
  revokeElevation(directorId);
  if (switchBefore !== null) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { [SWITCH_KEY]: switchBefore } as never });
  }
  await prisma.settingsSnapshot.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.errorLog.deleteMany({ where: { id: { in: errorIds } } });
  await prisma.propertyChangeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await cleanupAssistantActionAgents(agentIds);
});

describe("реестр и стены", () => {
  it("все инструменты режима директора зарегистрированы", () => {
    const names = listAssistantToolPlugins().map((p) => p.name);
    for (const name of DIRECTOR_TOOL_NAMES) expect(names).toContain(name);
  });

  it("в общей группе Telegram скрыты все до одного и модели не объявляются", async () => {
    expect(DIRECTOR_TOOL_NAMES.filter((n) => !groupHiddenToolsForTests().has(n))).toEqual([]);
    const access = (await loadAgentAccess(directorId))!;
    const group = assistantActorFor(directorId, access, "group");
    const declared = pluginDeclarations(group, true, "telegram").map((d) => d.name);
    expect(declared.filter((n) => (DIRECTOR_TOOL_NAMES as readonly string[]).includes(n))).toEqual([]);
  });

  it("агент без права: чтение отвечает отказом, карточку записи не создать", async () => {
    expect(await runRead("list_pending_requests", {}, agentId)).toHaveProperty("error");
    expect(await runRead("get_error_log", {}, agentId)).toHaveProperty("error");
    expect(await runRead("get_system_health", {}, agentId)).toHaveProperty("error");
    expect(await runRead("list_switches", {}, agentId)).toHaveProperty("error");
    await expect(broker.createPendingAssistantAction(await telegramActor(agentId), "set_switch", { key: SWITCH_KEY, on: false }))
      .rejects.toMatchObject({ status: 403 });
    await expect(broker.createPendingAssistantAction(await telegramActor(agentId), "decide_request", {
      type: "client_delete", requestId: "00000000-0000-4000-8000-000000000000", decision: "approve",
    })).rejects.toMatchObject({ status: 403 });
    await expect(broker.createPendingAssistantAction(await telegramActor(agentId), "resolve_error", { errorId: "x" }))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe("белый список рубильников — сторож", () => {
  it("ни одного ключа, бота для клиентов, звонков, рассылок, рекламы, платного и входа", () => {
    for (const s of SETTINGS_SWITCHES) expect(isForbiddenSwitchKey(s.key), s.key).toBe(false);
    for (const bad of [
      "botEnabled", "botCanFollowUp", "followUpEnabled", "reactivationEnabled", "postShowingCallEnabled", "liveVoiceEnabled",
      "askClientsToConfirmShowings", "matchNotifyPropertyOwner", "metaAdsEnabled", "autoPublishEnabled", "instagramStoriesEnabled",
      "digestsEnabled", "groundedSearchEnabled", "semanticSearchEnabled", "aiAssistantEnabled", "passkeyLoginEnabled",
      "metaEnabled", "geminiApiKey", "metaPageToken", "botSystemPrompt", "callWhisperAiHint", "telegramDirectMessagesEnabled",
      "clipReviewEnabled", "handoverClientsToHighKpi", "incomingAutoCreateClient", "propertyPhotoEnhanceEnabled",
    ]) {
      expect(isForbiddenSwitchKey(bad), bad).toBe(true);
    }
  });

  it("сторож краснеет, если запрещённое попало в список (ломаем нарочно)", () => {
    expect(() => assertSwitchWhitelistSafe([...SETTINGS_SWITCHES, { key: "botEnabled", label: "x", hint: "x", defaultOn: true }])).toThrow();
    expect(() => assertSwitchWhitelistSafe([...SETTINGS_SWITCHES, SETTINGS_SWITCHES[0]])).toThrow();
    expect(() => assertSwitchWhitelistSafe(SETTINGS_SWITCHES)).not.toThrow();
  });

  it("каждый рубильник — настоящее поле настроек", () => {
    const fields = new Set<string>(Object.values(Prisma.SettingsScalarFieldEnum));
    for (const s of SETTINGS_SWITCHES) expect(fields.has(s.key), s.key).toBe(true);
  });
});

describe("рубильник: код Google Authenticator и подтверждение личности", () => {
  it("без включённого Authenticator карточка в Telegram не создаётся (412)", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(noTotpDirectorId), "set_switch", { key: SWITCH_KEY, on: false }))
      .rejects.toMatchObject({ status: 412, code: "TOTP_REQUIRED" });
  });

  it("без кода — 428 и ничего не меняется; с кодом — переключено, журнал; откат возвращает", async () => {
    const before = (await runRead("list_switches", { key: SWITCH_KEY }, directorId)) as { switches: Array<{ on: boolean }> };
    const was = before.switches[0]!.on;
    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "set_switch", { key: SWITCH_KEY, on: !was });

    await expect(broker.confirmAssistantAction(card.id, await telegramActor(directorId))).rejects.toMatchObject({ status: 428, code: "STEP_UP_REQUIRED" });
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: card.id } })).status).toBe("PENDING");

    const done = await broker.confirmAssistantAction(card.id, await verified());
    expect(done.action.status).toBe("EXECUTED");
    const now = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })) as unknown as Record<string, unknown>;
    expect(now[SWITCH_KEY]).toBe(!was);
    await waitFor(async () => (await prisma.auditLog.count({ where: { agentId: directorId, action: "SETTINGS_UPDATE" } })) >= 1);
    await waitFor(async () => (await prisma.auditLog.count({ where: { agentId: directorId, action: "ASSISTANT_SET_SWITCH" } })) >= 1);

    await expect(broker.undoAssistantAction(card.id, await telegramActor(directorId))).rejects.toMatchObject({ status: 428 });
    await broker.undoAssistantAction(card.id, await verified());
    const back = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } })) as unknown as Record<string, unknown>;
    expect(back[SWITCH_KEY]).toBe(was);
  });

  it("из CRM — только в окне подтверждения личности", async () => {
    const was = ((await runRead("list_switches", { key: SWITCH_KEY }, directorId)) as { switches: Array<{ on: boolean }> }).switches[0]!.on;
    const card = await broker.createPendingAssistantAction(await crmActor(directorId), "set_switch", { key: SWITCH_KEY, on: !was });
    await expect(broker.confirmAssistantAction(card.id, await crmActor(directorId))).rejects.toMatchObject({ status: 428 });
    grantElevation(directorId, 1);
    try {
      const done = await broker.confirmAssistantAction(card.id, await crmActor(directorId));
      expect(done.action.status).toBe("EXECUTED");
      await broker.undoAssistantAction(card.id, await crmActor(directorId));
    } finally {
      revokeElevation(directorId);
    }
  });

  it("рубильник вне белого списка не принимается даже директором", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "set_switch", { key: "botEnabled", on: false }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe("решения по заявкам", () => {
  it("отказ без причины не принимается; с причиной — REJECTED, журнал, агенту уведомление", async () => {
    const property = await makeProperty("Отказ по заявке");
    const request = await prisma.propertyChangeRequest.create({
      data: { propertyId: property.id, authorId: agentId, kind: "OTHER", payload: { text: "Поменять фото" } },
    });
    const pending = (await runRead("list_pending_requests", { kind: "change" }, directorId)) as {
      changeRequests: { total: number; items: Array<{ requestId: string }> };
    };
    expect(pending.changeRequests.total).toBeGreaterThanOrEqual(1);

    await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "decide_request", {
      type: "change", requestId: request.id, decision: "reject",
    })).rejects.toMatchObject({ status: 400, code: "NOTE_REQUIRED" });

    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "decide_request", {
      type: "change", requestId: request.id, decision: "reject", note: "Собственник не подтвердил",
    });
    const done = await broker.confirmAssistantAction(card.id, await telegramActor(directorId));
    expect(done.action.status).toBe("EXECUTED");
    const after = await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after).toMatchObject({ status: "REJECTED", decidedById: directorId, decisionNote: "Собственник не подтвердил" });
    expect(sendPushToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({ title: "Заявка отклонена" }));
    await waitFor(async () => (await prisma.auditLog.count({ where: { agentId: directorId, action: "PROPERTY_CHANGE_REQUEST_DECIDED", entityId: property.id } })) === 1);

    // Второе решение по той же заявке — честный отказ, а не вторая запись.
    await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "decide_request", {
      type: "change", requestId: request.id, decision: "approve",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("«Принять», которое не выполнилось (FAILED), не выдаётся за «готово»", async () => {
    const property = await makeProperty("Сбой заявки");
    // Повреждённое тело цены: исполнитель ставит заявке FAILED, но отвечает ok (Т2).
    const request = await prisma.propertyChangeRequest.create({
      data: { propertyId: property.id, authorId: agentId, kind: "PRICE_CHANGE", payload: {} },
    });
    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "decide_request", {
      type: "change", requestId: request.id, decision: "approve",
    });
    await expect(broker.confirmAssistantAction(card.id, await telegramActor(directorId)))
      .rejects.toMatchObject({ code: "APPLY_FAILED" });
    expect((await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("FAILED");
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: card.id } })).status).toBe("FAILED");
  });

  it("одобрение заявки на удаление клиента — клиент в Корзине", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Удаляемый ${runId}`, phone: phone(), kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    });
    clientIds.push(client.id);
    const request = await prisma.clientDeleteRequest.create({ data: { clientId: client.id, requestedById: agentId, reason: "OTHER", comment: "пустышка" } });
    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "decide_request", {
      type: "client_delete", requestId: request.id, decision: "approve",
    });
    const done = await broker.confirmAssistantAction(card.id, await telegramActor(directorId));
    expect(done.action.status).toBe("EXECUTED");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).not.toBeNull();
    expect((await prisma.clientDeleteRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("APPROVED");
  });

  it("в списке не больше 10 строк и «ещё N»", async () => {
    const property = await makeProperty("Много заявок");
    await prisma.propertyChangeRequest.createMany({
      data: Array.from({ length: 11 }, (_, i) => ({ propertyId: property.id, authorId: agentId, kind: "OTHER" as const, payload: { text: `№${i}` } })),
    });
    const pending = (await runRead("list_pending_requests", { kind: "change" }, directorId)) as {
      changeRequests: { total: number; more: number; items: unknown[] };
    };
    expect(pending.changeRequests.items.length).toBeLessThanOrEqual(10);
    expect(pending.changeRequests.total).toBeGreaterThanOrEqual(11);
    expect(pending.changeRequests.more).toBe(pending.changeRequests.total - pending.changeRequests.items.length);

    // Ссылка на карточку из списка заявок проходит сторож ссылок; чужая — нет.
    const guard = createCardLinkEvidence();
    guard.observe("list_pending_requests", pending);
    const href = (pending.changeRequests.items[0] as { propertyHref: string }).propertyHref;
    expect(guard.validate(`Смотрите ${href}`).ok).toBe(true);
    expect(guard.validate("/properties/999999999").ok).toBe(false);
  });
});

describe("журнал ошибок и здоровье", () => {
  it("ошибка видна в журнале; «разобрано» с откатом", async () => {
    const row = await prisma.errorLog.create({ data: { source: "api", message: `Режим директора: проверочная ошибка ${runId}` } });
    errorIds.push(row.id);
    const log = (await runRead("get_error_log", {}, directorId)) as { unresolved: number; latest: Array<{ errorId: string }> };
    expect(log.unresolved).toBeGreaterThanOrEqual(1);

    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "resolve_error", { errorId: row.id });
    const done = await broker.confirmAssistantAction(card.id, await telegramActor(directorId));
    expect(done.action.status).toBe("EXECUTED");
    expect((await prisma.errorLog.findUniqueOrThrow({ where: { id: row.id } })).resolvedById).toBe(directorId);

    await broker.undoAssistantAction(card.id, await telegramActor(directorId));
    expect((await prisma.errorLog.findUniqueOrThrow({ where: { id: row.id } })).resolvedAt).toBeNull();
  });

  it("здоровье системы: база отвечает, разделы на месте", async () => {
    const health = (await runRead("get_system_health", {}, directorId)) as Record<string, unknown>;
    expect(health.database).toBe("отвечает");
    expect(health).toHaveProperty("channels");
    expect(health).toHaveProperty("stuckWork");
    expect(health).toHaveProperty("errorsLast24h");
  });
});
