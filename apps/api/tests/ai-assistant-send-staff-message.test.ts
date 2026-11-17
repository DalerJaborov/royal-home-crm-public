import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import type { PermissionId } from "@royal-home/shared";

/**
 * send_staff_message — «напиши коллеге, чтобы оплатил» (17.11.2026,
 * ai/assistant/tools/sendStaffMessageTool.ts).
 *
 * Идёт через настоящий брокер подтверждений и настоящую дверь sendStaffNotice. Подменена
 * только отправка в Telegram (как в shabnam-own-delete-notice.test.ts); ИИ не участвует.
 *
 * Имена сотрудников — без цифр (инструмент отвергает номер вместо имени), уникальность
 * прогона — буквами из runId.
 */
const { sendHtmlMessage } = vi.hoisted(() => {
  let id = 7000;
  return { sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({ message_id: ++id })) };
});
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage,
}));

const { prisma } = await import("../src/db.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { STAFF_MESSAGE_DAILY_LIMIT, STAFF_MESSAGE_MAX_CHARS } = await import("../src/ai/assistant/tools/sendStaffMessageTool.js");
const { setKindMuted } = await import("../src/lib/notificationPrefs.js");
const { parseNoticeIntent } = await import("../src/telegram/staffNotice.js");
const { groupHiddenToolsForTests, renderBundleCard } = await import("../src/telegram/assistantBot.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor } = await import("./helpers/waitFor.js");

const TOOL = "send_staff_message";
const runId = String(Date.now()).slice(-7);
/** Буквы вместо цифр: имя получателя не должно содержать цифр. */
const tag = runId.replace(/\d/g, (d) => "бвгджзклмн"[Number(d)]);

const ids = { sender: "", limited: "", recipient: "", twinA: "", twinB: "", noTelegram: "", shareholder: "" };
const names = {
  sender: `Отправитель Ш${tag}`,
  limited: `Болтун Ш${tag}`,
  recipient: `Получатель Ш${tag}`,
  twinA: `Двойник Ш${tag} Первый`,
  twinB: `Двойник Ш${tag} Второй`,
  noTelegram: `Безтелеграмов Ш${tag}`,
  shareholder: `Акционеров Ш${tag}`,
};
const chats: Record<string, string> = {};
const clientIds: string[] = [];

async function mkAgent(key: keyof typeof ids, role: "AGENT" | "SHAREHOLDER", telegram: boolean) {
  const chat = String(880_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const agent = await prisma.agent.create({
    data: {
      fullName: names[key],
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role,
      passwordHash: await bcrypt.hash("testpass123", 4),
      ...(telegram ? { telegramChatId: chat, telegramUserId: chat } : {}),
    },
  });
  ids[key] = agent.id;
  if (telegram) chats[key] = chat;
}

const sentTo = (key: string) => sendHtmlMessage.mock.calls.filter((c) => c[0] === chats[key]);

async function refused(agentId: string, args: Record<string, unknown>, actorOver: Record<string, unknown> = {}) {
  const err = await createPendingAssistantAction({ ...actorFor(agentId), ...actorOver }, TOOL, args).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AssistantActionError);
  return err as InstanceType<typeof AssistantActionError>;
}

beforeAll(async () => {
  await mkAgent("sender", "AGENT", true);
  await mkAgent("limited", "AGENT", false);
  await mkAgent("recipient", "AGENT", true);
  await mkAgent("twinA", "AGENT", true);
  await mkAgent("twinB", "AGENT", true);
  await mkAgent("noTelegram", "AGENT", false);
  await mkAgent("shareholder", "SHAREHOLDER", true);
});

beforeEach(() => sendHtmlMessage.mockClear());

afterAll(async () => {
  const agents = Object.values(ids);
  await prisma.staffNotice.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await cleanupAssistantActionAgents(agents);
  await prisma.$disconnect();
});

describe("send_staff_message — превью и отправка", () => {
  it("превью ничего не шлёт и показывает точный текст; «Подтвердить» шлёт один раз, с подписью «от кого»", async () => {
    const text = "Пожалуйста, оплатите счёт за <b>рекламу</b> до вечера";
    const actor = actorFor(ids.sender);
    const pending = await createPendingAssistantAction(actor, TOOL, { to: names.recipient, text });
    expect(pending.preview.becomes).toEqual({ Сообщение: text });
    expect(pending.preview.was).toEqual({ Кому: names.recipient });
    expect(pending.preview.irreversible).toBe(true);
    expect(sendHtmlMessage).not.toHaveBeenCalled();

    const done = await confirmAssistantAction(pending.id, actor);
    expect(done.replay).toBe(false);
    expect(done.action.status).toBe("EXECUTED");
    expect(done.action.undoUntil).toBeNull();
    const again = await confirmAssistantAction(pending.id, actor);
    expect(again.replay).toBe(true);

    const sent = sentTo("recipient");
    expect(sent).toHaveLength(1);
    const html = String(sent[0][1]);
    expect(html).toContain(`Сообщение от ${names.sender}`);
    // Текст — данные: разметка из него экранирована, а не исполнена.
    expect(html).toContain("&lt;b&gt;рекламу&lt;/b&gt;");
    // Под сообщением — «🔕 Не присылать такое» именно этого вида.
    expect(JSON.stringify(sent[0][3])).toContain("nm:staff_message");
    // Журнал: брокер записал, кому ушло.
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { agentId: ids.sender, action: "ASSISTANT_SEND_STAFF_MESSAGE" } }));
    expect(audit?.entityId).toBe(ids.recipient);
  });

  it("имя в падеже («Получателю …») находит того же сотрудника", async () => {
    const pending = await createPendingAssistantAction(actorFor(ids.sender), TOOL, { to: `Получателю Ш${tag}`, text: "Привет" });
    expect(pending.preview.was).toEqual({ Кому: names.recipient });
  });

  it("карточка в Telegram показывает длинный текст целиком, без обрезки", async () => {
    const long = `Начало. ${"длинный текст ".repeat(60)}Конец.`;
    expect(long.length).toBeLessThanOrEqual(STAFF_MESSAGE_MAX_CHARS);
    const pending = await createPendingAssistantAction(actorFor(ids.sender), TOOL, { to: names.recipient, text: long });
    const card = renderBundleCard([pending], names.sender);
    expect(card).toContain(long);
    expect(card).toContain(`Сообщение для ${names.recipient}`);
  });

  it("длиннее предела — отказ до карточки", async () => {
    const err = await refused(ids.sender, { to: names.recipient, text: "а".repeat(STAFF_MESSAGE_MAX_CHARS + 1) });
    expect(err.status).toBe(400);
  });
});

