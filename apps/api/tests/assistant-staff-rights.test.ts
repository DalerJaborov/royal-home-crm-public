import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import * as OTPAuth from "otpauth";
import request from "supertest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ШАБНАМ: СОТРУДНИКИ И ПРАВА ИЗ TELEGRAM (10.11.2026, владелец: «все возможности
 * директора вплоть от создания или удаления работников и изменения прав»).
 *
 * Держим: права как у REST (агент не может, директор может); только личка (в группе
 * инструменты скрыты и отказывают); без кода Google Authenticator — ничего не
 * исполняется; нет Authenticator — честный отказ; неверный код, повтор кода, пять
 * ошибок — блокировка; сообщение с кодом удаляется; двойное нажатие — одно
 * исполнение; STALE; последний директор; одно сообщение директорам (кроме нажавшего);
 * REST без подтверждения личности по-прежнему 428.
 */

const io = vi.hoisted(() => ({
  push: vi.fn(async (_ids: string[], _payload: { title: string; body: string }) => 1),
  text: vi.fn(async (_chatId: string, _text: string) => ({ message_id: 900 })),
  buttons: vi.fn(async () => ({ message_id: 901 })),
  ack: vi.fn(async (_id: string, _text?: string) => ({})),
  edit: vi.fn(async (_chatId: string, _id: number, _text: string, _buttons?: unknown) => {}),
  del: vi.fn(async (_chatId: string, _id: number) => true),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: io.push,
  sendPushToAgent: vi.fn(async () => 1),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: io.text,
  sendMessageWithButtons: io.buttons,
  answerCallbackQuery: io.ack,
  editMessageText: io.edit,
  deletePrivateMessage: io.del,
  setMessageReaction: vi.fn(async () => "sent"),
  sendChatAction: vi.fn(async () => {}),
}));
vi.mock("../src/ai/assistant/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/runtime.js")>()),
  loadAssistantSettings: async () => ({ enabled: true, groundedSearchEnabled: false, semanticSearchEnabled: false }),
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { encryptSecret } = await import("../src/crypto.js");
const { invalidateAgentAccess, loadAgentAccess } = await import("../src/auth/middleware.js");
await import("../src/ai/assistant/tools/index.js");
const { listAssistantToolPlugins, findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { STAFF_TOOL_NAMES } = await import("../src/ai/assistant/tools/staffToolNames.js");
const { mergePermissionChanges } = await import("../src/ai/assistant/tools/staffWriteTools.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const broker = await import("../src/lib/assistantActions.js");
const bot = await import("../src/telegram/assistantBot.js");
const { STEP_UP_MAX_FAILURES } = await import("../src/telegram/assistantStepUp.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = `${Date.now()}`.slice(-7) + randomInt(100, 999);
const phone = () => `+99291${randomInt(1_000_000, 9_999_999)}`;
const agentIds: string[] = [];
const SECRET = new OTPAuth.Secret({ size: 20 }).base32;

let directorId = "";
let director2Id = "";
let agentId = "";
let noTotpDirectorId = "";
let tgUser = 7_100_000_000 + randomInt(1, 90_000_000);
let directorPhone = "";

async function agent(fullName: string, role: string, extra: Record<string, unknown> = {}) {
  const row = await prisma.agent.create({ data: { fullName, phone: phone(), role: role as never, ...extra } });
  agentIds.push(row.id);
  return row;
}

function code(offsetSteps = 0, phoneLabel = directorPhone): string {
  const totp = new OTPAuth.TOTP({ issuer: "Royal Home CRM", label: phoneLabel, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(SECRET) });
  return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}
function wrongCode(): string {
  const right = new Set([code(-1), code(0), code(1)]);
  for (let i = 0; ; i++) {
    const candidate = String(100000 + ((Number(code()) + 1 + i * 7919) % 900000));
    if (!right.has(candidate)) return candidate;
  }
}

async function telegramActor(id: string, telegramPrivate = true): Promise<import("../src/lib/assistantActions.js").AssistantActionActor> {
  invalidateAgentAccess(id);
  const access = (await loadAgentAccess(id))!;
  return { agentId: id, channel: "telegram", telegramPrivate, can: (p: PermissionId) => access.permissions.has(p) };
}

/** Карточка в Telegram без модели: ожидающее действие, привязанное к связке, как после хода помощницы. */
async function telegramCard(tool: string, args: Record<string, unknown>, by = directorId) {
  const pending = await broker.createPendingAssistantAction(await telegramActor(by), tool, args);
  const bundleId = crypto.randomUUID();
  await prisma.assistantAction.update({ where: { id: pending.id }, data: { bundleId } });
  return { actionId: pending.id, bundleId };
}

let callbackSeq = 0;
function press(bundleId: string, verb: "ok" | "no" = "ok", chatType: "private" | "group" = "private") {
  return bot.handleAssistantCallback({
    id: `staff-${runId}-${++callbackSeq}`,
    from: { id: tgUser },
    message: { chat: { id: chatType === "private" ? tgUser : -tgUser, type: chatType }, message_id: 901 },
    data: `as:${verb}:${bundleId}`,
  } as never);
}

let messageSeq = 5000;
async function sendCode(text: string) {
  const msg = { message_id: ++messageSeq, chat: { id: tgUser, type: "private" }, from: { id: tgUser }, text } as never;
  const handled = await bot.handleAssistantStepUpMessage(msg, { id: directorId, fullName: "Директор" });
  await bot.takeDeferredAssistantReply(msg);
  return { handled, messageId: messageSeq };
}

const lastText = () => String(io.text.mock.calls.at(-1)?.[1] ?? "");

beforeAll(async () => {
  directorPhone = phone();
  const director = await prisma.agent.create({
    data: {
      fullName: `Директортест${runId}`, phone: directorPhone, role: "DIRECTOR",
      totpEnabled: true, totpSecret: encryptSecret(SECRET),
      telegramChatId: String(tgUser), telegramUserId: String(tgUser),
    },
  });
  agentIds.push(director.id);
  directorId = director.id;
  director2Id = (await agent(`Директорвторой${runId}`, "DIRECTOR")).id;
  noTotpDirectorId = (await agent(`Директорбезкода${runId}`, "DIRECTOR")).id;
  agentId = (await agent(`Агенттест${runId}`, "AGENT")).id;
});

beforeEach(() => {
  io.push.mockClear();
  io.text.mockClear();
  io.ack.mockClear();
  io.edit.mockClear();
  io.del.mockClear();
});

afterAll(async () => {
  await prisma.assistantStepUpChallenge.deleteMany({ where: { agentId: { in: agentIds } } });
  const created = await prisma.agent.findMany({ where: { fullName: { contains: `Новичок${runId}` } }, select: { id: true } });
  agentIds.push(...created.map((c) => c.id));
  await cleanupAssistantActionAgents(agentIds);
});

describe("права и канал — как REST", () => {
  it("агент не может завести сотрудника, директор — может подготовить карточку", async () => {
    const asAgent = broker.createPendingAssistantAction(await telegramActor(agentId), "create_staff", { fullName: `Новичок${runId} А`, phone: phone(), role: "AGENT" });
    await expect(asAgent).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "create_staff", { fullName: `Новичок${runId} Б`, phone: phone(), role: "AGENT" });
    expect(card.status).toBe("PENDING");
    expect(card.preview.title).toContain("👤");
    await broker.cancelAssistantAction(card.id, await telegramActor(directorId));
  });

  it("в группе — ничего: запись отказывает, а чтение и запись скрыты из инструментов", async () => {
    const groupActor = await telegramActor(directorId, false);
    await expect(broker.createPendingAssistantAction(groupActor, "create_staff", { fullName: `Новичок${runId} В`, phone: phone(), role: "AGENT" }))
      .rejects.toMatchObject({ code: "PRIVATE_CHAT_REQUIRED" });
    const access = (await loadAgentAccess(directorId))!;
    const group = bot.assistantActorFor(directorId, access, "group");
    for (const name of STAFF_TOOL_NAMES) expect(group.hiddenTools?.has(name), name).toBe(true);
    const list = findAssistantToolPlugin("list_staff")!;
    const out = await runAssistantToolPlugin(list, {}, { ...actorFromAccess(directorId, access, "telegram-group") }, { channel: "telegram" });
    expect(out).toMatchObject({ error: expect.stringContaining("личке") });
  });

  it("каждое имя из списка зарегистрировано, и каждая запись — только в личке", () => {
    const names = new Set(listAssistantToolPlugins().map((p) => p.name));
    for (const name of STAFF_TOOL_NAMES) expect(names.has(name), name).toBe(true);
    for (const name of STAFF_TOOL_NAMES) {
      const executor = broker.getAssistantActionExecutor(name);
      if (executor) expect(executor.privateTelegram, name).toBe(true);
    }
  });

  it("всё, что в REST за requireElevation, помечено stepUp; пауза заявок и передача объекта — нет", () => {
    const stepUp = ["create_staff", "update_staff", "delete_staff", "freeze_staff", "unfreeze_staff", "handover_staff_work", "revert_staff_handover", "reset_staff_2fa", "set_staff_permissions"];
    for (const name of stepUp) expect(broker.getAssistantActionExecutor(name)?.stepUp, name).toBe(true);
    for (const name of ["pause_staff_leads", "resume_staff_leads", "transfer_property"]) expect(broker.getAssistantActionExecutor(name)?.stepUp, name).toBeUndefined();
  });

  it("директор без Google Authenticator получает честный отказ, карточки нет", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(noTotpDirectorId), "create_staff", { fullName: `Новичок${runId} Г`, phone: phone(), role: "AGENT" }))
      .rejects.toMatchObject({ status: 412, code: "TOTP_REQUIRED" });
  });
});

