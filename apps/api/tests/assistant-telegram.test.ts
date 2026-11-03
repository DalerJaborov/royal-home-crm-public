import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * ВНУТРЕННИЙ ПОМОЩНИК В TELEGRAM (П5, telegram/assistantBot.ts): личка и общая группа.
 *
 * Модель и Telegram подменены: тест проверяет дыры ПРАВ и повторов, а не ответы
 * Gemini. «Модель» (runAssistantDetailed) создаёт настоящие ожидающие действия через
 * брокер lib/assistantActions.ts — тот же путь, что у настоящих инструментов.
 */

const { sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, react, runner, transcribe, fetchAudio, claimCap } =
  vi.hoisted(() => ({
    sendMessage: vi.fn(async (_chatId: string, _text: string, _reply?: number) => ({})),
    sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown, _r?: number) => ({ message_id: 501 })),
    answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
    editMessageText: vi.fn(async (_c: string, _m: number, _t: string, _b?: unknown) => {}),
    react: vi.fn(async (_c: string, _m: number, _e: string) => {}),
    runner: vi.fn(),
    transcribe: vi.fn(),
    fetchAudio: vi.fn(),
    claimCap: vi.fn(),
  }));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendMessageWithButtons,
  answerCallbackQuery,
  editMessageText,
  setMessageReaction: react,
  getBotUsername: async () => "rh_test_bot",
  sendChatAction: async () => {},
}));
vi.mock("../src/ai/assistant.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/assistant.js")>()),
  isAiAssistantEnabled: async () => true,
  runAssistantDetailed: runner,
}));
vi.mock("../src/ai/transcribe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/transcribe.js")>()),
  transcribeAudio: transcribe,
}));
vi.mock("../src/telegram/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/attachments.js")>()),
  fetchTelegramAttachments: fetchAudio,
}));
vi.mock("../src/lib/agentAiActionCap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/agentAiActionCap.js")>()),
  claimAgentAiAction: claimCap,
}));

delete process.env.TELEGRAM_BOT_TOKEN;
process.env.CRM_PUBLIC_URL = "https://crm.test";

