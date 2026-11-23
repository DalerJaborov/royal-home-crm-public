import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import * as OTPAuth from "otpauth";
import request from "supertest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ШАБНАМ: СОТРУДНИКИ И ПРАВА ИЗ TELEGRAM (10.11.2026, владелец: «все возможности
 * директора вплоть от создания или удаления работников и изменения прав»).
 *
 * Держим: права как у REST; только личка; без кода Google Authenticator — ничего;
 * нет Authenticator — честный отказ; неверный код / тот же код / соседний шаг /
 * пять ошибок; «код 123456» и голос; удаление сообщения с кодом и его сбой;
 * истёкшее ожидание; отключение между нажатием и кодом; нажатие не автором;
 * двойное нажатие; STALE; последний директор; ADMIN без permissions.manage;
 * подтверждение из CRM без подтверждения личности (428); сообщение руководству
 * (и из REST, и в ленту CRM); телефоны сотрудников модели не уходят; «↩️ Отменить»;
 * чистка ожиданий и каскад.
 */

const io = vi.hoisted(() => ({
  push: vi.fn(),
  text: vi.fn(async (_chatId: string, _text: string) => ({ message_id: 900 })),
  buttons: vi.fn(async () => ({ message_id: 901 })),
  ack: vi.fn(async (_id: string, _text?: string) => ({})),
  edit: vi.fn(async (_chatId: string, _id: number, _text: string, _buttons?: unknown) => {}),
  del: vi.fn(async (_chatId: string, _id: number) => true),
}));
vi.mock("../src/push.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/push.js")>();
  // Настоящая рассылка (запись в ленту CRM), только с подсмотром — кому и что ушло.
  io.push.mockImplementation((ids: string[], payload: Parameters<typeof original.sendPushToAgents>[1]) => original.sendPushToAgents(ids, payload));
  return { ...original, sendPushToAgents: io.push, sendPushToAgent: vi.fn(async () => 1) };
});
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
const { grantElevation, revokeElevation } = await import("../src/lib/stepUp.js");
const { invalidateAgentAccess, loadAgentAccess } = await import("../src/auth/middleware.js");
await import("../src/ai/assistant/tools/index.js");
const { listAssistantToolPlugins, findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { STAFF_TOOL_NAMES } = await import("../src/ai/assistant/tools/staffToolNames.js");
const { mergePermissionChanges } = await import("../src/ai/assistant/tools/staffWriteTools.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const broker = await import("../src/lib/assistantActions.js");
const bot = await import("../src/telegram/assistantBot.js");
const { STEP_UP_MAX_FAILURES, STEP_UP_RETENTION_MS, parseStepUpCode, startStepUpChallenge, findPendingStepUp, verifyStepUpCode } = await import("../src/telegram/assistantStepUp.js");
const { runAssistantActionsSweep } = await import("../src/jobs/assistantActionsSweep.js");
const { staffNoticeRecipients } = await import("../src/lib/staffSecurityNotify.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor } = await import("./helpers/waitFor.js");

type Actor = import("../src/lib/assistantActions.js").AssistantActionActor;

const runId = `${Date.now()}`.slice(-7) + randomInt(100, 999);
const phone = () => `+99291${randomInt(1_000_000, 9_999_999)}`;
const agentIds: string[] = [];
const SECRET = new OTPAuth.Secret({ size: 20 }).base32;
const tgUser = 7_100_000_000 + randomInt(1, 90_000_000);

let directorId = "";
let director2Id = "";
let adminId = "";
let agentId = "";
let noTotpDirectorId = "";
let directorPhone = "";

async function agent(fullName: string, role: string, extra: Record<string, unknown> = {}) {
  const row = await prisma.agent.create({ data: { fullName, phone: phone(), role: role as never, ...extra } });
  agentIds.push(row.id);
  return row;
}

const totp = (label = directorPhone) =>
  new OTPAuth.TOTP({ issuer: "Royal Home CRM", label, algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(SECRET) });
const codeAtStep = (step: number, label = directorPhone) => totp(label).generate({ timestamp: step * 30_000 + 1_000 });

/** Код шага, ещё не занятого у сотрудника (0, +1, −1 от текущего) — тесты не зависят от границы 30 секунд и от темпа. */
async function freshCode(id = directorId, label = directorPhone): Promise<string> {
  const used = new Set((await prisma.assistantStepUpChallenge.findMany({ where: { agentId: id, usedStep: { not: null } }, select: { usedStep: true } })).map((r) => r.usedStep));
  const now = Math.floor(Date.now() / 30_000);
  for (const off of [0, 1, -1]) if (!used.has(now + off)) return codeAtStep(now + off, label);
  // Все три шага окна заняты прошлыми тестами этой минуты — «проматываем время»: старые
  // принятые коды освобождают шаг так же, как через минуту он вышел бы из окна сам.
  await prisma.assistantStepUpChallenge.updateMany({ where: { agentId: id }, data: { usedStep: null } });
  return codeAtStep(now, label);
}
function wrongCode(): string {
  const now = Math.floor(Date.now() / 30_000);
  const right = new Set([-2, -1, 0, 1, 2].map((off) => codeAtStep(now + off)));
  for (let i = 0; ; i++) {
    const candidate = String(100000 + ((Number(codeAtStep(now)) + 1 + i * 7919) % 900000));
    if (!right.has(candidate)) return candidate;
  }
}

async function telegramActor(id: string, telegramPrivate = true): Promise<Actor> {
  invalidateAgentAccess(id);
  const access = (await loadAgentAccess(id))!;
  return { agentId: id, channel: "telegram", telegramPrivate, can: (p: PermissionId) => access.permissions.has(p) };
}
async function crmActor(id: string): Promise<Actor> {
  invalidateAgentAccess(id);
  const access = (await loadAgentAccess(id))!;
  return { agentId: id, channel: "crm", can: (p: PermissionId) => access.permissions.has(p) };
}
const verified = async (id = directorId) => ({ ...(await telegramActor(id)), stepUpVerified: true });

/** Карточка в Telegram без модели: ожидающее действие, привязанное к связке, как после хода помощницы. */
async function telegramCard(tool: string, args: Record<string, unknown>, by = directorId) {
  const pending = await broker.createPendingAssistantAction(await telegramActor(by), tool, args);
  const bundleId = crypto.randomUUID();
  await prisma.assistantAction.update({ where: { id: pending.id }, data: { bundleId } });
  return { actionId: pending.id, bundleId };
}

let callbackSeq = 0;
function press(bundleId: string, verb: "ok" | "no" | "undo" = "ok", fromUser = tgUser) {
  return bot.handleAssistantCallback({
    id: `staff-${runId}-${++callbackSeq}`,
    from: { id: fromUser },
    message: { chat: { id: tgUser, type: "private" }, message_id: 901 },
    data: `as:${verb}:${bundleId}`,
  } as never);
}

let messageSeq = 5000;
async function sendMessageAs(extra: Record<string, unknown>, by = { id: directorId, fullName: "Директор" }) {
  const msg = { message_id: ++messageSeq, chat: { id: tgUser, type: "private" }, from: { id: tgUser }, ...extra } as never;
  const handled = await bot.handleAssistantStepUpMessage(msg, by);
  await bot.takeDeferredAssistantReply(msg);
  return { handled, messageId: messageSeq };
}
const sendCode = (text: string) => sendMessageAs({ text });

const lastText = () => String(io.text.mock.calls.at(-1)?.[1] ?? "");
const lastEdit = () => io.edit.mock.calls.at(-1);
const statusOf = async (id: string) => (await prisma.assistantAction.findUniqueOrThrow({ where: { id } })).status;
const pushes = (title: string) => io.push.mock.calls.filter((c) => String((c[1] as { title: string }).title).includes(title));
const clearLock = () => prisma.assistantStepUpChallenge.updateMany({ where: { agentId: directorId }, data: { attempts: 0 } });

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
  adminId = (await agent(`Админбезправ${runId}`, "ADMIN", {
    totpEnabled: true, totpSecret: encryptSecret(SECRET), permissions: { granted: [], revoked: ["permissions.manage"] },
  })).id;
});

beforeEach(async () => {
  for (const fn of [io.push, io.text, io.ack, io.edit, io.del]) fn.mockClear();
  await clearLock();
});

afterAll(async () => {
  revokeElevation(directorId);
  const created = await prisma.agent.findMany({ where: { fullName: { contains: `Новичок${runId}` } }, select: { id: true } });
  agentIds.push(...created.map((c) => c.id));
  await cleanupAssistantActionAgents(agentIds);
});

describe("права и канал — как REST", () => {
  it("агент не может завести сотрудника, директор — может подготовить карточку", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(agentId), "create_staff", { fullName: `Новичок${runId} А`, phone: phone(), role: "AGENT" }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const card = await broker.createPendingAssistantAction(await telegramActor(directorId), "create_staff", { fullName: `Новичок${runId} Б`, phone: phone(), role: "AGENT" });
    expect(card.status).toBe("PENDING");
    expect(card.preview.title).toContain("👤");
    await broker.cancelAssistantAction(card.id, await telegramActor(directorId));
  });

  it("в группе — ничего: запись отказывает, а чтение и запись скрыты из инструментов", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(directorId, false), "create_staff", { fullName: `Новичок${runId} В`, phone: phone(), role: "AGENT" }))
      .rejects.toMatchObject({ code: "PRIVATE_CHAT_REQUIRED" });
    const access = (await loadAgentAccess(directorId))!;
    const group = bot.assistantActorFor(directorId, access, "group");
    for (const name of STAFF_TOOL_NAMES) expect(group.hiddenTools?.has(name), name).toBe(true);
    const out = await runAssistantToolPlugin(findAssistantToolPlugin("list_staff")!, {}, actorFromAccess(directorId, access, "telegram-group"), { channel: "telegram" });
    expect(out).toMatchObject({ error: expect.stringContaining("личке") });
  });

  it("каждое имя из списка зарегистрировано; каждая запись — только в личке; step-up — ровно как requireElevation", () => {
    const names = new Set(listAssistantToolPlugins().map((p) => p.name));
    for (const name of STAFF_TOOL_NAMES) expect(names.has(name), name).toBe(true);
    for (const name of STAFF_TOOL_NAMES) {
      const executor = broker.getAssistantActionExecutor(name);
      if (executor) expect(executor.privateTelegram, name).toBe(true);
    }
    for (const name of ["create_staff", "update_staff", "delete_staff", "freeze_staff", "unfreeze_staff", "handover_staff_work", "revert_staff_handover", "reset_staff_2fa", "set_staff_permissions"]) {
      expect(broker.getAssistantActionExecutor(name)?.stepUp, name).toBe(true);
    }
    for (const name of ["pause_staff_leads", "resume_staff_leads", "transfer_property", "change_client_agent"]) {
      expect(broker.getAssistantActionExecutor(name)?.stepUp, name).toBeUndefined();
    }
    expect(broker.getAssistantActionExecutor("change_client_agent")?.privateTelegram).toBe(true);
  });

  it("директор без Google Authenticator получает честный отказ, карточки нет", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(noTotpDirectorId), "create_staff", { fullName: `Новичок${runId} Г`, phone: phone(), role: "AGENT" }))
      .rejects.toMatchObject({ status: 412, code: "TOTP_REQUIRED" });
  });

  it("ADMIN без permissions.manage: свою роль не меняет, чужого админа не трогает, права не раздаёт", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(adminId), "update_staff", { agentId: adminId, changes: { role: "MANAGER" } }))
      .rejects.toMatchObject({ status: 403, message: "Нельзя менять собственную роль" });
    const otherAdmin = await agent(`Админдругой${runId}`, "ADMIN");
    await expect(broker.createPendingAssistantAction(await telegramActor(adminId), "update_staff", { agentId: otherAdmin.id, changes: { fullName: "Подмена" } }))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("раздаёт права") });
    await expect(broker.createPendingAssistantAction(await telegramActor(adminId), "set_staff_permissions", { agentId, grant: ["finance.view"] }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("подтверждение из CRM — только в окне подтверждения личности (428 без него), и для карточки из Telegram тоже", async () => {
    const target = await agent(`Цельcrm${runId}`, "AGENT");
    await expect(broker.createPendingAssistantAction(await crmActor(directorId), "unfreeze_staff", { agentId: target.id }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const { actionId } = await telegramCard("freeze_staff", { agentId: target.id, reason: "проверка подтверждения из CRM" });
    await expect(broker.confirmAssistantAction(actionId, await crmActor(directorId))).rejects.toMatchObject({ status: 428, code: "STEP_UP_REQUIRED" });
    expect(await statusOf(actionId)).toBe("PENDING");
    grantElevation(directorId, 1);
    try {
      const done = await broker.confirmAssistantAction(actionId, await crmActor(directorId));
      expect(done.action.status).toBe("EXECUTED");
    } finally {
      revokeElevation(directorId);
    }
  });
});

describe("код Google Authenticator", () => {
  it("без кода не исполняется ничего; пароль и произвольный текст кодом не считаются", async () => {
    const newPhone = phone();
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Д`, phone: newPhone, role: "AGENT" });
    await expect(broker.confirmAssistantAction(actionId, await telegramActor(directorId))).rejects.toMatchObject({ status: 428, code: "STEP_UP_REQUIRED" });
    await press(bundleId);
    expect(io.ack.mock.calls.at(-1)?.[1]).toMatch(/код/i);
    expect(lastText()).toContain("Google Authenticator");
    expect((await sendCode("мой пароль qwerty123")).handled).toBe(false);
    expect((await sendCode("мой код 123456 и ещё")).handled).toBe(false);
    expect(parseStepUpCode("код 123456")).toBe("123456");
    // 14.11.2026: код с пробелами/тире — тоже код (решает только ожидание кода, ниже).
    expect(parseStepUpCode("123 456")).toBe("123456");
    expect(await prisma.agent.count({ where: { phone: newPhone } })).toBe(0);
    expect(await statusOf(actionId)).toBe("PENDING");
    await press(bundleId, "no");
  });

  it("нажать «Подтвердить» может только автор", async () => {
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Чужой`, phone: phone(), role: "AGENT" });
    await press(bundleId, "ok", tgUser + 1);
    expect(io.ack.mock.calls.at(-1)?.[1]).toMatch(/Привяжите|только автор/);
    expect(await prisma.assistantStepUpChallenge.count({ where: { bundleId } })).toBe(0);
    expect(await statusOf(actionId)).toBe("PENDING");
    await press(bundleId, "no");
  });

  it("голос — «введите цифрами», «код 123456» — код; сообщение удаляется, карточка исполняется один раз", async () => {
    const newPhone = phone();
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Е`, phone: newPhone, role: "AGENT" });
    await press(bundleId);
    const voice = await sendMessageAs({ voice: { file_id: "v", duration: 3 } });
    expect(voice.handled).toBe(true);
    expect(lastText()).toMatch(/цифр/);
    const { handled, messageId } = await sendCode(`код ${await freshCode()}`);
    expect(handled).toBe(true);
    expect(io.del).toHaveBeenCalledWith(String(tgUser), messageId);
    expect(await prisma.agent.count({ where: { phone: newPhone } })).toBe(1);
    expect(await statusOf(actionId)).toBe("EXECUTED");
    expect(String(lastEdit()?.[2] ?? "")).toContain("✅");
  });

  it("код в любой записи — «123 456», «код: 12-34-56», арабские цифры — принимается и удаляется", async () => {
    const arabic = (code: string) => Array.from(code, (d) => String.fromCodePoint(0x0660 + Number(d))).join("");
    const spellings = [
      (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`,
      (c: string) => `Код: ${c.slice(0, 2)}-${c.slice(2, 4)}-${c.slice(4)}`,
      (c: string) => arabic(c),
    ];
    for (const spell of spellings) {
      await clearLock();
      const newPhone = phone();
      const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Запись${spellings.indexOf(spell)}`, phone: newPhone, role: "AGENT" });
      await press(bundleId);
      const { handled, messageId } = await sendCode(spell(await freshCode()));
      expect(handled).toBe(true);
      expect(io.del).toHaveBeenCalledWith(String(tgUser), messageId);
      expect(await statusOf(actionId)).toBe("EXECUTED");
    }
  });

  it("без ожидания кода «123 456» — обычное сообщение, помощнице", async () => {
    const before = io.del.mock.calls.length;
    expect((await sendCode("123 456")).handled).toBe(false);
    expect(io.del.mock.calls.length).toBe(before);
  });

  it("тот же код второй раз — «уже использован», это не ошибка; соседний шаг другой карточке подходит", async () => {
    const used = await prisma.assistantStepUpChallenge.findFirstOrThrow({ where: { agentId: directorId, usedStep: { not: null } }, orderBy: { closedAt: "desc" } });
    const first = await telegramCard("create_staff", { fullName: `Новичок${runId} Ж`, phone: phone(), role: "AGENT" });
    await press(first.bundleId);
    await sendCode(codeAtStep(used.usedStep!));
    expect(lastText()).toMatch(/уже использован/);
    expect((await prisma.assistantStepUpChallenge.aggregate({ where: { agentId: directorId }, _sum: { attempts: true } }))._sum.attempts ?? 0).toBe(0);
    await sendCode(await freshCode());
    expect(await statusOf(first.actionId)).toBe("EXECUTED");
  });

  it("сбой удаления сообщения с кодом — человек узнаёт и удаляет сам", async () => {
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Удал`, phone: phone(), role: "AGENT" });
    await press(bundleId);
    io.del.mockResolvedValueOnce(false);
    await sendCode(await freshCode());
    expect(io.text.mock.calls.some((c) => String(c[1]).includes("удалите его сами"))).toBe(true);
    expect(await statusOf(actionId)).toBe("EXECUTED");
  });

  it("истёкшее ожидание: код не уходит модели, удаляется, ничего не исполняется", async () => {
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} Срок`, phone: phone(), role: "AGENT" });
    await press(bundleId);
    await prisma.assistantStepUpChallenge.updateMany({ where: { bundleId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const { handled, messageId } = await sendCode(await freshCode());
    expect(handled).toBe(true);
    expect(io.del).toHaveBeenCalledWith(String(tgUser), messageId);
    expect(lastText()).toMatch(/Время на код вышло/);
    expect(await statusOf(actionId)).toBe("PENDING");
    await press(bundleId, "no");
  });

  it("между «Подтвердить» и кодом: цель поменяли — STALE; учётку нажавшего отключили — отказ", async () => {
    const target = await agent(`Цельмежду${runId}`, "AGENT");
    const stale = await telegramCard("update_staff", { agentId: target.id, changes: { fullName: `Цельмежду${runId} Новое` } });
    await press(stale.bundleId);
    await prisma.agent.update({ where: { id: target.id }, data: { email: `between${runId}@example.test` } });
    await sendCode(await freshCode());
    expect(String(lastEdit()?.[2] ?? "")).toMatch(/изменились/);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: target.id } })).fullName).toBe(`Цельмежду${runId}`);

    const off = await telegramCard("create_staff", { fullName: `Новичок${runId} Откл`, phone: phone(), role: "AGENT" });
    await press(off.bundleId);
    await prisma.agent.update({ where: { id: directorId }, data: { isActive: false } });
    invalidateAgentAccess(directorId);
    try {
      await sendCode(await freshCode());
      expect(lastText()).toMatch(/отключена/);
      expect(await statusOf(off.actionId)).toBe("CANCELLED");
    } finally {
      await prisma.agent.update({ where: { id: directorId }, data: { isActive: true } });
      invalidateAgentAccess(directorId);
    }
  });

  it("пять неверных кодов: блокировка, отмена карточки, сообщение руководству; новая карточка тоже закрыта", async () => {
    const newPhone = phone();
    const { actionId, bundleId } = await telegramCard("create_staff", { fullName: `Новичок${runId} З`, phone: newPhone, role: "AGENT" });
    await press(bundleId);
    await sendCode(wrongCode());
    expect(lastText()).toMatch(/не подошёл/);
    for (let i = 1; i < STEP_UP_MAX_FAILURES; i++) await sendCode(wrongCode());
    expect(lastText()).toMatch(/Слишком много неверных кодов/);
    expect(await statusOf(actionId)).toBe("CANCELLED");
    await waitFor(() => pushes("Неверные коды").length === 1);
    const [recipients] = pushes("Неверные коды")[0]!;
    expect(recipients).toEqual(expect.arrayContaining([director2Id, adminId]));
    expect(recipients).not.toContain(directorId);
    const next = await telegramCard("create_staff", { fullName: `Новичок${runId} И`, phone: phone(), role: "AGENT" });
    await press(next.bundleId);
    expect(lastText()).toMatch(/Слишком много/);
    expect(await prisma.assistantStepUpChallenge.count({ where: { bundleId: next.bundleId } })).toBe(0);
    expect(await prisma.agent.count({ where: { phone: newPhone } })).toBe(0);
    await press(next.bundleId, "no");
  });
});

describe("исполнение — те же функции, что у REST, и сообщение руководству", () => {
  it("двойное подтверждение с кодом исполняет одно действие", async () => {
    const target = await agent(`Цельзаморозки${runId}`, "AGENT");
    const { actionId } = await telegramCard("freeze_staff", { agentId: target.id, reason: "отпуск по семейным", kind: "VACATION" });
    const actor = await verified();
    const results = await Promise.allSettled([broker.confirmAssistantAction(actionId, actor), broker.confirmAssistantAction(actionId, actor)]);
    expect(results.filter((r) => r.status === "fulfilled" && !r.value.replay)).toHaveLength(1);
    await waitFor(async () => (await prisma.auditLog.count({ where: { action: "AGENT_FREEZE", entityId: target.id } })) === 1);
    await waitFor(() => pushes("заморожен").length === 1);
  });

  it("последнего директора нельзя ни понизить, ни удалить самого себя", async () => {
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

  it("права: директору не настраиваются; агенту — добавляются; одно сообщение директорам и админам, кроме нажавшего, и в ленту CRM", async () => {
    await expect(broker.createPendingAssistantAction(await telegramActor(directorId), "set_staff_permissions", { agentId: director2Id, grant: ["finance.view"] }))
      .rejects.toMatchObject({ code: "DIRECTOR" });
    const { actionId } = await telegramCard("set_staff_permissions", { agentId, grant: ["finance.view"] });
    await broker.confirmAssistantAction(actionId, await verified());
    invalidateAgentAccess(agentId);
    expect((await loadAgentAccess(agentId))!.permissions.has("finance.view")).toBe(true);
    await waitFor(() => pushes("Изменены права").length === 1);
    const [recipients, payload] = pushes("Изменены права")[0]!;
    expect(recipients).toEqual(expect.arrayContaining([director2Id, adminId]));
    expect(recipients).not.toContain(directorId);
    expect((payload as { body: string }).body).toContain("Шабнам в Telegram");
    await waitFor(async () => (await prisma.notification.count({ where: { agentId: director2Id, title: { contains: "Изменены права" } } })) >= 1);
  });

  it("новый сотрудник, смена телефона, передача дел — тоже сообщение руководству", async () => {
    const actor = await verified();
    const created = await telegramCard("create_staff", { fullName: `Новичок${runId} Админ`, phone: phone(), role: "ADMIN" });
    await broker.confirmAssistantAction(created.actionId, actor);
    await waitFor(() => pushes("Новый сотрудник").length === 1);
    const target = await agent(`Цельтелефона${runId}`, "AGENT");
    const phoneCard = await telegramCard("update_staff", { agentId: target.id, changes: { phone: phone() } });
    await broker.confirmAssistantAction(phoneCard.actionId, actor);
    await waitFor(() => pushes("Сменён телефон").length === 1);
    const handover = await telegramCard("handover_staff_work", { agentId: target.id });
    await broker.confirmAssistantAction(handover.actionId, actor);
    await waitFor(() => pushes("Переданы дела").length === 1);
  });

  it("сброс 2FA и удаление — с сообщением руководству", async () => {
    const target = await agent(`Цельудаления${runId}`, "AGENT", { totpEnabled: true, totpSecret: encryptSecret(SECRET) });
    const actor = await verified();
    const reset = await telegramCard("reset_staff_2fa", { agentId: target.id });
    await broker.confirmAssistantAction(reset.actionId, actor);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: target.id } })).totpEnabled).toBe(false);
    await waitFor(() => pushes("Сброшен Google Authenticator").length === 1);
    const del = await telegramCard("delete_staff", { agentId: target.id });
    await broker.confirmAssistantAction(del.actionId, actor);
    await waitFor(() => pushes("удалён").length === 1);
  });

  it("REST: без подтверждения личности — 428; с ним смена прав из CRM тоже сообщает руководству", async () => {
    const token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
    const denied = await request(app).put(`/api/v1/agents/${agentId}/permissions`).set("Authorization", `Bearer ${token}`).send({ granted: [], revoked: [] });
    expect(denied.status).toBe(428);
    grantElevation(directorId, 1);
    try {
      const ok = await request(app).put(`/api/v1/agents/${agentId}/permissions`).set("Authorization", `Bearer ${token}`).send({ granted: [], revoked: [] });
      expect(ok.status).toBe(200);
    } finally {
      revokeElevation(directorId);
    }
    await waitFor(() => pushes("Изменены права").some((c) => String((c[1] as { body: string }).body).includes("в CRM")));
  });

  it("единственный руководитель получает сообщение сам", async () => {
    const lonely = await agent(`Одиночка${runId}`, "DIRECTOR");
    const others = await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true, id: { not: lonely.id } }, select: { id: true } });
    await prisma.agent.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isActive: false } });
    try {
      expect(await staffNoticeRecipients(lonely.id)).toEqual([lonely.id]);
    } finally {
      await prisma.agent.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isActive: true } });
    }
  });
});

describe("телефоны сотрудников модели не уходят", () => {
  it("в списке телефона и почты нет, в карточке — только хвост", async () => {
    const access = (await loadAgentAccess(directorId))!;
    const actor = actorFromAccess(directorId, access, "telegram-private");
    const target = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    const list = (await runAssistantToolPlugin(findAssistantToolPlugin("list_staff")!, { query: `Агенттест${runId}` }, actor, { channel: "telegram" })) as { staff: Record<string, unknown>[] };
    expect(JSON.stringify(list)).not.toContain(target.phone.slice(-7));
    expect(list.staff[0]).not.toHaveProperty("phone");
    const card = (await runAssistantToolPlugin(findAssistantToolPlugin("get_staff_card")!, { agentId }, actor, { channel: "telegram" })) as Record<string, unknown>;
    expect(JSON.stringify(card)).not.toContain(target.phone.slice(-7));
    expect(card.phoneLast2).toBe(`•••${target.phone.slice(-2)}`);
  });
});

describe("«↩️ Отменить» в Telegram", () => {
  it("пауза заявок (без кода): после исполнения есть кнопка, отмена снимает паузу", async () => {
    const target = await agent(`Цельпаузы${runId}`, "AGENT");
    const { actionId, bundleId } = await telegramCard("pause_staff_leads", { agentId: target.id, hours: 4 });
    await press(bundleId);
    expect(await statusOf(actionId)).toBe("EXECUTED");
    expect(JSON.stringify(lastEdit()?.[3] ?? null)).toContain(`as:undo:${bundleId}`);
    await press(bundleId, "undo");
    expect(await statusOf(actionId)).toBe("UNDONE");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: target.id } })).leadsPausedUntil).toBeNull();
  });

  it("права (с кодом): отмена тоже просит код и возвращает прежние права", async () => {
    const target = await agent(`Цельотката${runId}`, "AGENT");
    const { actionId, bundleId } = await telegramCard("set_staff_permissions", { agentId: target.id, grant: ["reports.view"] });
    await press(bundleId);
    await sendCode(await freshCode());
    expect(await statusOf(actionId)).toBe("EXECUTED");
    expect(JSON.stringify(lastEdit()?.[3] ?? null)).toContain(`as:undo:${bundleId}`);
    await press(bundleId, "undo");
    expect(await statusOf(actionId)).toBe("EXECUTED");
    expect(lastText()).toContain("Google Authenticator");
    await sendCode(await freshCode());
    expect(await statusOf(actionId)).toBe("UNDONE");
    invalidateAgentAccess(target.id);
    expect((await loadAgentAccess(target.id))!.permissions.has("reports.view")).toBe(false);
  });
});

describe("откат — граница и гонки (повторное ревью)", () => {
  it("откат роли — одной записью: прежняя роль И прежние личные права", async () => {
    const target = await agent(`Цельроли${runId}`, "AGENT", { permissions: { granted: ["reports.view"], revoked: [] } });
    const { actionId } = await telegramCard("update_staff", { agentId: target.id, changes: { role: "MANAGER" } });
    await broker.confirmAssistantAction(actionId, await verified());
    const changed = await prisma.agent.findUniqueOrThrow({ where: { id: target.id } });
    expect(changed.role).toBe("MANAGER");
    expect(changed.permissions).toBeNull();
    await broker.undoAssistantAction(actionId, await verified());
    const back = await prisma.agent.findUniqueOrThrow({ where: { id: target.id } });
    expect(back.role).toBe("AGENT");
    expect(back.permissions).toEqual({ granted: ["reports.view"], revoked: [] });
  });

  it("отмена через брокер без кода — 428, ничего не откатывается", async () => {
    const target = await agent(`Цельбезкода${runId}`, "AGENT");
    const { actionId } = await telegramCard("set_staff_permissions", { agentId: target.id, grant: ["reports.view"] });
    await broker.confirmAssistantAction(actionId, await verified());
    await expect(broker.undoAssistantAction(actionId, await telegramActor(directorId))).rejects.toMatchObject({ status: 428, code: "STEP_UP_REQUIRED" });
    expect(await statusOf(actionId)).toBe("EXECUTED");
  });

  it("отмена по устаревшей карточке (права поменяли руками) — отказ, ручная правка цела", async () => {
    const target = await agent(`Цельустар${runId}`, "AGENT");
    const { actionId } = await telegramCard("set_staff_permissions", { agentId: target.id, grant: ["reports.view"] });
    await broker.confirmAssistantAction(actionId, await verified());
    const manual = { granted: ["reports.view", "finance.view"], revoked: [] };
    await prisma.agent.update({ where: { id: target.id }, data: { permissions: manual } });
    await expect(broker.undoAssistantAction(actionId, await verified())).rejects.toMatchObject({ code: "UNDO_STALE" });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: target.id } })).permissions).toEqual(manual);
  });

  it("отменить может только автор", async () => {
    const target = await agent(`Цельчужой${runId}`, "AGENT");
    const { actionId, bundleId } = await telegramCard("pause_staff_leads", { agentId: target.id, hours: 2 });
    await press(bundleId);
    expect(await statusOf(actionId)).toBe("EXECUTED");
    await press(bundleId, "undo", tgUser + 1);
    expect(io.ack.mock.calls.at(-1)?.[1]).toMatch(/Привяжите|только автор/);
    expect(await statusOf(actionId)).toBe("EXECUTED");
  });

  it("смешанная связка: не всё отменилось — так и сказано", async () => {
    const a = await agent(`Цельсвязкиа${runId}`, "AGENT");
    const b = await agent(`Цельсвязкиб${runId}`, "AGENT");
    const first = await broker.createPendingAssistantAction(await telegramActor(directorId), "pause_staff_leads", { agentId: a.id, hours: 2 });
    const second = await broker.createPendingAssistantAction(await telegramActor(directorId), "pause_staff_leads", { agentId: b.id, hours: 3 });
    const bundleId = crypto.randomUUID();
    await prisma.assistantAction.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { bundleId } });
    await press(bundleId);
    await prisma.agent.update({ where: { id: b.id }, data: { leadsPausedUntil: new Date(Date.now() + 9 * 3600_000) } });
    await press(bundleId, "undo");
    expect(String(lastEdit()?.[2] ?? "")).toMatch(/Не всё отменено/);
    expect(String(lastEdit()?.[2] ?? "")).toMatch(/Остальное не отменено/);
  });

  it("гонка двух одинаковых кодов на двух карточках: один проходит, второй — «уже использован»", async () => {
    await prisma.assistantStepUpChallenge.updateMany({ where: { agentId: directorId }, data: { usedStep: null } });
    const one = await startStepUpChallenge({ agentId: directorId, chatId: "race-1", bundleId: crypto.randomUUID(), language: "ru" });
    const two = await startStepUpChallenge({ agentId: directorId, chatId: "race-2", bundleId: crypto.randomUUID(), language: "ru" });
    expect(one.kind).toBe("started");
    expect(two.kind).toBe("started");
    const [a, b] = await Promise.all([findPendingStepUp("race-1", directorId), findPendingStepUp("race-2", directorId)]);
    const code = codeAtStep(Math.floor(Date.now() / 30_000));
    const verdicts = await Promise.all([verifyStepUpCode(a!, code), verifyStepUpCode(b!, code)]);
    expect(verdicts.map((v) => v.kind).sort()).toEqual(["passed", "replay"]);
    expect((await prisma.assistantStepUpChallenge.aggregate({ where: { agentId: directorId }, _sum: { attempts: true } }))._sum.attempts ?? 0).toBe(0);
  });
});

describe("слияние прав и уборка", () => {
  it("«добавить»/«снять» по одному поверх текущих, сброс к роли", () => {
    const merged = mergePermissionChanges("AGENT", { granted: [], revoked: [] }, { grant: ["finance.view"], revoke: [] });
    expect(merged.granted).toContain("finance.view");
    const back = mergePermissionChanges("AGENT", merged, { grant: [], revoke: ["finance.view"] });
    expect(back.granted).not.toContain("finance.view");
    expect(mergePermissionChanges("AGENT", merged, { grant: [], revoke: [], resetToRole: true })).toEqual({ granted: [], revoked: [] });
  });

  it("старые ожидания кода чистятся, а при удалении сотрудника уходят каскадом", async () => {
    const old = await prisma.assistantStepUpChallenge.create({
      data: { agentId: directorId, chatId: "sweep", bundleId: crypto.randomUUID(), expiresAt: new Date(), createdAt: new Date(Date.now() - STEP_UP_RETENTION_MS - 60_000) },
    });
    const result = await runAssistantActionsSweep();
    expect(result.stepUpChallengesDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.assistantStepUpChallenge.count({ where: { id: old.id } })).toBe(0);
    const temp = await agent(`Каскад${runId}`, "AGENT");
    await prisma.assistantStepUpChallenge.create({ data: { agentId: temp.id, chatId: "cascade", bundleId: crypto.randomUUID(), expiresAt: new Date() } });
    await prisma.agent.delete({ where: { id: temp.id } });
    expect(await prisma.assistantStepUpChallenge.count({ where: { agentId: temp.id } })).toBe(0);
  });
});
