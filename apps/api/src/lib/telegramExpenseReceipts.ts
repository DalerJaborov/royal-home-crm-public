import { createHash } from "node:crypto";
import { CURRENCIES, expenseCreateSchema, expenseDateSchema, parsePermissionOverrides, resolvePermissions } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { Prisma, type Agent, type TelegramExpenseDraft } from "../generated/prisma/client.js";
import { expenseDay, todayExpenseDay } from "./expenseWorkspace.js";
import { loadMoneyContext } from "./money.js";
import { maskAssistantContacts } from "./assistantContacts.js";

export const MAX_EXPENSE_RECEIPT_BYTES = 2_000_000;
const DRAFT_TTL_MS = 10 * 60_000;
const MAX_AMOUNT_MINOR = 9_999_999_999;
const evidenceSchema = z.object({
  language: z.enum(["ru", "tg"]),
  amountMinor: z.number().int().positive().max(MAX_AMOUNT_MINOR),
  currency: z.enum(CURRENCIES),
  paymentDate: expenseDateSchema,
  purpose: z.string().min(1).max(160),
  vendor: z.string().max(100).nullable(),
  sourceFormat: z.literal("pdf").optional(),
}).strict();
export type ExpenseReceiptEvidence = z.infer<typeof evidenceSchema>;
export interface ExpenseDirectorIdentity { agentId: string; chatId: string }
type AgentIdentity = Pick<Agent, "id" | "role" | "isActive" | "telegramChatId" | "telegramUserId" | "permissions" | "fullName">;
type ExpenseReceiptDraftView = Pick<TelegramExpenseDraft, "id" | "agentId" | "chatId" | "expenseId" | "evidence" | "expiresAt" | "previewMessageId">;

function directorMatches(agent: AgentIdentity | null, actor: ExpenseDirectorIdentity): agent is AgentIdentity {
  if (!agent?.isActive || agent.role !== "DIRECTOR" || agent.id !== actor.agentId
    || agent.telegramChatId !== actor.chatId || (agent.telegramUserId !== null && agent.telegramUserId !== actor.chatId)) return false;
  const rights = resolvePermissions(agent.role, parsePermissionOverrides(agent.permissions));
  return rights.has("finance.view") && rights.has("finance.manage");
}

export async function getExpenseDirector(chatId: string, agentId?: string): Promise<ExpenseDirectorIdentity | null> {
  const agent = await prisma.agent.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, role: true, isActive: true, telegramChatId: true, telegramUserId: true, permissions: true, fullName: true },
  });
  const actor = { agentId: agentId ?? agent?.id ?? "", chatId };
  return directorMatches(agent, actor) ? actor : null;
}