const { prisma } = await import("../src/db.js");
const { handleTelegramUpdate } = await import("../src/telegram/bot.js");
const { invalidateAgentAccess } = await import("../src/auth/middleware.js");
const { createPendingAssistantAction } = await import("../src/lib/assistantActions.js");
const { tryLinkAgentByCode, createTelegramLinkCode } = await import("../src/lib/telegramAgentLink.js");
const { renderAssistantForTelegram, addressedToBot } = await import("../src/telegram/assistantBot.js");
const { assistantToolAllowed } = await import("../src/ai/assistant/actor.js");
const { runTool } = await vi.importActual<typeof import("../src/ai/assistant.js")>("../src/ai/assistant.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { default: request } = await import("supertest");
const { makeTestExecutor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");

const runId = String(Date.now()).slice(-7);
const uid = (n: number) => String(700_000_000 + Number(runId) * 10 + n);
const GROUP = -(1_000_000_000 + Number(runId));
const OTHER_GROUP = GROUP - 1;
const priceTool = `tg_price_${runId}`;
const remakeTool = `tg_remake_${runId}`;
const BOT = "rh_test_bot";

let nextUpdateId = Number(runId) * 100;
let nextCallbackId = 0;
const agents: Record<string, { id: string; userId: string }> = {};
let price: ReturnType<typeof makeTestExecutor>;
let remake: ReturnType<typeof makeTestExecutor>;
let savedMontajer: string | null = null;

async function mk(key: string, n: number, role: string, extra: Record<string, unknown> = {}) {
  const userId = uid(n);
  const agent = await prisma.agent.create({
    data: {
      fullName: `Тг-${key} ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role: role as "AGENT",
      passwordHash: await bcrypt.hash("testpass123", 10),
      telegramUserId: userId,
      telegramChatId: userId,
      ...extra,
    },
  });
  agents[key] = { id: agent.id, userId };
}

const groupMsg = (key: string | null, text: string, extra: Record<string, unknown> = {}, chat = GROUP) => ({
  update_id: nextUpdateId++,
  message: {
    message_id: 1000 + nextUpdateId,
    chat: { id: chat, type: "supergroup" },
    from: { id: key ? Number(agents[key].userId) : 999_000_001, username: "u" },
    text,
    ...extra,
  },
});

const privateMsg = (key: string, extra: Record<string, unknown>) => ({
  update_id: nextUpdateId++,
  message: { chat: { id: Number(agents[key].userId), type: "private" }, from: { id: Number(agents[key].userId) }, ...extra },
});

const press = (key: string | null, data: string, callbackId?: string, chat = GROUP) =>
  handleTelegramUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: callbackId ?? `cb-${runId}-${nextCallbackId++}`,
      data,
      from: { id: key ? Number(agents[key].userId) : 999_000_001 },
      message: { chat: { id: chat }, message_id: 501 },
    },
  });

/** «Модель»: создаёт цену и перемонтаж (два действия одного ответа) и отвечает текстом. */
function modelMakesChain(reply = "Подтвердите заявку", opts: { onlyPrice?: boolean } = {}) {
  runner.mockImplementation(async (_history: unknown, actor: { id: string }, options: { onConfirm?: (a: unknown) => void }) => {
    const tg = { agentId: actor.id, channel: "telegram" as const, can: () => true };
    options.onConfirm?.(await createPendingAssistantAction(tg, priceTool, { key: "p1", price: 90_000 }));
    if (!opts.onlyPrice) options.onConfirm?.(await createPendingAssistantAction(tg, remakeTool, { key: "p1", price: 1 }));
    return { ok: true, reply };
  });
}

async function askChain(key = "author") {
  modelMakesChain();
  sendMessageWithButtons.mockClear();
  await handleTelegramUpdate(groupMsg(key, `@${BOT} снизь цену ОБ-1 до 90000 и на перемонтаж`));
  const call = sendMessageWithButtons.mock.calls.at(-1);
  const buttons = call?.[2] as { callback_data: string }[][];
  return { call, ok: buttons[0][0].callback_data, no: buttons[0][1].callback_data };
}

const sentTexts = () => sendMessage.mock.calls.map((c) => String(c[1]));
const answers = () => answerCallbackQuery.mock.calls.map((c) => String(c[1] ?? ""));

beforeAll(async () => {
  price = makeTestExecutor(priceTool, { channels: ["crm", "telegram"] });
  remake = makeTestExecutor(remakeTool, { channels: ["crm", "telegram"] });
  await mk("director", 1, "DIRECTOR");
  await mk("author", 2, "AGENT");
  await mk("stranger", 3, "AGENT");
  await mk("inactive", 4, "AGENT", { isActive: false });
  await mk("shareholder", 5, "SHAREHOLDER");
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  savedMontajer = settings?.videoMontajerAgentId ?? null;
  if (settings) await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: null } });
});

beforeEach(() => {
  for (const m of [sendMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, react, runner, transcribe, fetchAudio, claimCap]) {
    m.mockReset();
  }
  sendMessage.mockResolvedValue({});
  sendMessageWithButtons.mockResolvedValue({ message_id: 501 });
  answerCallbackQuery.mockResolvedValue({});
  claimCap.mockResolvedValue({ allowed: true, usedToday: 1 });
  price.store.set("p1", { price: 100_000 });
  remake.store.set("p1", { price: 7 });
  price.calls.execute = 0;
  remake.calls.execute = 0;
});

afterAll(async () => {
  price.unregister();
  remake.unregister();
  const ids = Object.values(agents).map((a) => a.id);
  await prisma.telegramDialogState.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId: { in: [String(GROUP), String(OTHER_GROUP)] } } });
  await prisma.telegramCallbackSeen.deleteMany({ where: { id: { startsWith: `cb-${runId}` } } });
  await cleanupAssistantActionAgents(ids);
  if (savedMontajer) await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: savedMontajer } });
  await prisma.$disconnect();
});

describe("группа: когда бот отвечает", () => {
  it("группа не подключена — молчит даже на упоминание сотрудника", async () => {
    await handleTelegramUpdate(groupMsg("author", `@${BOT} найди клиента`));
    expect(runner).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("/assistant_on: обычный агент — отказ, директор — группа подключена", async () => {
    await handleTelegramUpdate(groupMsg("author", `/assistant_on@${BOT}`));
    expect(sentTexts().join("\n")).toContain("только директор или администратор");
    expect(await prisma.assistantTelegramGroup.findUnique({ where: { chatId: String(GROUP) } })).toBeNull();

    await handleTelegramUpdate(groupMsg("stranger", `/assistant_on@${BOT}`));
    await handleTelegramUpdate(groupMsg(null, `/assistant_on@${BOT}`));
    expect(await prisma.assistantTelegramGroup.findUnique({ where: { chatId: String(GROUP) } })).toBeNull();

    await handleTelegramUpdate(groupMsg("director", `/assistant_on@${BOT}`));
    expect(await prisma.assistantTelegramGroup.findUnique({ where: { chatId: String(GROUP) } })).not.toBeNull();
  });

  it("сообщение без упоминания и без ответа боту — тишина, модель не зовётся", async () => {
    await handleTelegramUpdate(groupMsg("author", "ребята, кто на показ в 15:00?"));
    await handleTelegramUpdate(groupMsg("author", "снизь цену ОБ-1 до 90000"));
    expect(runner).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendMessageWithButtons).not.toHaveBeenCalled();
  });

  it("упоминание чужого бота или похожего ника не считается", () => {
    expect(addressedToBot({ chat: { id: 1 }, text: `@${BOT}x привет` }, BOT).addressed).toBe(false);
    expect(addressedToBot({ chat: { id: 1 }, text: "@other_bot привет" }, BOT).addressed).toBe(false);
    expect(addressedToBot({ chat: { id: 1 }, text: `/ai@other_bot привет` }, BOT).addressed).toBe(false);
    expect(addressedToBot({ chat: { id: 1 }, text: `привет @${BOT.toUpperCase()}, найди` }, BOT)).toEqual({ addressed: true, text: "привет , найди" });
  });

  it("ответ на сообщение бота и команда /ai — это обращение", async () => {
    runner.mockResolvedValue({ ok: true, reply: "ок" });
    await handleTelegramUpdate(
      groupMsg("author", "а теперь ОБ-2", { reply_to_message: { chat: { id: GROUP }, from: { id: 1, is_bot: true, username: BOT } } })
    );
    await handleTelegramUpdate(groupMsg("author", `/ai найди клиента`));
    expect(runner).toHaveBeenCalledTimes(2);
    // Ответ чужому боту обращением не считается.
    await handleTelegramUpdate(
      groupMsg("author", "привет", { reply_to_message: { chat: { id: GROUP }, from: { id: 2, is_bot: true, username: "other_bot" } } })
    );
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("не привязанный сотрудник — «привяжите аккаунт», модель не зовётся", async () => {
    await handleTelegramUpdate(groupMsg(null, `@${BOT} снизь цену`));
    expect(runner).not.toHaveBeenCalled();
    expect(sentTexts().join("\n")).toContain("Привяжите аккаунт");
  });

  it("анонимный админ (sender_chat) и бот-отправитель не опознаются", async () => {
    await handleTelegramUpdate(groupMsg("author", `@${BOT} привет`, { sender_chat: { id: GROUP } }));
    expect(runner).not.toHaveBeenCalled();
    expect(sentTexts().join("\n")).toContain("Анонимного админа");
  });

  it("неактивный сотрудник — как не привязанный", async () => {
    await handleTelegramUpdate(groupMsg("inactive", `@${BOT} привет`));
    expect(runner).not.toHaveBeenCalled();
    expect(sentTexts().join("\n")).toContain("Привяжите аккаунт");
  });

  it("чтение в группе — без телефонов, финансов и отчётов; в тексте номера замаскированы", async () => {
    runner.mockResolvedValue({ ok: true, reply: "Клиент [Али](/clients/abc), тел +992 90 123 45 67" });
    await handleTelegramUpdate(groupMsg("director", `@${BOT} найди Али`));
    const [, actor] = runner.mock.calls[0];
    expect(actor.id).toBe(agents.director.id);
    expect(actor.canViewPhone).toBe(false);
    expect(actor.canViewFinance).toBe(false);
    expect(actor.canViewReports).toBe(false);
    const text = sentTexts().at(-1)!;
    expect(text).toContain("Али — https://crm.test/clients/abc");
    expect(text).not.toContain("90 123 45 67");
    expect(text).toContain("•");
  });

  it("суточный лимит — ответ-отказ, модель не зовётся", async () => {
    claimCap.mockResolvedValue({ allowed: false, usedToday: 999 });
    await handleTelegramUpdate(groupMsg("author", `@${BOT} привет`));
    expect(runner).not.toHaveBeenCalled();
    expect(sentTexts().join("\n")).toContain("лимит");
  });
});

describe("группа: одна карточка и кнопка только автору", () => {
  it("цепочка «цена + перемонтаж» — ОДНА карточка «было → станет» и одна кнопка", async () => {
    const { call, ok } = await askChain();
    expect(sendMessageWithButtons).toHaveBeenCalledTimes(1);
    const text = String(call?.[1]);
    expect(text).toContain("1) Цена объекта p1");
    expect(text).toContain("2) Цена объекта p1");
    expect(text).toContain("Было:");
    expect(text).toContain("Станет:");
    expect(text).toContain(agents.author.id ? "Подтвердить может только Тг-author" : "");
    expect(ok).toMatch(/^as:ok:[0-9a-f-]{36}$/);
    expect(Buffer.byteLength(ok)).toBeLessThanOrEqual(64);
    // Ничего не исполнено до нажатия.
    expect(price.calls.execute + remake.calls.execute).toBe(0);
    // Ответом на сообщение автора.
    expect(call?.[3]).toBeTypeOf("number");
  });

  it("чужой сотрудник нажимает — отказ, ничего не исполнено, кнопка остаётся", async () => {
    const { ok, no } = await askChain();
    await press("stranger", ok);
    expect(answers().at(-1)).toContain("только автор");
    await press("stranger", no);
    expect(answers().at(-1)).toContain("только автор");
    expect(price.calls.execute + remake.calls.execute).toBe(0);
    const rows = await prisma.assistantAction.findMany({ where: { agentId: agents.author.id, tool: { in: [priceTool, remakeTool] } } });
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("нажимает человек не из CRM (нет привязки) — «привяжите», ничего не исполнено", async () => {
    const { ok } = await askChain();
    await press(null, ok);
    expect(answers().at(-1)).toContain("Привяжите аккаунт");
    expect(price.calls.execute + remake.calls.execute).toBe(0);
  });

  it("автор подтверждает: оба действия по порядку, итог в группе, карточка погашена", async () => {
    const { ok } = await askChain();
    await press("author", ok);
    expect(price.calls.execute).toBe(1);
    expect(remake.calls.execute).toBe(1);
    expect(price.store.get("p1")?.price).toBe(90_000);
    expect(answers().at(-1)).toBe("Готово");
    expect(editMessageText).toHaveBeenCalled();
    expect(sentTexts().at(-1)).toContain("✅ Тг-author");
    const rows = await prisma.assistantAction.findMany({ where: { agentId: agents.author.id, tool: { in: [priceTool, remakeTool] } } });
    expect(rows.every((r) => r.status === "EXECUTED" && r.channel === "telegram")).toBe(true);
  });

  it("повторная доставка того же нажатия и второе нажатие другим id — исполнено один раз", async () => {
    const { ok } = await askChain();
    await press("author", ok, `cb-${runId}-same`);
    await press("author", ok, `cb-${runId}-same`);
    await press("author", ok);
    expect(price.calls.execute).toBe(1);
    expect(remake.calls.execute).toBe(1);
    expect(answers().at(-1)).toBe("Уже выполнено");
  });

  it("два одновременных нажатия — исполнено один раз", async () => {
    const { ok } = await askChain();
    await Promise.all([press("author", ok), press("author", ok)]);
    expect(price.calls.execute).toBe(1);
    expect(remake.calls.execute).toBe(1);
  });

  it("права перечитываются на нажатии: деактивированный автор — отказ", async () => {
    const { ok } = await askChain();
    await prisma.agent.update({ where: { id: agents.author.id }, data: { isActive: false } });
    invalidateAgentAccess(agents.author.id);
    try {
      await press("author", ok);
      expect(price.calls.execute + remake.calls.execute).toBe(0);
      expect(answers().at(-1)).toMatch(/Привяжите|Нет прав/);
    } finally {
      await prisma.agent.update({ where: { id: agents.author.id }, data: { isActive: true } });
      invalidateAgentAccess(agents.author.id);
    }
  });

  it("автору сняли право, нужное исполнителю, после показа карточки — отказ без записи", async () => {
    const guarded = `tg_guarded_${runId}`;
    const fx = makeTestExecutor(guarded, { channels: ["crm", "telegram"], requires: ["properties.requestChange"] });
    try {
      fx.store.set("p1", { price: 5 });
      await prisma.agent.update({ where: { id: agents.author.id }, data: { permissions: { granted: ["properties.requestChange"], revoked: [] } } });
      invalidateAgentAccess(agents.author.id);
      runner.mockImplementation(async (_h: unknown, actor: { id: string }, options: { onConfirm?: (a: unknown) => void }) => {
        const tg = { agentId: actor.id, channel: "telegram" as const, can: () => true };
        options.onConfirm?.(await createPendingAssistantAction(tg, guarded, { key: "p1", price: 9 }));
        return { ok: true, reply: "ок" };
      });
      await handleTelegramUpdate(groupMsg("author", `@${BOT} цена`));
      const ok = (sendMessageWithButtons.mock.calls.at(-1)?.[2] as { callback_data: string }[][])[0][0].callback_data;
      await prisma.agent.update({ where: { id: agents.author.id }, data: { permissions: { granted: [], revoked: ["properties.requestChange"] } } });
      invalidateAgentAccess(agents.author.id);
      await press("author", ok);
      expect(fx.calls.execute).toBe(0);
      expect(sentTexts().at(-1)).toContain("недостаточно прав");
    } finally {
      await prisma.agent.update({ where: { id: agents.author.id }, data: { permissions: {} } });
      invalidateAgentAccess(agents.author.id);
      fx.unregister();
    }
  });

  it("акционер (только чтение) подтвердить не может", async () => {
    runner.mockImplementation(async (_h: unknown, actor: { id: string }, options: { onConfirm?: (a: unknown) => void }) => {
      const tg = { agentId: actor.id, channel: "telegram" as const, can: () => true };
      options.onConfirm?.(await createPendingAssistantAction(tg, priceTool, { key: "p1", price: 50_000 }));
      return { ok: true, reply: "ок" };
    });
    await handleTelegramUpdate(groupMsg("shareholder", `@${BOT} цена`));
    const ok = (sendMessageWithButtons.mock.calls.at(-1)?.[2] as { callback_data: string }[][])[0][0].callback_data;
    await press("shareholder", ok);
    expect(price.calls.execute).toBe(0);
    expect(answers().at(-1)).toContain("Нет прав");
  });

  it("первое действие упало — остальные не исполняются и отменяются", async () => {
    price.unregister();
    price = makeTestExecutor(priceTool, { channels: ["crm", "telegram"], failWith: new Error("boom") });
    price.store.set("p1", { price: 100_000 });
    try {
      const { ok } = await askChain();
      await press("author", ok);
      expect(remake.calls.execute).toBe(0);
      expect(answers().at(-1)).toBe("Выполнено не всё");
      const rows = await prisma.assistantAction.findMany({ where: { agentId: agents.author.id, tool: remakeTool }, orderBy: { createdAt: "desc" }, take: 1 });
      expect(rows[0]?.status).toBe("CANCELLED");
      expect(sentTexts().at(-1)).toContain("Остальные действия отменены");
    } finally {
      price.unregister();
      price = makeTestExecutor(priceTool, { channels: ["crm", "telegram"] });
    }
  });

  it("«Отмена» автором отменяет всё и ничего не исполняет", async () => {
    const { no, ok } = await askChain();
    await press("author", no);
    expect(answers().at(-1)).toBe("Отменено");
    await press("author", ok);
    expect(price.calls.execute + remake.calls.execute).toBe(0);
  });

  it("действие без разрешения на канал telegram (только CRM) через Telegram не создаётся", async () => {
    const crmOnly = `tg_crmonly_${runId}`;
    const fx = makeTestExecutor(crmOnly);
    try {
      fx.store.set("p1", { price: 5 });
      await expect(
        createPendingAssistantAction({ agentId: agents.author.id, channel: "telegram", can: () => true }, crmOnly, { key: "p1", price: 9 })
      ).rejects.toMatchObject({ code: "CHANNEL_NOT_ALLOWED" });
    } finally {
      fx.unregister();
    }
  });

  it("мусорные callback_data не падают и ничего не делают", async () => {
    await press("author", "as:ok:not-a-uuid");
    await press("author", "as:zz:" + crypto.randomUUID());
    await press("author", "as:ok:" + crypto.randomUUID());
    expect(answers().at(-1)).toContain("устарела");
    expect(price.calls.execute + remake.calls.execute).toBe(0);
  });
});

describe("личка сотрудника", () => {
  it("текст идёт в помощника с историей, ссылки абсолютные, телефон виден по праву", async () => {
    runner.mockResolvedValue({ ok: true, reply: "Открой [ОБ-1](/properties/9)" });
    await handleTelegramUpdate(privateMsg("author", { text: "привет помощник" }));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][2]).toMatchObject({ channel: "telegram", confirmUi: true });
    expect(sentTexts().at(-1)).toBe("Открой ОБ-1 — https://crm.test/properties/9");

    await handleTelegramUpdate(privateMsg("author", { text: "а дальше?" }));
    const history = runner.mock.calls[1][0] as { role: string; content: string }[];
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    await handleTelegramUpdate(privateMsg("author", { text: "/new" }));
    await handleTelegramUpdate(privateMsg("author", { text: "снова" }));
    expect((runner.mock.calls[2][0] as unknown[]).length).toBe(1);
  });

  it("не привязанный чат помощнику не достаётся (уходит в клиентский путь, модель помощника не зовётся)", async () => {
    runner.mockResolvedValue({ ok: true, reply: "x" });
    await handleTelegramUpdate({
      update_id: nextUpdateId++,
      message: { chat: { id: 799_000_123, type: "private" }, from: { id: 799_000_123 }, text: "/start" },
    }).catch(() => {});
    expect(runner).not.toHaveBeenCalled();
  });

  it("карточка в личке: кнопки, подтверждение своей кнопкой в личном чате", async () => {
    modelMakesChain("Подтвердите", { onlyPrice: true });
    await handleTelegramUpdate(privateMsg("author", { text: "цена ОБ-1 до 90000" }));
    const ok = (sendMessageWithButtons.mock.calls.at(-1)?.[2] as { callback_data: string }[][])[0][0].callback_data;
    await press("author", ok, undefined, Number(agents.author.userId));
    expect(price.calls.execute).toBe(1);
    expect(editMessageText).toHaveBeenCalled();
  });

  it("голосовое: расшифровка тем же путём, эхо «🎤», лимит голосовых", async () => {
    fetchAudio.mockResolvedValue({ images: [], audios: [{ kind: "audio", mediaType: "audio/ogg", buffer: Buffer.from("x"), filename: "v.ogg" }], medias: [], hadUnsupported: false });
    transcribe.mockResolvedValue("найди клиента Али");
    runner.mockResolvedValue({ ok: true, reply: "нашёл" });
    await handleTelegramUpdate(privateMsg("author", { voice: { file_id: "f1", duration: 3 } }));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(sentTexts()[0]).toContain("🎤 «найди клиента Али»");
    expect((runner.mock.calls[0][0] as { content: string }[]).at(-1)?.content).toBe("найди клиента Али");
    expect(claimCap.mock.calls.map((c) => c[1])).toEqual(["assistant-telegram-voice", "assistant-telegram"]);

    claimCap.mockImplementation(async (_a: string, action: string) => ({ allowed: action !== "assistant-telegram-voice", usedToday: 1 }));
    transcribe.mockClear();
    await handleTelegramUpdate(privateMsg("author", { voice: { file_id: "f2", duration: 3 } }));
    expect(transcribe).not.toHaveBeenCalled();
    expect(sentTexts().at(-1)).toContain("Лимит голосовых");
  });

  it("голое фото без слов — только реакция 👀, ни текста, ни модели", async () => {
    await handleTelegramUpdate(privateMsg("author", { message_id: 4242, photo: [{ file_id: "p1", width: 1, height: 1 }] }));
    expect(react).toHaveBeenCalledWith(agents.author.userId, 4242, "👀");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("расшифровка не удалась — ответ человеку, модель не зовётся", async () => {
    fetchAudio.mockResolvedValue({ images: [], audios: [{ kind: "audio", mediaType: "audio/ogg", buffer: Buffer.from("x"), filename: "v.ogg" }], medias: [], hadUnsupported: false });
    transcribe.mockResolvedValue(null);
    await handleTelegramUpdate(privateMsg("author", { voice: { file_id: "f3", duration: 3 } }));
    expect(runner).not.toHaveBeenCalled();
    expect(sentTexts().at(-1)).toContain("Не удалось распознать");
  });
});

describe("привязка и рендер", () => {
  it("привязка по коду сохраняет Telegram user id; прежняя привязка этого аккаунта снимается", async () => {
    const target = await prisma.agent.create({
      data: { fullName: `Тг-link ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "AGENT", passwordHash: "x" },
    });
    agents.link = { id: target.id, userId: uid(8) };
    const { code } = await createTelegramLinkCode(target.id);
    // Этот Telegram-аккаунт уже был привязан к другой учётке (stranger) — привязка переезжает.
    const stolen = agents.stranger.userId;
    await prisma.agent.update({ where: { id: agents.stranger.id }, data: { telegramChatId: null } });
    expect(await tryLinkAgentByCode(stolen, code, stolen)).toBe(true);
    const after = await prisma.agent.findUnique({ where: { id: target.id }, select: { telegramUserId: true, telegramChatId: true } });
    expect(after).toEqual({ telegramUserId: stolen, telegramChatId: stolen });
    const prev = await prisma.agent.findUnique({ where: { id: agents.stranger.id }, select: { telegramUserId: true } });
    expect(prev?.telegramUserId).toBeNull();
  });

  it("рендер: относительные ссылки → абсолютные, ** убираются, ссылки не портятся маской", () => {
    const out = renderAssistantForTelegram("**Клиент** [Али](/clients/12345678-1234-1234-1234-123456789012) +992901234567", { maskPhones: true });
    expect(out).toContain("Клиент Али — https://crm.test/clients/12345678-1234-1234-1234-123456789012");
    expect(out).not.toContain("901234567");
  });
});