describe("код Google Authenticator", () => {
  it("без кода не исполняется ничего: ни брокером напрямую, ни кнопкой", async () => {
    const newPhone = phone();
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Д`, phone: newPhone, role: "AGENT" });
    await expect(broker.confirmAssistantAction(actionId, await telegramActor(directorId))).rejects.toMatchObject({ status: 428, code: "STEP_UP_REQUIRED" });
    await press(bundleId);
    expect(io.ack.mock.calls.at(-1)?.[1]).toMatch(/код/i);
    expect(lastText()).toContain("Google Authenticator");
    expect(await prisma.agent.count({ where: { phone: newPhone } })).toBe(0);
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe("PENDING");
    // Пароль/произвольный текст кодом не считается — уходит обычной дорогой, ничего не исполняет.
    const { handled } = await sendCode("мой пароль qwerty123");
    expect(handled).toBe(false);
    await press(bundleId, "no");
  });

  it("верный код исполняет карточку один раз, сообщение с кодом удаляется", async () => {
    const newPhone = phone();
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Е`, phone: newPhone, role: "AGENT" });
    await press(bundleId);
    const { handled, messageId } = await sendCode(code());
    expect(handled).toBe(true);
    expect(io.del).toHaveBeenCalledWith(String(tgUser), messageId);
    expect(await prisma.agent.count({ where: { phone: newPhone } })).toBe(1);
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe("EXECUTED");
    expect(String(io.edit.mock.calls.at(-1)?.[2] ?? "")).toContain("✅");
  });

  it("тот же код второй раз не проходит (одноразовость)", async () => {
    const used = (await prisma.agent.findUniqueOrThrow({ where: { id: directorId }, select: { assistantTotpLastStep: true } })).assistantTotpLastStep;
    expect(used).not.toBeNull();
    const newPhone = phone();
    const { bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Ж`, phone: newPhone, role: "AGENT" });
    await press(bundleId);
    // Код того же шага, что уже принят.
    const sameStep = new OTPAuth.TOTP({ label: directorPhone, issuer: "Royal Home CRM", secret: OTPAuth.Secret.fromBase32(SECRET) }).generate({ timestamp: used! * 30_000 + 1000 });
    const { messageId } = await sendCode(sameStep);
    expect(lastText()).toMatch(/уже использован/);
    expect(io.del).toHaveBeenCalledWith(String(tgUser), messageId);
    expect(await prisma.agent.count({ where: { phone: newPhone } })).toBe(0);
    await press(bundleId, "no");
    await prisma.assistantStepUpChallenge.updateMany({ where: { agentId: directorId }, data: { attempts: 0 } });
  });

  it("неверный код — отказ и счёт попыток; пятый — блокировка и отмена карточки", async () => {
    const newPhone = phone();
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} З`, phone: newPhone, role: "AGENT" });
    await press(bundleId);
    await sendCode(wrongCode());
    expect(lastText()).toMatch(/не подошёл/);
    for (let i = 1; i < STEP_UP_MAX_FAILURES; i++) await sendCode(wrongCode());
    expect(lastText()).toMatch(/Слишком много неверных кодов/);
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe("CANCELLED");
    // Блокировка держится: даже верный код не принимается, новая карточка кода не просит.
    const next = await telegramCard("create_staff", { fullName: `Новичок${runId} И`, phone: phone(), role: "AGENT" });
    await press(next.bundleId);
    expect(lastText()).toMatch(/закрыто на 15 минут|Слишком много/);
    expect(await prisma.agent.count({ where: { phone: newPhone } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "ASSISTANT_TOTP_LOCKED", agentId: directorId } })).toBeGreaterThan(0);
    await press(next.bundleId, "no");
    await prisma.assistantStepUpChallenge.deleteMany({ where: { agentId: directorId } });
  });
});

