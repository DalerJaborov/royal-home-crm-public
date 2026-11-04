import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { createAssistantMoneyWallet } from "../src/ai/assistant/moneyBudget.js";
import { decideExpensePhotoDraft, expireExpensePhotoDrafts, getExpenseDirector, stageExpensePhotoDraft } from "../src/lib/telegramExpenseReceipts.js";
import { handleAssistantCallback, handleAssistantPrivate } from "../src/telegram/assistantBot.js";
import { handleTelegramExpenseReceipt } from "../src/telegram/assistantExpenseReceipt.js";
import { TelegramApiError, type TelegramIncomingMessage, type TelegramInlineButton } from "../src/telegram/api.js";

const io = vi.hoisted(() => ({
  extract: vi.fn(),
  download: vi.fn(),
  buttons: vi.fn(async (_chatId: string, _text: string, _buttons: TelegramInlineButton[][], _reply?: number) => ({ message_id: 801 })),
  text: vi.fn(async (_chatId: string, _text: string, _reply?: number) => ({})),
  ack: vi.fn(async (_id: string, _text?: string) => ({})),
  edit: vi.fn(async (_chatId: string, _id: number, _text: string, _buttons?: TelegramInlineButton[][] | null) => {}),
  react: vi.fn(async () => {}),
}));
vi.mock("../src/ai/assistant/expenseReceiptExtraction.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/expenseReceiptExtraction.js")>()),
  extractExpenseReceipt: io.extract,
}));
vi.mock("../src/telegram/assistantMedia.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/telegram/assistantMedia.js")>()),
  downloadAssistantMedia: io.download,
}));
vi.mock("../src/ai/assistant/runtime.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/assistant/runtime.js")>()),
  loadAssistantSettings: async () => ({ enabled: true, groundedSearchEnabled: false, semanticSearchEnabled: false }),
}));
vi.mock("../src/telegram/api.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessageWithButtons: io.buttons,
  sendMessage: io.text,
  answerCallbackQuery: io.ack,
  editMessageText: io.edit,
  setMessageReaction: io.react,
}));

const stamp = String(Date.now()).slice(-8);
const chatId = 8_400_000_000 + Number(stamp);
const otherChatId = chatId + 100_000_000;
let director: { id: string; fullName: string };
let administrator: { id: string; fullName: string };
let oldEnabled = false;
let count = 0;
const evidence = { language: "ru" as const, amountMinor: 15025, currency: "TJS" as const,
  paymentDate: "2020-11-04", purpose: "бумага", vendor: "магазин" };

function msg(caption?: string, additional: Partial<TelegramIncomingMessage> = {}): TelegramIncomingMessage {
  return { message_id: ++count, chat: { id: chatId, type: "private" }, from: { id: chatId }, photo: [{ file_id: "receipt-photo-fixture" }], caption, ...additional };
}
async function createJpeg() {
  return sharp({ create: { width: 40, height: 35, channels: 3,
    background: { r: (count * 29) % 255, g: (count * 41) % 255, b: (count * 13) % 255 },
  } }).jpeg().toBuffer();
}
const token = () => ({ Authorization: `Bearer ${signAccessToken({ sub: director.id, role: "DIRECTOR" })}` });
const approve = (data: string, overrides = {}) => handleAssistantCallback({
  id: `receipt-fixture-${++count}`, from: { id: chatId }, message: { chat: { id: chatId, type: "private" }, message_id: 801 }, data, ...overrides,
});
const expenseCount = () => prisma.expense.count({ where: { createdById: director.id } });

beforeAll(async () => {
  director = await prisma.agent.create({ data: { fullName: "Receipt Director Fixture", phone: `+992920${stamp}`, passwordHash: "x",
    role: "DIRECTOR", telegramChatId: String(chatId), telegramUserId: String(chatId) } });
  administrator = await prisma.agent.create({ data: { fullName: "Receipt Admin Fixture", phone: `+992921${stamp}`, passwordHash: "x",
    role: "ADMIN", telegramChatId: String(otherChatId), telegramUserId: String(otherChatId) } });
  const current = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { aiAssistantEnabled: true } });
  oldEnabled = current.aiAssistantEnabled;
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
});
beforeEach(async () => {
  vi.clearAllMocks();
  count++;
  io.extract.mockReset().mockResolvedValue({ kind: "paid_receipt", ...evidence });
  io.download.mockReset().mockResolvedValue(await createJpeg());
});
afterAll(async () => {
  await prisma.telegramExpenseDraft.deleteMany({ where: { agentId: director.id } });
  await prisma.expense.deleteMany({ where: { createdById: director.id } });
  await prisma.auditLog.deleteMany({ where: { agentId: director.id } });
  await prisma.agent.deleteMany({ where: { id: { in: [director.id, administrator.id] } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: oldEnabled } });
});