function safeField(value: string): string {
  return maskAssistantContacts(value.replace(/https?:\/\/\S+/giu, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim());
}

export function parseExpenseReceiptEvidence(input: unknown, now = new Date()): ExpenseReceiptEvidence | null {
  const result = evidenceSchema.safeParse(input);
  if (!result.success || result.data.paymentDate > todayExpenseDay(now)) return null;
  const purpose = safeField(result.data.purpose);
  if (!purpose || !/\p{L}/u.test(purpose)) return null;
  return { ...result.data, purpose, vendor: result.data.vendor ? safeField(result.data.vendor) || null : null };
}

export function expenseReceiptHash(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

const selectDraft = { id: true, agentId: true, chatId: true, expenseId: true, evidence: true, expiresAt: true, previewMessageId: true } as const;
type IntakeResult =
  | { kind: "pending"; id: string; evidence: ExpenseReceiptEvidence; previewMessageId: number | null }
  | { kind: "recorded"; expenseId: string }
  | { kind: "duplicate" };

function draftView(row: ExpenseReceiptDraftView, actor: ExpenseDirectorIdentity, now: Date): IntakeResult | null {
  if (row.agentId !== actor.agentId || row.chatId !== actor.chatId) return { kind: "duplicate" };
  if (row.expenseId) return { kind: "recorded", expenseId: row.expenseId };
  const evidence = row.expiresAt > now ? parseExpenseReceiptEvidence(row.evidence, now) : null;
  return evidence ? { kind: "pending", id: row.id, evidence, previewMessageId: row.previewMessageId } : null;
}

export async function findExpensePhotoDraft(
  actor: ExpenseDirectorIdentity, messageId: number, sourceHash?: string, now = new Date(),
): Promise<IntakeResult | null> {
  const row = await prisma.telegramExpenseDraft.findFirst({
    where: { OR: [{ chatId: actor.chatId, messageId }, ...(sourceHash ? [{ sourceHash }] : [])] },
    select: selectDraft,
  });
  return row ? draftView(row, actor, now) : null;
}

/** The validated JPEG or PDF enters private staging only when it has all critical fields. */
export async function stageExpensePhotoDraft(
  actor: ExpenseDirectorIdentity, messageId: number, source: Uint8Array, input: ExpenseReceiptEvidence, now = new Date(),
): Promise<IntakeResult> {
  const pdf = Buffer.from(source.subarray(0, 5)).toString("ascii") === "%PDF-";
  // Old code uses a strict evidence schema and rejects a PDF draft during rollback.
  const evidence = parseExpenseReceiptEvidence(pdf ? { ...input, sourceFormat: "pdf" } : input, now);
  if (!evidence || !Number.isSafeInteger(messageId) || messageId <= 0 || messageId > 2_147_483_647
    || (!pdf && evidence.sourceFormat === "pdf") || !source.length || source.length > MAX_EXPENSE_RECEIPT_BYTES) {
    throw new Error("Invalid expense receipt draft");
  }
  const sourceHash = expenseReceiptHash(source);
  const identity = { OR: [{ chatId: actor.chatId, messageId }, { sourceHash }] };
  // An expired card can never point at a fresh draft, even for the same source.
  await prisma.telegramExpenseDraft.deleteMany({ where: { ...identity, expenseId: null, expiresAt: { lte: now } } });
  try {
    const row = await prisma.telegramExpenseDraft.create({
      data: { ...actor, messageId, sourceHash, evidence, image: Buffer.from(source), expiresAt: new Date(now.getTime() + DRAFT_TTL_MS) },
      select: selectDraft,
    });
    return { kind: "pending", id: row.id, evidence, previewMessageId: null };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return (await findExpensePhotoDraft(actor, messageId, sourceHash, now)) ?? { kind: "duplicate" };
  }
}

/** Claim the external keyboard send once, including across workers and process restarts. */
export async function claimExpensePreview(actor: ExpenseDirectorIdentity, id: string, now = new Date()): Promise<boolean> {
  const claimed = await prisma.telegramExpenseDraft.updateMany({
    where: { ...actor, id, expenseId: null, expiresAt: { gt: now }, previewMessageId: null, previewClaimed: false },
    data: { previewClaimed: true },
  });
  return claimed.count === 1;
}

export async function releaseRejectedExpensePreview(actor: ExpenseDirectorIdentity, id: string): Promise<void> {
  await prisma.telegramExpenseDraft.updateMany({
    where: { ...actor, id, expenseId: null, previewMessageId: null, previewClaimed: true },
    data: { previewClaimed: false },
  });
}

export async function markExpensePreviewDelivered(actor: ExpenseDirectorIdentity, id: string, messageId: number): Promise<void> {
  if (!Number.isSafeInteger(messageId) || messageId < 1 || messageId > 2_147_483_647) return;
  await prisma.telegramExpenseDraft.updateMany({
    where: { ...actor, id, previewMessageId: null }, data: { previewMessageId: messageId },
  });
}

type DecisionResult =
  | { kind: "recorded"; expenseId: string }
  | { kind: "cancelled" | "expired" | "forbidden" };

/** Expense, receipt, private file, audit and replay marker commit together. */
export async function decideExpensePhotoDraft(
  actor: ExpenseDirectorIdentity, id: string, confirm: boolean, now = new Date(),
): Promise<DecisionResult> {
  return prisma.$transaction(async tx => {
    const [agent] = await tx.$queryRaw<AgentIdentity[]>`
      SELECT "id", "role", "isActive", "telegramChatId", "telegramUserId", "permissions", "fullName"
      FROM "Agent" WHERE "id" = ${actor.agentId} FOR SHARE
    `;
    if (!agent || !directorMatches(agent, actor)) return { kind: "forbidden" };
    const [match] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TelegramExpenseDraft"
      WHERE "id" = ${id} AND "agentId" = ${actor.agentId} AND "chatId" = ${actor.chatId} FOR UPDATE
    `;
    if (!match) return { kind: "expired" };
    const draft = await tx.telegramExpenseDraft.findUniqueOrThrow({ where: { id } });
    if (draft.expenseId) return { kind: "recorded", expenseId: draft.expenseId };
    const evidence = parseExpenseReceiptEvidence(draft.evidence, now);
    if (draft.expiresAt <= now || !evidence || !draft.image) return { kind: "expired" };
    if (!confirm) {
      await tx.telegramExpenseDraft.delete({ where: { id } });
      return { kind: "cancelled" };
    }
    const settings = await tx.settings.findUnique({ where: { id: "singleton" }, select: { aiAssistantEnabled: true } });
    if (settings?.aiAssistantEnabled !== true) return { kind: "forbidden" };
    const rate = evidence.currency === "USD" ? (await loadMoneyContext(tx)).usdToTjs : 1;
    const data = expenseCreateSchema.parse({
      category: "OTHER", note: evidence.purpose, counterparty: evidence.vendor,
      month: evidence.paymentDate.slice(0, 7), status: "PAID", paymentDate: evidence.paymentDate,
      amount: evidence.amountMinor / 100, currency: evidence.currency, exchangeRate: rate,
    });
    const pdf = evidence.sourceFormat === "pdf";
    const extension = pdf ? "pdf" : "jpg";
    const expense = await tx.expense.create({
      data: {
        ...data, month: expenseDay(`${data.month}-01`), paymentDate: expenseDay(evidence.paymentDate),
        createdById: actor.agentId, rateCapturedAt: now, requestKey: `tg-receipt:${draft.sourceHash}`,
        receipts: { create: {
          fileName: `${id}.${extension}`, originalName: `telegram-receipt.${extension}`,
          mimeType: pdf ? "application/pdf" : "image/jpeg",
          size: draft.image.length, uploadedById: actor.agentId, content: { create: { image: draft.image } },
        } },
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: { action: "EXPENSE_CREATE", entityType: "Expense", entityId: expense.id,
        agentId: actor.agentId, agentName: agent.fullName, meta: { source: "telegram_receipt", draftId: id } },
    });
    await tx.telegramExpenseDraft.update({
      where: { id }, data: { expenseId: expense.id, evidence: Prisma.DbNull, image: null },
    });
    return { kind: "recorded", expenseId: expense.id };
  });
}

export async function expireExpensePhotoDrafts(now = new Date()): Promise<number> {
  const result = await prisma.telegramExpenseDraft.deleteMany({ where: { expiresAt: { lte: now }, expenseId: null } });
  return result.count;
}