describe("ревью П5: утечки и обрезка", () => {
  it("в группе закрыты сделки/статистика и запись уровня B; в личке — открыты", async () => {
    runner.mockResolvedValue({ ok: true, reply: "ок" });
    await handleTelegramUpdate(groupMsg("author", `@${BOT} привет`));
    const groupActor = runner.mock.calls[0][1];
    for (const hidden of ["search_deals", "get_company_stats", "add_client_note", "create_task"]) {
      expect(groupActor.hiddenTools.has(hidden)).toBe(true);
      expect(assistantToolAllowed(groupActor, hidden)).toBe(false);
    }
    expect(await runTool("search_deals", {}, groupActor)).toMatchObject({ error: expect.stringContaining("недоступен") });
    await handleTelegramUpdate(privateMsg("author", { text: "привет" }));
    expect(runner.mock.calls[1][1].hiddenTools).toBeUndefined();
  });

  it("номер в превью карточки в группе маскируется", async () => {
    const key = "+992 90 123 45 67";
    price.store.set(key, { price: 1 });
    runner.mockImplementation(async (_h: unknown, actor: { id: string }, options: { onConfirm?: (a: unknown) => void }) => {
      const tg = { agentId: actor.id, channel: "telegram" as const, can: () => true };
      options.onConfirm?.(await createPendingAssistantAction(tg, priceTool, { key, price: 9 }));
      return { ok: true, reply: "Клиент [+992 90 123 45 67](/clients/x)" };
    });
    await handleTelegramUpdate(groupMsg("author", `@${BOT} цена`));
    const text = String(sendMessageWithButtons.mock.calls.at(-1)?.[1]);
    expect(text).not.toContain("90 123 45 67");
    expect(text).toContain("Подтвердить может только");
  });

  it("длинный ответ модели не съедает карточку: она целиком, кнопка видна, текст ≤ 4096", async () => {
    runner.mockImplementation(async (_h: unknown, actor: { id: string }, options: { onConfirm?: (a: unknown) => void }) => {
      const tg = { agentId: actor.id, channel: "telegram" as const, can: () => true };
      options.onConfirm?.(await createPendingAssistantAction(tg, priceTool, { key: "p1", price: 9 }));
      return { ok: true, reply: "слово ".repeat(2000) };
    });
    await handleTelegramUpdate(groupMsg("author", `@${BOT} цена`));
    const text = String(sendMessageWithButtons.mock.calls.at(-1)?.[1]);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("Станет:");
    expect(text.endsWith("Подтвердить может только Тг-author " + runId + ".")).toBe(true);
  });

  it("отвязка Telegram снимает и user id: из группы сотрудник больше не опознаётся", async () => {
    await mk("unlinker", 7, "AGENT");
    const token = signAccessToken({ sub: agents.unlinker.id, role: "AGENT" });
    const res = await request(app).post("/api/v1/me/telegram-unlink").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBeLessThan(300);
    const row = await prisma.agent.findUnique({ where: { id: agents.unlinker.id }, select: { telegramUserId: true, telegramChatId: true } });
    expect(row).toEqual({ telegramUserId: null, telegramChatId: null });
    runner.mockResolvedValue({ ok: true, reply: "x" });
    await handleTelegramUpdate(groupMsg("unlinker", `@${BOT} привет`));
    expect(runner).not.toHaveBeenCalled();
  });
});