describe("исполнение — те же функции, что у REST", () => {
  it("двойное подтверждение с кодом исполняет одно действие", async () => {
    const target = await agent(`Цельзаморозки${runId}`, "AGENT");
    const { actionId } = await telegramCard("freeze_staff", { agentId: target.id, reason: "отпуск по семейным", kind: "VACATION" });
    const actor = { ...(await telegramActor(directorId)), stepUpVerified: true };
    const results = await Promise.allSettled([broker.confirmAssistantAction(actionId, actor), broker.confirmAssistantAction(actionId, actor)]);
    expect(results.filter((r) => r.status === "fulfilled" && !r.value.replay)).toHaveLength(1);
    await waitFor(async () => (await prisma.auditLog.count({ where: { action: "AGENT_FREEZE", entityId: target.id } })) === 1);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: target.id } })).frozenAt).not.toBeNull();
  });

  it("STALE: сотрудника поменяли после карточки — исполнения нет", async () => {
    const target = await agent(`Цельправки${runId}`, "AGENT");
    const { actionId } = await telegramCard("update_staff", { agentId: target.id, changes: { fullName: `Цельправки${runId} Новое` } });
    await prisma.agent.update({ where: { id: target.id }, data: { email: `stale${runId}@example.test` } });
    const actor = { ...(await telegramActor(directorId)), stepUpVerified: true };
    await expect(broker.confirmAssistantAction(actionId, actor)).rejects.toMatchObject({ code: "STALE" });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: target.id } })).fullName).toBe(`Цельправки${runId}`);
  });

  it("последнего директора нельзя ни понизить, ни отключить", async () => {
    const others = await prisma.agent.findMany({ where: { role: "DIRECTOR", isActive: true, id: { not: directorId } }, select: { id: true } });
    await prisma.agent.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isActive: false } });
    try {
      await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "update_staff", { agentId: directorId, changes: { role: "ADMIN" } }))
        .rejects.toMatchObject({ status: 409, code: "LAST_DIRECTOR" });
      await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "delete_staff", { agentId: directorId }))
        .rejects.toMatchObject({ code: "SELF" });
    } finally {
      await prisma.agent.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isActive: true } });
    }
  });

  it("права: директору не настраиваются; агенту — добавляются, и директора (кроме нажавшего) получают одно сообщение", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "set_staff_permissions", { agentId: director2Id, grant: ["finance.view"] }))
      .rejects.toMatchObject({ code: "DIRECTOR" });
    const { actionId } = await telegramCard("set_staff_permissions", { agentId, grant: ["finance.view"] });
    const actor = { ...(await telegramActor(directorId)), stepUpVerified: true };
    await broker.confirmAssistantAction(actionId, actor);
    invalidateAgentAccess(agentId);
    expect((await loadAgentAccess(agentId))!.permissions.has("finance.view")).toBe(true);
    await waitFor(() => io.push.mock.calls.some((c) => String(c[1].title).includes("Изменены права")));
    const call = io.push.mock.calls.find((c) => String(c[1].title).includes("Изменены права"))!;
    expect(call[0]).toContain(director2Id);
    expect(call[0]).not.toContain(directorId);
    expect(io.push.mock.calls.filter((c) => String(c[1].title).includes("Изменены права"))).toHaveLength(1);
    expect(call[1].body).toContain("Шабнам");
  });

  it("сброс 2FA и удаление — тоже с сообщением директорам", async () => {
    const target = await agent(`Цельудаления${runId}`, "AGENT", { totpEnabled: true, totpSecret: encryptSecret(SECRET) });
    const actor = { ...(await telegramActor(directorId)), stepUpVerified: true };
    const reset = await telegramCard("reset_staff_2fa", { agentId: target.id });
    await broker.confirmAssistantAction(reset.actionId, actor);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled).toBe(false);
    await waitFor(() => io.push.mock.calls.some((c) => String(c[1].title).includes("Google Authenticator")));
    const del = await telegramCard("delete_staff", { agentId: target.id });
    await broker.confirmAssistantAction(del.actionId, actor);
    await waitFor(() => io.push.mock.calls.some((c) => String(c[1].title).includes("удалён")));
  });

  it("слияние прав: «добавить»/«снять» по одному поверх текущих, сброс к роли", () => {
    const merged = mergePermissionChanges("AGENT", { granted: [], revoked: [] }, { grant: ["finance.view"], revoke: [] });
    expect(merged.granted).toContain("finance.view");
    const back = mergePermissionChanges("AGENT", merged, { grant: [], revoke: ["finance.view"] });
    expect(back.granted).not.toContain("finance.view");
    expect(mergePermissionChanges("AGENT", merged, { grant: [], revoke: [], resetToRole: true })).toEqual({ granted: [], revoked: [] });
  });

  it("REST не изменился: без подтверждения личности смена прав — 428", async () => {
    const token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
    const res = await request(app).put(`/api/v1/agents/${agentId}/permissions`).set("Authorization", `Bearer ${token}`).send({ granted: [], revoked: [] });
    expect(res.status).toBe(428);
  });
});