describe("private Telegram expense from a receipt photo", () => {
  it("previews once and two overlapping confirmations commit one expense, image and audit", async () => {
    const before = await expenseCount();
    const original = msg();
    await handleAssistantPrivate(original, director);
    expect(io.buttons).toHaveBeenCalledOnce();
    expect(io.buttons.mock.calls[0][1]).toContain("150,25 TJS · 2020-11-04");
    const callback = io.buttons.mock.calls[0][2][0][0].callback_data!;
    await handleAssistantPrivate(original, director);
    await handleAssistantPrivate(msg(), director);
    expect(io.extract).toHaveBeenCalledOnce();
    expect(io.buttons).toHaveBeenCalledOnce();
    expect(await expenseCount()).toBe(before);
    await Promise.all([approve(callback), approve(callback)]);
    expect(await expenseCount()).toBe(before + 1);
    const draft = await prisma.telegramExpenseDraft.findUniqueOrThrow({ where: { id: callback.split(":").at(-1)! } });
    expect(draft.image).toBeNull();
    expect(draft.evidence).toBeNull();
    const stored = await prisma.expense.findUniqueOrThrow({ where: { id: draft.expenseId! }, include: { receipts: { include: { content: true } } } });
    expect(stored.receipts).toHaveLength(1);
    expect(Number(stored.amount)).toBe(150.25);
    expect(stored.status).toBe("PAID");
    expect(stored.receipts[0].content?.image.length).toBeGreaterThan(0);
    expect(await prisma.auditLog.count({ where: { entityId: stored.id, action: "EXPENSE_CREATE" } })).toBe(1);
    const receiptUrl = `/api/v1/expenses/${stored.id}/receipts/${stored.receipts[0].id}/file`;
    expect((await request(app).get(receiptUrl)).status).toBe(401);
    const served = await request(app).get(receiptUrl).set(token());
    expect(served.status).toBe(200);
    expect(served.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.from(served.body)).toEqual(Buffer.from(stored.receipts[0].content!.image));
    await handleAssistantPrivate(msg(), director);
    expect(io.buttons).toHaveBeenCalledOnce();
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("Записала расход");
  });

  it("does not OCR group, forwarded, ordinary caption or non-director photos", async () => {
    const wallet = createAssistantMoneyWallet();
    expect(await handleTelegramExpenseReceipt(msg(undefined, { chat: { id: -100, type: "group" } }), director.id, wallet)).toBe(false);
    expect(await handleTelegramExpenseReceipt(msg("чек", { forward_origin: { type: "user" } }), director.id, wallet)).toBe(false);
    expect(await handleTelegramExpenseReceipt(msg("Фото квартиры"), director.id, wallet)).toBe(false);
    expect(await handleTelegramExpenseReceipt(msg("чек", { chat: { id: otherChatId, type: "private" }, from: { id: otherChatId } }), administrator.id, wallet)).toBe(false);
    expect(io.download).not.toHaveBeenCalled();
    expect(io.extract).not.toHaveBeenCalled();
  });

  it("restores buttons after Telegram explicitly rejects the preview and does not OCR twice", async () => {
    io.buttons.mockRejectedValueOnce(new TelegramApiError(400, "sendMessage", "synthetic rejection"));
    const original = msg("чек");
    await handleAssistantPrivate(original, director);
    await handleAssistantPrivate(original, director);
    expect(io.extract).toHaveBeenCalledOnce();
    expect(io.buttons).toHaveBeenCalledTimes(2);
    expect(io.buttons.mock.calls[0][2]).toEqual(io.buttons.mock.calls[1][2]);
  });

  it.each([2, 3, 4, 5])("keeps one keyboard across %i copies while Telegram is still responding", async copies => {
    let entered!: () => void;
    let finish!: () => void;
    const posting = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    io.buttons.mockImplementationOnce(async () => {
      entered();
      await waiting;
      return { message_id: 801 };
    });
    const original = msg("чек");
    const first = handleAssistantPrivate(original, director);
    try {
      await posting;
      await Promise.all(Array.from({ length: copies - 1 }, () => handleAssistantPrivate(original, director)));
      expect(io.buttons).toHaveBeenCalledOnce();
      expect(io.extract).toHaveBeenCalledOnce();
    } finally {
      finish();
      await first;
    }
  });

  it.each([
    new Error("connection lost after request"),
    new TelegramApiError(500, "sendMessage", "synthetic provider failure"),
    new TelegramApiError(undefined, "sendMessage", "synthetic incomplete provider reply"),
  ])("does not post a second keyboard after ambiguous delivery %s", async error => {
    io.buttons.mockRejectedValueOnce(error);
    const original = msg("чек");
    await handleAssistantPrivate(original, director);
    await handleAssistantPrivate(original, director);
    expect(io.buttons).toHaveBeenCalledOnce();
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("через 10 минут");
  });

  it("rolls back the expense, attached image and audit if the final replay marker fails", async () => {
    const actor = (await getExpenseDirector(String(chatId), director.id))!;
    const before = await expenseCount();
    const rollbackEvidence = { ...evidence, purpose: "expense rollback fixture" };
    const staged = await stageExpensePhotoDraft(actor, ++count, await createJpeg(), rollbackEvidence);
    if (staged.kind !== "pending") throw new Error("Missing test draft");
    await prisma.$executeRaw`CREATE FUNCTION "expense_receipt_fixture_rollback"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."expenseId" IS NOT NULL AND OLD."evidence"->>'purpose' = 'expense rollback fixture' THEN
          RAISE EXCEPTION 'synthetic receipt commit failure';
        END IF;
        RETURN NEW;
      END;
    $$`;
    try {
      await prisma.$executeRaw`CREATE TRIGGER "expense_receipt_fixture_rollback" BEFORE UPDATE ON "TelegramExpenseDraft"
        FOR EACH ROW EXECUTE FUNCTION "expense_receipt_fixture_rollback"()`;
      const beforeAudit = await prisma.auditLog.count({ where: { agentId: director.id, action: "EXPENSE_CREATE" } });
      const beforeImages = await prisma.expenseReceiptContent.count();
      await expect(decideExpensePhotoDraft(actor, staged.id, true)).rejects.toThrow("synthetic receipt commit failure");
      expect(await expenseCount()).toBe(before);
      expect(await prisma.expenseReceiptContent.count()).toBe(beforeImages);
      expect(await prisma.auditLog.count({ where: { agentId: director.id, action: "EXPENSE_CREATE" } })).toBe(beforeAudit);
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS "expense_receipt_fixture_rollback" ON "TelegramExpenseDraft"`;
      await prisma.$executeRaw`DROP FUNCTION IF EXISTS "expense_receipt_fixture_rollback"()`;
    }
    expect(await decideExpensePhotoDraft(actor, staged.id, true)).toMatchObject({ kind: "recorded" });
    expect(await expenseCount()).toBe(before + 1);
  });

  it("asks only for the missing date and accepts a matching one-field caption on re-upload", async () => {
    io.extract.mockResolvedValue({ kind: "paid_receipt", ...evidence, paymentDate: null });
    await handleAssistantPrivate(msg("чек"), director);
    expect(io.buttons).not.toHaveBeenCalled();
    expect(io.text.mock.calls[0][1]).toContain("дата=YYYY-MM-DD");
    expect(io.text.mock.calls[0][1]).not.toContain("сумма=");
    await handleAssistantPrivate(msg("Чек: дата=2020-11-04"), director);
    expect(io.buttons.mock.calls[0][1]).toContain("150,25 TJS · 2020-11-04");
  });

  it("does not create a preview on caption mismatch or a bare uncertain receipt", async () => {
    await handleAssistantPrivate(msg("Чек: сумма=15"), director);
    expect(io.text.mock.calls[0][1]).toContain("различаются");
    io.extract.mockResolvedValueOnce({ kind: "unclear_receipt", ...evidence });
    await handleAssistantPrivate(msg(), director);
    expect(io.text.mock.calls.at(-1)?.[1]).toContain("не видно, что оплата прошла");
    expect(io.buttons).not.toHaveBeenCalled();
  });

  it("leaves a normal photo on the existing path and localizes a Tajik preview", async () => {
    io.extract.mockResolvedValueOnce({ kind: "other", ...evidence });
    await handleAssistantPrivate(msg(), director);
    expect(io.react).toHaveBeenCalledOnce();
    io.extract.mockResolvedValueOnce({ kind: "paid_receipt", ...evidence, language: "tg", purpose: "коғаз" });
    await handleAssistantPrivate(msg("расид"), director);
    expect(io.buttons.mock.calls[0][1]).toContain("Ин харҷро сабт кунам?");
    expect(io.buttons.mock.calls[0][2][0][0].callback_data).toContain("ef:yes:tg:");
  });

  it("checks live role after a preview, blocks group callback, and expires unconfirmed image bytes", async () => {
    const actor = (await getExpenseDirector(String(chatId), director.id))!;
    const now = new Date();
    const before = await expenseCount();
    const staged = await stageExpensePhotoDraft(actor, ++count, await createJpeg(), evidence, now);
    expect(staged.kind).toBe("pending");
    if (staged.kind !== "pending") throw new Error("Missing test draft");
    const callback = `ef:yes:ru:${staged.id}`;
    await approve(callback, { message: { chat: { id: -100, type: "supergroup" }, message_id: 801 } });
    await prisma.agent.update({ where: { id: director.id }, data: { role: "ADMIN" } });
    try {
      expect(await decideExpensePhotoDraft(actor, staged.id, true)).toEqual({ kind: "forbidden" });
    } finally {
      await prisma.agent.update({ where: { id: director.id }, data: { role: "DIRECTOR" } });
    }
    const expiredAt = new Date(now.getTime() + 11 * 60_000);
    expect(await decideExpensePhotoDraft(actor, staged.id, true, expiredAt)).toEqual({ kind: "expired" });
    expect(await expireExpensePhotoDrafts(expiredAt)).toBeGreaterThan(0);
    expect(await prisma.telegramExpenseDraft.findUnique({ where: { id: staged.id } })).toBeNull();
    expect(await expenseCount()).toBe(before);
  });
});