describe("send_staff_message — кому нельзя", () => {
  it("получатель без Telegram — честный отказ с подсказкой, ничего не ушло", async () => {
    const err = await refused(ids.sender, { to: names.noTelegram, text: "Перезвоните мне" });
    expect(err.code).toBe("NO_TELEGRAM");
    expect(err.message).toMatch(/привяж/);
    expect(sendHtmlMessage).not.toHaveBeenCalled();
  });

  it("клиент по имени, неизвестное имя, номер или ссылка — отказ: клиентам так не пишем", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Клиентов Ш${tag}`, phone: `+99278${runId}`, source: "WEBSITE", kind: "BUYER" } as never,
    });
    clientIds.push(client.id);
    expect((await refused(ids.sender, { to: `Клиентов Ш${tag}`, text: "Здравствуйте" })).code).toBe("STAFF_NOT_FOUND");
    expect((await refused(ids.sender, { to: `Никтоев Ш${tag}`, text: "Здравствуйте" })).code).toBe("STAFF_NOT_FOUND");
    expect((await refused(ids.sender, { to: client.phone, text: "Здравствуйте" })).code).toBe("NOT_STAFF_NAME");
    expect((await refused(ids.sender, { to: "@someone", text: "Здравствуйте" })).code).toBe("NOT_STAFF_NAME");
    expect(sendHtmlMessage).not.toHaveBeenCalled();
  });

  it("несколько подходящих — список кандидатов, выбирать за человека нельзя", async () => {
    const err = await refused(ids.sender, { to: `Двойник Ш${tag}`, text: "Привет" });
    expect(err.code).toBe("STAFF_AMBIGUOUS");
    expect(err.extra.candidates).toEqual(expect.arrayContaining([names.twinA, names.twinB]));
  });

  it("себе — отказ", async () => {
    expect((await refused(ids.sender, { to: names.sender, text: "Себе" })).code).toBe("SELF");
  });

  it("получатель выключил «Сообщения от коллег» — отказ до карточки; словами это тоже выключается", async () => {
    expect(parseNoticeIntent("не присылай мне сообщения коллег")).toEqual({ type: "mute", kind: "staff_message", explicit: true });
    await setKindMuted(ids.twinA, "staff_message", true);
    try {
      expect((await refused(ids.sender, { to: names.twinA, text: "Привет" })).code).toBe("RECIPIENT_MUTED");
    } finally {
      await setKindMuted(ids.twinA, "staff_message", false);
    }
  });
});

describe("send_staff_message — кто и где", () => {
  it("акционер (только просмотр) не может: не объявляется и отказывает", async () => {
    const err = await refused(ids.shareholder, { to: names.recipient, text: "Привет" });
    expect(err.code).toBe("READ_ONLY_ROLE");
    const plugin = findAssistantToolPlugin(TOOL)!;
    const shareholder = actorFromAccess(ids.shareholder, { role: "SHAREHOLDER", permissions: new Set<PermissionId>() }, "crm-private");
    expect(plugin.allowed!(shareholder)).toBe(false);
  });

  it("общая группа Telegram: скрыт (GROUP_HIDDEN_TOOLS), не объявляется и брокер не пускает", async () => {
    expect(groupHiddenToolsForTests().has(TOOL)).toBe(true);
    const plugin = findAssistantToolPlugin(TOOL)!;
    const group = actorFromAccess(ids.sender, { role: "AGENT", permissions: new Set<PermissionId>() }, "telegram-group");
    expect(plugin.allowed!(group)).toBe(false);
    const err = await refused(ids.sender, { to: names.recipient, text: "Привет" }, { channel: "telegram", telegramPrivate: false });
    expect(err.code).toBe("PRIVATE_CHAT_REQUIRED");
    // Личка Telegram — можно.
    const pending = await createPendingAssistantAction({ ...actorFor(ids.sender), channel: "telegram", telegramPrivate: true }, TOOL, { to: names.recipient, text: "Из лички" });
    expect(pending.status).toBe("PENDING");
  });

  it(`не больше ${STAFF_MESSAGE_DAILY_LIMIT} сообщений в сутки от одного человека`, async () => {
    const now = new Date();
    await prisma.assistantAction.createMany({
      data: Array.from({ length: STAFF_MESSAGE_DAILY_LIMIT }, (_, i) => ({
        agentId: ids.limited, channel: "crm", tool: TOOL, args: { to: names.recipient, text: `#${i}` }, argsHash: `limit-${runId}-${i}`,
        preview: { title: "t", was: {}, becomes: {} }, snapshotBefore: {}, status: "EXECUTED" as const,
        expiresAt: new Date(now.getTime() + 600_000), confirmedAt: now, executedAt: now,
      })),
    });
    const err = await refused(ids.limited, { to: names.recipient, text: "Ещё одно" });
    expect(err.code).toBe("DAILY_LIMIT");
    expect(err.status).toBe(429);
    expect(sendHtmlMessage).not.toHaveBeenCalled();
  });
});
