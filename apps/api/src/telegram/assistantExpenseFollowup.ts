import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { getExpenseDirector } from "../lib/telegramExpenseReceipts.js";
import { loadAssistantSettings } from "../ai/assistant/runtime.js";
import { assistantLanguage, repliesInTajik } from "../ai/assistant/languageRouting.js";
import { createAssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { expenseFollowupKind, mentionsExpenses } from "../ai/assistant/expenseIntent.js";
import { ADD_EXPENSES_TOOL } from "../ai/assistant/tools/expenseBatchTool.js";
import { collectExpenseAlbumPhoto } from "./assistantExpenseAlbum.js";
import { reofferExpenseBatch } from "./assistantExpenseCard.js";
import { parseExpenseTextList, stageExpenseTextList } from "./assistantExpenseTextList.js";
import { mergeAssistantDialog } from "./assistantDialogState.js";
import { sendMessage, type TelegramIncomingMessage } from "./api.js";
import type { IntakeLang } from "./assistantExpenseBatchIntake.js";

/**
 * «ВОТ ФОТО», «ВНЕСИ ЭТИ РАСХОДЫ», «ПОВТОРИ КАРТОЧКУ» (17.11.2026, журнал прода 10–11.11).
 *
 * Причины «поговорила и не сделала» (ФАКТ по коду до этой правки):
 * - фото без подписи получало 👀 и забывалось: следующее «мана акс, ворид кун» уходило модели без фото;
 * - карточка, собранная из фото, в разговор не попадала: «дуруст ворид кун» модель не могла связать с ней;
 * - разговор помощницы живёт 15 минут, карточка — 10: через полчаса «внеси» было не о чем.
 *
 * Здесь это решается кодом, без модели: фото без слов помнятся 30 минут и по просьбе уходят одной
 * пачкой (как альбом); просьба без данных возвращает карточку за последние сутки (живую — ту же,
 * истёкшую — новую с теми же строками); данных нет вовсе — одна фраза, чего не хватает, а следующее
 * фото или файл принимаются как расходы. Право записи — то же, что у чека (finance.view + finance.manage).
 */

const DIALOG_KIND = "assistant";
export const EXPENSE_PHOTO_MEMORY_MS = 30 * 60_000;
export const EXPENSE_INTENT_MEMORY_MS = 10 * 60_000;
/** «Повтори карточку», «ворид кун» — возвращают карточку расходов за последние сутки. */
export const EXPENSE_CARD_RECALL_MS = 24 * 60 * 60_000;
/** «Внеси расходы» без данных — только карточку, показанную в этот час (иначе это, скорее, новая просьба). */
const RECORD_RECALL_MS = 60 * 60_000;
/** Список текстом в прошлом сообщении: карточка, собранная из него моделью, свежее этого. */
const LIST_RECALL_MS = 15 * 60_000;
/** Исполненную карточку второй раз не собираем: «Записано» — уже записано, час. */
const EXECUTED_GUARD_MS = 60 * 60_000;
const MAX_PHOTOS = 10;

const MISSING = {
  ru: "Пришлите список «статья — сумма» (можно с месяцем) или фото списка/чеков — сделаю одну карточку на все строки.",
  tg: "Рӯйхатро «харҷ — маблағ» (бо моҳаш) ё акси рӯйхат/расидҳоро фиристед — ҳамаашро дар як корт нишон медиҳам.",
} as const;
const NO_CARD = {
  ru: "Карточки расходов за последние сутки нет. Пришлите список «статья — сумма» или фото — сделаю одну карточку.",
  tg: "Дар як шабонарӯзи охир корти харҷ нест. Рӯйхатро «харҷ — маблағ» ё аксашро фиристед — ҳамаашро дар як корт нишон медиҳам.",
} as const;

interface ExpenseMemory { photos: { fileId: string; messageId: number }[]; photosUntil: number; intentUntil: number }
const EMPTY: ExpenseMemory = { photos: [], photosUntil: 0, intentUntil: 0 };

function memoryOf(payload: Record<string, unknown> | null): ExpenseMemory {
  const raw = payload?.expenseMemory as Partial<ExpenseMemory> | undefined;
  if (!raw || typeof raw !== "object") return EMPTY;
  const photos = Array.isArray(raw.photos)
    ? raw.photos.filter((p): p is { fileId: string; messageId: number } =>
      !!p && typeof p.fileId === "string" && Number.isInteger(p.messageId)).slice(-MAX_PHOTOS)
    : [];
  return { photos, photosUntil: Number(raw.photosUntil) || 0, intentUntil: Number(raw.intentUntil) || 0 };
}

async function readMemory(chatId: string, agentId: string): Promise<ExpenseMemory> {
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (!state || state.kind !== DIALOG_KIND || state.agentId !== agentId || state.expiresAt <= new Date()) return EMPTY;
  return memoryOf(state.payload as Record<string, unknown> | null);
}

/** Память лежит в состоянии разговора помощницы (история не теряется); чужое состояние чата не трогаем. */
async function patchMemory(chatId: string, agentId: string, change: (m: ExpenseMemory) => ExpenseMemory, ttlMs: number): Promise<boolean> {
  return mergeAssistantDialog({
    chatId, agentId,
    change: (payload) => ({ ...payload, expenseMemory: change(memoryOf(payload)) }),
    expiresAt: (live) => new Date(Math.max(Date.now() + ttlMs, live ? live.getTime() : 0)),
  });
}

const langOf = (text: string): IntakeLang => (repliesInTajik(assistantLanguage([{ role: "user", content: text }])) ? "tg" : "ru");

/**
 * Фото без подписи в личке того, кто ведёт расходы: запомнить на 30 минут. Пересланные — нет (их
 * не разбираем как чеки нигде). true — запомнили.
 */
export async function rememberExpensePhoto(msg: TelegramIncomingMessage, agentId: string): Promise<boolean> {
  const photo = msg.photo?.at(-1);
  const messageId = msg.message_id;
  if (!photo || msg.chat.type !== "private" || msg.forward_origin || msg.forward_from_message_id || !messageId) return false;
  const chatId = String(msg.chat.id);
  if (!(await getExpenseDirector(chatId, agentId))) return false;
  const now = Date.now();
  return patchMemory(chatId, agentId, (m) => ({
    ...m,
    photos: [...(m.photosUntil > now ? m.photos : []), { fileId: photo.file_id, messageId }].slice(-MAX_PHOTOS),
    photosUntil: now + EXPENSE_PHOTO_MEMORY_MS,
  }), EXPENSE_PHOTO_MEMORY_MS);
}

/** Сказали «внеси расходы» без данных: следующие 10 минут фото и файл без подписи — расходы. */
export async function expenseIntentPending(chatId: string, agentId: string): Promise<boolean> {
  return (await readMemory(chatId, agentId)).intentUntil > Date.now();
}

/**
 * Карточка расходов за окно. `mustBeLatest` — только если она ПОСЛЕДНЕЕ действие помощницы у этого человека
 * в Telegram: короткое «да, запиши» без слова «расход» не должно вытаскивать карточку, за которой уже были
 * другие дела (ревью волны 2: перехват чужих просьб).
 */
async function latestExpenseCard(agentId: string, sinceMs: number, liveOnly = false, mustBeLatest = false) {
  const now = new Date();
  const since = new Date(now.getTime() - sinceMs);
  const statusOk = (row: { status: string; expiresAt: Date }) =>
    liveOnly ? row.status === "PENDING" && row.expiresAt > now : row.status === "PENDING" || row.status === "EXPIRED";
  if (mustBeLatest) {
    const last = await prisma.assistantAction.findFirst({
      where: { agentId, channel: "telegram", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { tool: true, bundleId: true, status: true, expiresAt: true },
    });
    return last && last.tool === ADD_EXPENSES_TOOL && last.bundleId && statusOk(last) ? { bundleId: last.bundleId } : null;
  }
  return prisma.assistantAction.findFirst({
    where: {
      agentId, tool: ADD_EXPENSES_TOOL, channel: "telegram", bundleId: { not: null }, createdAt: { gte: since },
      ...(liveOnly ? { status: "PENDING" as const, expiresAt: { gt: now } } : { status: { in: ["PENDING" as const, "EXPIRED" as const] } }),
    },
    orderBy: { createdAt: "desc" },
    select: { bundleId: true },
  });
}

const rowKey = (title: unknown, amount: unknown) => `${String(title ?? "").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim()}|${Number(amount)}`;

/**
 * Уже исполненная за последний час карточка расходов. `rows` — строки списка: если задан, нужна карточка,
 * где есть ВСЕ эти строки (та же статья и сумма); без него — любая исполненная.
 * Нужна, чтобы «да, запиши» после «Записано» не собирало второй раз те же суммы (ревью волны 2, блокер).
 */
async function executedExpenseCard(agentId: string, rows?: readonly { title: string; amount: number }[]) {
  const executed = await prisma.assistantAction.findMany({
    where: {
      agentId, tool: ADD_EXPENSES_TOOL, channel: "telegram", bundleId: { not: null }, status: "EXECUTED",
      createdAt: { gte: new Date(Date.now() - EXECUTED_GUARD_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { bundleId: true, args: true },
  });
  if (!rows) return executed[0]?.bundleId ? { bundleId: executed[0].bundleId } : null;
  const wanted = rows.map((r) => rowKey(r.title, r.amount));
  for (const card of executed) {
    const items = (card.args as { items?: unknown } | null)?.items;
    if (!card.bundleId || !Array.isArray(items)) continue;
    const have = new Set(items.map((i) => rowKey((i as { title?: unknown }).title, (i as { amount?: unknown }).amount)));
    if (wanted.length && wanted.every((key) => have.has(key))) return { bundleId: card.bundleId };
  }
  return null;
}

/** Ключ карточки из списка в ПРОШЛОМ сообщении — по содержимому списка, а не по номеру нынешней просьбы. */
const listKey = (text: string) => `list:${createHash("sha256").update(text.toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim()).digest("hex").slice(0, 32)}`;

/**
 * Список расходов в ЭТОМ сообщении (несколько строк «статья сумма» и слово «расход» или недавнее
 * «внеси расходы») — одна карточка кодом. false — не список, дальше обычный путь (модель).
 */
export async function handleExpenseTextMessage(params: { chatId: string; agentId: string; text: string; messageId?: number }): Promise<boolean> {
  const { chatId, agentId, text } = params;
  if (!/\p{N}/u.test(text)) return false;
  if (!mentionsExpenses(text) && !(await expenseIntentPending(chatId, agentId))) return false;
  if (!(await loadAssistantSettings()).enabled || !(await getExpenseDirector(chatId, agentId))) return false;
  return stageExpenseTextList({ chatId, agentId, text, messageId: params.messageId, lang: langOf(text) });
}

/**
 * Просьба без данных («мана акс», «ҳамин хароҷотҳоро ворид кун», «повтори карточку»). true — ответ дан
 * здесь; false — пусть ответит модель (например, список лежит в прошлом сообщении разговора).
 */
export async function handleExpenseFollowupText(params: {
  chatId: string; agentId: string; text: string; messageId?: number; previousUserText?: string;
}): Promise<boolean> {
  const { chatId, agentId, text, messageId } = params;
  const kind = expenseFollowupKind(text);
  if (!kind) return false;
  if (!(await loadAssistantSettings()).enabled || !(await getExpenseDirector(chatId, agentId))) return false;
  const lang = langOf(text);
  const now = Date.now();
  // 1. Фото, присланные без слов, — теперь с просьбой: одной пачкой, как альбом.
  const memory = await readMemory(chatId, agentId);
  if (memory.photos.length && memory.photosUntil > now) {
    await patchMemory(chatId, agentId, (m) => ({ ...m, photos: [], photosUntil: 0 }), 0);
    const wallet = createAssistantMoneyWallet();
    const groupId = `later:${memory.photos[0]!.messageId}`;
    for (const photo of memory.photos) {
      await collectExpenseAlbumPhoto({ chatId, agentId, messageId: photo.messageId, groupId, fileId: photo.fileId, caption: text, wallet });
    }
    return true;
  }
  // «Запиши» / «дуруст ворид кун» без слова «расход» — короткая реплика, её легко принять за чужую просьбу:
  // карточку и список возвращаем только если за ними нет других дел (explicit — слова «расход»/«карточка» названы).
  const explicit = kind === "record" || kind === "card";
  // 2. Список — в прошлом сообщении, просьба — в этом.
  if (params.previousUserText && /\p{N}/u.test(params.previousUserText)) {
    const fresh = await latestExpenseCard(agentId, LIST_RECALL_MS, true, !explicit);
    if (fresh?.bundleId) { await reofferExpenseBatch(fresh.bundleId, agentId, chatId, messageId); return true; }
    if (kind === "record" || kind === "write") {
      const previous = params.previousUserText;
      // Без слова «расход» и с одной строкой «объект 123» — это не список расходов, а чужой разговор: модели.
      const parsed = parseExpenseTextList(previous, { minRows: mentionsExpenses(previous) || kind === "record" ? 1 : 2 });
      if (!parsed) return false;
      // Этот список уже записан за последний час — второй карточки не собираем.
      const done = await executedExpenseCard(agentId, parsed.rows);
      if (done?.bundleId) { await reofferExpenseBatch(done.bundleId, agentId, chatId, messageId); return true; }
      if (await stageExpenseTextList({
        chatId, agentId, text: previous, messageId, lang, minRows: 1,
        // Ключ — по списку, а не по номеру ЭТОГО сообщения: повторное «запиши» упрётся в уже записанное.
        chatRef: listKey(previous),
      })) return true;
    }
    return false;
  }
  // 3. Карточка расходов: живая — та же, истёкшая — новая с теми же строками.
  const card = await latestExpenseCard(agentId, kind === "record" || kind === "photo" ? RECORD_RECALL_MS : EXPENSE_CARD_RECALL_MS, false, !explicit);
  if (card?.bundleId) { await reofferExpenseBatch(card.bundleId, agentId, chatId, messageId); return true; }
  // Карточка уже исполнена за час: «Записано» повторять не надо.
  if (kind === "record") {
    const done = await executedExpenseCard(agentId);
    if (done?.bundleId) { await reofferExpenseBatch(done.bundleId, agentId, chatId, messageId); return true; }
  }
  // 4. Данных нет: одной фразой — чего не хватает; следующее фото или файл примем как расходы.
  if (kind === "write") return false;
  await patchMemory(chatId, agentId, (m) => ({ ...m, intentUntil: now + EXPENSE_INTENT_MEMORY_MS }), EXPENSE_INTENT_MEMORY_MS);
  await sendMessage(chatId, (kind === "card" ? NO_CARD : MISSING)[lang], messageId);
  return true;
}
