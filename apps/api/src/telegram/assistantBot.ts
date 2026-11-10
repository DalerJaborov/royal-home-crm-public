import { assistantInstagramLink, renderAssistantForTelegram, requestedAssistantReplyMode, requestedAssistantReplyPreference, sanitizeAssistantReply, splitReaction,
  type AssistantReplyMode, type AssistantSpeechLanguage } from "./assistantReply.js";
import { assistantGroupClarification, sendAssistantReply } from "./assistantDelivery.js";
import { editTelegramConfirmationMessage, sendTelegramPriceConfirmationPhotos } from "./assistantConfirmationPhotos.js";
import { ASSISTANT_COLLEAGUE_GREETING, ASSISTANT_GROUP_GREETING } from "./assistantGroupPhrases.js";
import { matchGroupPublicShellQuestion, replyGroupPublicShellQuestion, replyPublicListingQuestion } from "./assistantGroupPublicListing.js";
import { loadAssistantTelegramContext, retainAssistantTelegramTranscript } from "./assistantGroupContext.js";
import { findPropertiesByRef } from "../lib/propertyRefLookup.js";
import { trashedPropertyNoteFor } from "../ai/assistant/tools/propertyPresenter.js";
import { GROUP_QUIET_MS, GROUP_REMAKE_REASON_QUESTION, GROUP_WELCOME_INTERVAL_MS, PROACTIVE_GROUP_INTERVAL_MS, groupAcknowledgment, groupHistoryQuestion, groupInstagramLinkRequest, groupMembershipEvent, groupMontageCommand, groupPropertyRefs, groupStatusFollowUp, isGroupPropertyFollowUp, isGroupRemakeReasonQuestion, isShortPropertyFollowUp, proactivePropertyReply, requestedGroupParticipation, unaddressedConfirmationRequest, unaddressedPropertyQuestion, unaddressedReadRequest, type GroupConfirmationTool } from "./assistantGroupParticipation.js";
export { renderAssistantForTelegram } from "./assistantReply.js";
import { randomUUID } from "node:crypto";
import { ASSISTANT_DEADLINE_SEC, formatPropertyCode, isReadOnlyRole, trimAssistantHistory, type AssistantPropertyCard, type PermissionId } from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { loadAgentAccess, type AgentAccess } from "../auth/middleware.js";
import { actorFromAccess, type AssistantActor } from "../ai/assistant/actor.js";
import { assistantErrorMessage, isAiAssistantEnabled, runAssistantDetailed } from "../ai/assistant.js";
import { assistantLanguage } from "../ai/assistant/languageRouting.js";
import { wrapUntrusted } from "../ai/untrustedContent.js";
import { listAssistantToolPlugins } from "../ai/assistant/tools/index.js";
import { getPropertyWorkList } from "../ai/assistant/tools/getPropertyWorkStatus.js";
import { parseFastPathIntent, tryAssistantFastPath } from "../ai/assistantFastPath.js";
import { findTelegramAgentClients, isVoiceReplayRequest, replayTelegramAssistantVoice, sendTelegramPropertyCard } from "./assistantReadResults.js";
import { clearStaffPropertyPage, propertyPageRequest, propertyPageSize, propertySelection, propertyWorkflowRequest, sendMoreStaffProperties, sendStaffPropertySelection } from "./assistantPropertyPages.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import { handleTelegramPropertyDraft, handleTelegramPropertyDraftCallback } from "./assistantPropertyDraft.js";
import { handleExpenseFileQuestionCallback, handleTelegramExpenseReceipt, handleTelegramExpenseReceiptCallback } from "./assistantExpenseReceipt.js";
import { ADD_EXPENSES_TOOL } from "../ai/assistant/tools/expenseBatchTool.js";
import { applyExpenseFixMessage, expenseBatchOutcomeText, handleExpenseCardCallback, sendExpenseBatchCard } from "./assistantExpenseCard.js";
import { handleAssistantMedia } from "./assistantMedia.js";
import { createAssistantMoneyWallet, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import {
  AssistantActionError,
  discardPendingAssistantAction,
  confirmAssistantAction,
  type AssistantActionActor,
  type AssistantActionView,
} from "../lib/assistantActions.js";
import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import { maskAssistantContacts } from "../lib/assistantContacts.js";
import { findAgentByTelegramChatId, findAgentByTelegramUserId } from "../lib/telegramAgentLink.js";
import { claimCallback } from "../lib/telegramModeration.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { trackBackgroundTask } from "../lib/shutdownState.js";
import { logAssistantFastPathTurn, logAssistantToolCall, logAssistantTurn } from "../lib/aiAssistantAudit.js";
import {
  answerCallbackQuery as answerCallbackQueryRaw,
  getBotUsername,
  editMessageText, sendChatAction, sendHtmlMessage,
  sendMessage,
  sendMessageWithButtons,
  setMessageReaction,
  TelegramApiError,
  IS_LOCAL_BOT_API,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  type TelegramCallbackQuery,
  type TelegramIncomingMessage,
} from "./api.js";

/**
 * ВНУТРЕННИЙ ПОМОЩНИК В TELEGRAM (П5, 03.11.2026,
 * docs/design/internal-assistant-architecture-2026-10-31.md §2.4).
 *
 * Два входа в ОДНО ядро (`runAssistantDetailed` + брокер подтверждений) — своей
 * логики записи здесь нет:
 *  1) личка сотрудника с ботом — разговор с историей, голосовые, кнопки;
 *  2) общая группа сотрудников — бот молчит, пока его не позвали (упоминание,
 *     команда /ai, ответ на его сообщение); просьбу выполняет с правами ТОГО, кто
 *     попросил (определяется по Telegram user id → Agent.telegramUserId).
 *
 * ЧТО НЕЛЬЗЯ ОБОЙТИ (каждый пункт — тест в tests/assistant-telegram.test.ts):
 *  - запись только через карточку «было → станет» и кнопку; свободный текст
 *    ничего не пишет;
 *  - кнопку нажимает ТОЛЬКО автор просьбы: нажатие сверяется по Telegram user id с
 *    владельцем действия, чужому — отказ и ничего не исполняется;
 *  - права перечитываются на нажатии (loadAgentAccess), а не берутся с момента просьбы;
 *    неактивный/акционер — отказ;
 *  - несколько записей одного ответа (цена + перемонтаж) — ОДНА карточка и одна
 *    кнопка; при отказе первой следующие не исполняются;
 *  - повтор доставки/двойное нажатие: claimCallback + идемпотентность брокера + замок
 *    на связку;
 *  - в группе чтение идёт БЕЗ телефонов клиентов, финансов и отчётов (права для чтения
 *    урезаны, плюс маска в тексте ответа).
 */

/** Суточный потолок ходов помощника в Telegram на сотрудника (общий счётчик claimAgentAiAction). */
export const ASSISTANT_TG_DAILY_LIMIT = 150;
/** Голосовые — отдельный, более дорогой счётчик. */
export const ASSISTANT_TG_VOICE_DAILY_LIMIT = 40;
const ASSISTANT_TG_STANDALONE_VOICE_DAILY_LIMIT = 20;
const GROUP_SHORT_VOICE_SECONDS = 60;
const GROUP_AUDIO_MAX_SECONDS = 120;
const DIALOG_KIND = "assistant";
const DIALOG_TTL_MS = 15 * 60_000;

const NOT_LINKED_TEXT =
  "Я вас не знаю. Привяжите аккаунт в личке с ботом: CRM → Профиль → Telegram, откройте ссылку или отправьте мне код.";
const DISABLED_TEXT = "ИИ-помощник выключен в Настройках CRM.";
/**
 * Ответ на нажатие не должен ронять обработку: кнопка могла ждать в очереди чата за долгим
 * ходом модели, и Telegram отвечает «query is too old» — а действие к этому моменту уже
 * исполнено (или отказано), и ложная ошибка в журнале ни к чему.
 */
const answerCallbackQuery = (id: string, text?: string) => answerCallbackQueryRaw(id, text).catch(() => undefined);

const BUNDLE_CALLBACK = /^as:(ok|no):([0-9a-f-]{36})$/;


// ───────────────────────────── права ─────────────────────────────

/** Права, которых в общей группе у помощника нет, даже если они есть у спросившего. */
const GROUP_HIDDEN_PERMISSIONS: readonly PermissionId[] = [
  "clients.viewPhone", "finance.view", "reports.view", "calls.transcripts", "calls.ownTranscripts",
  // Корзина КЛИЕНТОВ — не при чужих глазах в общей группе (07.11.2026); в личном чате доступна.
  // Удалённые ОБЪЕКТЫ — справка для всех и в группе (lib/trashAccess.ts, решение владельца 07.11).
  "archive.view",
];

/**
 * Инструменты, закрытые в общей группе: комиссия по СВОИМ сделкам отдаётся и без
 * finance.view (статистика, сделки), а запись уровня B исполняется без кнопки —
 * при чужих глазах и без «Отменить» это не нужно.
 */
const GROUP_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "search_deals",
  "get_company_stats",
  "get_finance_summary",
  "get_lead_sources",
  "get_client_last_call",
  "create_task",
  "reschedule_task",
  "add_client_note",
  // Деньги в общей группе не показываются и не меняются (10.11.2026): все инструменты расходов.
  // Список буквами (не импортом): сверку с реестром держит тест assistant-expense-batch.
  "list_expenses", "get_expense_summary", "get_expense_forecast", "get_expense_pivot", "list_recurring_expenses",
  "list_expense_archive", "list_expense_categories", "add_expenses", "update_expense", "delete_expense", "restore_expense",
  "pay_expense", "undo_expense_payment", "create_recurring_expense", "update_recurring_expense", "delete_recurring_expense",
  "recurring_expense_payment", "create_expense_category", "update_expense_category", "get_expense_history",
]);

/** Для теста-сторожа: что закрыто в общей группе. */
export function groupHiddenToolsForTests(): ReadonlySet<string> {
  return GROUP_HIDDEN_TOOLS;
}

/** Актор помощника для ЧТЕНИЯ: в группе — без телефонов клиентов, финансов и отчётов. */
export function assistantActorFor(
  agentId: string,
  access: Pick<AgentAccess, "role" | "permissions">,
  scope: "private" | "group"
): AssistantActor {
  if (scope === "private") return actorFromAccess(agentId, access, "telegram-private");
  const permissions = new Set(access.permissions);
  for (const hidden of GROUP_HIDDEN_PERMISSIONS) permissions.delete(hidden);
  return { ...actorFromAccess(agentId, { role: access.role, permissions }, "telegram-group"), hiddenTools: GROUP_HIDDEN_TOOLS };
}

/** Актор брокера на нажатии: ПОЛНЫЕ свежие права нажавшего, канал telegram. */
function actionActorOf(agentId: string, access: AgentAccess, telegramPrivate: boolean): AssistantActionActor {
  return { agentId, channel: "telegram", telegramPrivate, can: (permission) => access.permissions.has(permission) };
}

// ───────────────────────────── рендер ─────────────────────────────

const FIELD_MAX = 120;
function field(value: unknown): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "—" : String(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > FIELD_MAX ? `${flat.slice(0, FIELD_MAX - 1)}…` : flat;
}

function lines(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}: ${field(v)}`)
    .join("; ");
}

/** Одна карточка на все ожидающие действия ответа: «было → станет» по каждому. */
/**
 * Рамка карточки подтверждения на языке собеседника (10.11.2026): «Подтвердите действие / Было /
 * Станет / Подтвердить может только …». Одна таблица на все инструменты записи; значения полей —
 * как их построил инструмент. По умолчанию — русский, как было.
 */
const CARD_FRAME = {
  ru: { confirm: (many: boolean) => `Подтвердите действие${many ? "я" : ""}:`, was: "Было", becomes: "Станет", irreversible: "Необратимо",
    only: (name: string) => `Подтвердить может только ${name}.`, origin: (who: string) => `По сообщению ${who}`,
    ok: "✅ Подтвердить", okIrreversible: "✅ Подтвердить (необратимо)", okPlain: "Подтвердить", cancel: "✖ Отмена", cancelPlain: "Отмена" },
  tg: { confirm: (many: boolean) => `Ин амал${many ? "ҳо" : ""}ро тасдиқ кунед:`, was: "Пеш", becomes: "Мешавад", irreversible: "Баргардонда намешавад",
    only: (name: string) => `Танҳо ${name} тасдиқ карда метавонад.`, origin: (who: string) => `Аз рӯи паёми ${who}`,
    ok: "✅ Тасдиқ", okIrreversible: "✅ Тасдиқ (баргардонда намешавад)", okPlain: "Тасдиқ", cancel: "✖ Бекор", cancelPlain: "Бекор" },
} as const;
export type CardFrameLang = keyof typeof CARD_FRAME;
export const cardFrameLang = (language: ReturnType<typeof assistantLanguage> | undefined): CardFrameLang =>
  language === "tg" || language === "mixed" ? "tg" : "ru";

export function renderBundleCard(actions: readonly AssistantActionView[], authorName: string, maskPhones = false, source?: string, tajik = false, lang: CardFrameLang = "ru"): string {
  const frame = CARD_FRAME[lang];
  const parts = actions.map((a, i) => {
    const p = a.preview;
    const head = actions.length > 1 ? `${i + 1}) ${p.title}` : p.title;
    if (maskPhones && a.tool === "change_property_price" && typeof p.was.Цена === "string" && typeof p.becomes.Цена === "string") {
      const code = /ОБ-\d{1,10}/u.exec(p.title)?.[0];
      const translate = (value: string) => field(value).replace(/\s+с\.?$/u, tajik ? " сомонӣ" : " с.");
      return [
        tajik && code ? `Нархи ${code}` : head,
        `${tajik ? "Пеш" : "Было"}: ${translate(p.was.Цена)} → ${translate(p.becomes.Цена)}`,
        ...(p.becomes.Заявка ? [tajik ? "Роҳбар розӣ шавад, нарх иваз мешавад." : "Цена изменится после одобрения руководителем."] : []),
      ].join("\n");
    }
    return [
      head,
      `   ${frame.was}: ${lines(p.was)}`,
      `   ${frame.becomes}: ${lines(p.becomes)}`,
      p.risk ? `   ${p.irreversible ? "⚠️ " : ""}${field(p.risk)}` : p.irreversible ? `   ⚠️ ${frame.irreversible}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const origin = source ? `${frame.origin(source)}
` : "";
  if (maskPhones && actions.length === 1 && actions[0]?.tool === "change_property_price") {
    return sanitizeAssistantReply(parts[0] ?? "", true);
  }
  const card = `${origin}${frame.confirm(actions.length > 1)}\n\n${parts.join("\n\n")}\n\n${frame.only(authorName)}`;
  return sanitizeAssistantReply(card, maskPhones);
}

// ───────────────────────────── ход помощника ─────────────────────────────

interface TurnResult {
  reply: string;
  propertyCard?: AssistantPropertyCard;
  failed?: true;
  structured?: boolean;
  propertySelection?: NonNullable<ReturnType<typeof propertySelection>>;
  /** Карточки, ждущие «Подтвердить» (уровень C). */
  pending: AssistantActionView[];
  /** Уже выполненные записи уровня B (заметки, задачи). */
  done: AssistantActionView[];
}

interface TurnParams {
  moneyWallet?: AssistantMoneyWallet;
  forwardedEvidence?: boolean;
  readOnlyGroup?: boolean;
  onlyGroupConfirmation?: GroupConfirmationTool;
  allowPropertyCards?: boolean;
  agentId: string;
  scope: "private" | "group";
  history: { role: "user" | "assistant"; content: string }[];
  validateQueueAudience?: () => Promise<boolean>;
  /** Для сообщения-отказа до запуска модели. */
  deny: (text: string) => Promise<void>;
  /** «Печатает…» в чате: Telegram гасит его через ~5 с, поэтому на долгом ходе (до двух минут,
   *  Settings.aiAssistantDeadlineSec) повторяется каждые TYPING_REFRESH_MS, пока идёт модель. */
  showWorking?: () => void;
  /** Ключ хода (`tg:<чат>:<сообщение>`): повторная доставка того же сообщения не повторяет записи. */
  turnKey?: string;
}

/** Чаще, чем Telegram гасит «печатает…» (~5 с), но без лишних вызовов API. */
export const TYPING_REFRESH_MS = 4_000;

/**
 * ХОД ПОМОЩНИЦЫ ВНЕ ОЧЕРЕДИ ЧАТА (ревью 08.11.2026). Ход теперь длится до двух минут
 * (Settings.aiAssistantDeadlineSec). Внутри очереди чата (telegram/bot.ts, chatChains) он держал бы
 * всю группу, а при long polling (telegram/poller.ts) — пачку всех чатов. Поэтому долгая часть
 * уходит в свою очередь на одного человека: порядок ответов одному человеку сохраняется, соседи
 * по группе и другие чаты не ждут. Двойной обработки нет: апдейт уже принят и отмечен (дедуп
 * вебхука и поллера срабатывает до этого места), очередь только откладывает ответ.
 * Ответ отдаётся наверх как `reply` (TelegramUpdateAccepted): вебхук и тесты его дожидаются,
 * поллер — нет; мягкая остановка ждёт его через trackBackgroundTask.
 */
const assistantLanes = new Map<string, Promise<void>>();

/**
 * Сколько ходов помощницы идут разом во всём процессе. Остальные ждут свободного места в общей
 * очереди: двадцать человек, спросивших разом, не должны разом съесть память worker и лимиты
 * Gemini. Порядок внутри одного человека держит его собственная очередь (assistantLanes).
 */
export const ASSISTANT_CONCURRENT_TURNS = 8;
let assistantTurnsRunning = 0;
const assistantTurnWaiters: (() => void)[] = [];

async function withAssistantSlot<T>(work: () => Promise<T>): Promise<T> {
  if (assistantTurnsRunning >= ASSISTANT_CONCURRENT_TURNS) {
    await new Promise<void>((resolve) => assistantTurnWaiters.push(resolve));
  } else {
    assistantTurnsRunning += 1;
  }
  try {
    return await work();
  } finally {
    const next = assistantTurnWaiters.shift();
    // Место передаётся следующему ожидающему напрямую, счётчик при этом не меняется.
    if (next) next();
    else assistantTurnsRunning -= 1;
  }
}

/** Для тестов: сколько ходов помощницы сейчас идёт и сколько ждут места. */
export function assistantTurnSlotsForTests(): { running: number; waiting: number } {
  return { running: assistantTurnsRunning, waiting: assistantTurnWaiters.length };
}
const deferredReplies = new WeakMap<object, Promise<void>>();

/**
 * Сколько следующий ход человека ждёт предыдущий: самый длинный срок хода + минута. Зависший
 * (не ответивший) ход не должен навсегда запереть очередь этого человека.
 */
const DEFAULT_LANE_WAIT_CEILING_MS = ASSISTANT_DEADLINE_SEC.max * 1000 + 60_000;
let laneWaitCeilingMs = DEFAULT_LANE_WAIT_CEILING_MS;
/** Для тестов: короткий потолок (null — обычный). */
export function setAssistantLaneCeilingForTests(ms: number | null): void {
  laneWaitCeilingMs = ms ?? DEFAULT_LANE_WAIT_CEILING_MS;
}

export function runInAssistantLane(key: string, work: () => Promise<unknown>, onError: (err: unknown) => Promise<void>): Promise<void> {
  const before = assistantLanes.get(key) ?? Promise.resolve();
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  const previous = Promise.race([
    before,
    new Promise<void>((resolve) => { ceilingTimer = setTimeout(resolve, laneWaitCeilingMs); }),
  ]).finally(() => clearTimeout(ceilingTimer));
  const run = previous.then(async () => {
    try {
      await withAssistantSlot(work);
    } catch (err) {
      await onError(err).catch(() => {});
    }
  });
  assistantLanes.set(key, run);
  void run.then(() => {
    if (assistantLanes.get(key) === run) assistantLanes.delete(key);
  });
  return trackBackgroundTask(run);
}

/** Отложенный ответ помощницы на это сообщение (если был) — для telegram/bot.ts. */
export function takeDeferredAssistantReply(msg: TelegramIncomingMessage): Promise<void> | undefined {
  const reply = deferredReplies.get(msg);
  deferredReplies.delete(msg);
  return reply;
}

function deferAssistantReply(msg: TelegramIncomingMessage, reply: Promise<void>): void {
  deferredReplies.set(msg, reply);
}

function montageQueueLanguage(text: string): "ru" | "tg" | null {
  const words = text.trim().replace(/[?!.]+$/u, "").trimEnd();
  if (/^(?:сколько\s+(?:роликов|видео|объектов)(?:\s+сейчас)?|(?:покажи(?:те)?|перечисли(?:те)?)\s+(?:ролики|видео|объекты))\s+на\s+монтаже$/iu.test(words)) return "ru";
  if (/^(?:чанд\s+(?:навор|ролик|видео|объект)(?:\s+(?:ҳозир|хозир))?\s+дар\s+монтаж(?:ай|\s+(?:аст|ҳаст|хаст))?)$/iu.test(words)) return "tg";
  return null;
}

function formatMontageQueue(queue: Awaited<ReturnType<typeof getPropertyWorkList>>, language: "ru" | "tg", includeList: boolean): string {
  const labels = language === "tg"
    ? { all: "Дар монтаж", mine: "Наворҳои ту дар монтаж", editor: "Назди монтажёр", waiting: "Дар навбат", more: "Боз" }
    : { all: "На монтаже по компании", mine: "Твои объекты на монтаже", editor: "У монтажёра", waiting: "В очереди", more: "Ещё" };
  const lines = [`${queue.scope === "COMPANY_QUEUE" ? labels.all : labels.mine} · ${queue.total}`];
  if (queue.total === 0) return lines[0];
  if (queue.withEditor !== undefined && queue.waitingForEditor !== undefined) {
    lines.push(`${labels.editor} ${queue.withEditor} · ${labels.waiting} ${queue.waitingForEditor}`);
  }
  if (!includeList) return lines.join("\n");
  const codes = queue.items.slice(0, 4).map(item => item.code);
  if (codes.length) lines.push(codes.join(", "));
  if (queue.total > codes.length) lines.push(`${labels.more} ${queue.total - codes.length}`);
  return lines.join("\n");
}

/** Общий ход: рубильник → права → потолок → быстрый путь → ядро. null — отказ уже отправлен. */
async function runTurn(params: TurnParams): Promise<TurnResult | null> {
  if (!(await isAiAssistantEnabled())) {
    await params.deny(DISABLED_TEXT);
    return null;
  }
  const last = params.history[params.history.length - 1];
  const queueLanguage = last?.role === "user" && !params.forwardedEvidence && !params.onlyGroupConfirmation
    ? montageQueueLanguage(last.content) : null;
  const access = await loadAgentAccess(params.agentId, queueLanguage ? prisma : undefined);
  if (!access || !access.isActive) {
    await params.deny("Ваша учётка отключена.");
    return null;
  }
  const cap = await claimAgentAiAction(params.agentId, "assistant-telegram", ASSISTANT_TG_DAILY_LIMIT);
  if (!cap.allowed) {
    await params.deny("На сегодня лимит запросов к помощнику исчерпан, продолжим завтра.");
    return null;
  }
  const actor = assistantActorFor(params.agentId, access, params.scope);
  if (params.readOnlyGroup || params.onlyGroupConfirmation || (params.scope === "group" && params.forwardedEvidence)) {
    actor.hiddenTools = new Set([...GROUP_HIDDEN_TOOLS, "get_client_history", "get_client_card", "web_reference"]);
  }
  if (params.onlyGroupConfirmation) {
    actor.hiddenTools = new Set([...(actor.hiddenTools ?? []), ...listAssistantToolPlugins()
      .filter(plugin => plugin.level !== "A" && (plugin.level !== "C" || plugin.name !== params.onlyGroupConfirmation))
      .map(plugin => plugin.name)]);
  }
  const turnStartedAt = Date.now();
  if (queueLanguage) {
    let reply: string;
    let queueFailed = false;
    try {
      const queue = await getPropertyWorkList(actor, "queue");
      const currentAccess = await loadAgentAccess(params.agentId, prisma);
      if (!currentAccess?.isActive || currentAccess.role !== access.role
        || currentAccess.permissions.has("properties.delete") !== access.permissions.has("properties.delete")
        || (params.validateQueueAudience && !(await params.validateQueueAudience()))) return null;
      void logAssistantToolCall({
        agentId: actor.id, tool: "get_property_work_status", argsSummary: '{"scope":"queue"}', resultCount: queue.total,
        question: last?.role === "user" ? last.content : null,
      });
      reply = formatMontageQueue(queue, queueLanguage, params.scope === "private");
    } catch (error) {
      void logSystemError("ai", `Помощник Telegram: очередь монтажа: ${describeError(error)}`);
      queueFailed = true;
      reply = queueLanguage === "tg"
        ? "Навбати монтажро санҷида натавонистам. Каме баъд боз пурс."
        : "Не удалось проверить очередь монтажа. Попробуй чуть позже.";
    }
    void logAssistantTurn({
      agentId: actor.id, channel: "telegram", surface: actor.surface ?? null,
      question: last?.role === "user" ? last.content : null,
      outcome: queueFailed ? "error" : "answer", reason: queueFailed ? "internal" : null, route: "fast_path",
      rounds: 0, toolCalls: 1, replyChars: reply.length, ms: Date.now() - turnStartedAt,
    });
    return { reply, pending: [], done: [], structured: true };
  }
  const canCaptureCards = Boolean(params.allowPropertyCards && !params.forwardedEvidence && !params.onlyGroupConfirmation
    && last?.role === "user" && !propertyWorkflowRequest(last.content) && requestedAssistantReplyMode(last.content) === "auto");

  // In a group the deterministic path is limited to a property number.
  if (!params.readOnlyGroup && !params.onlyGroupConfirmation && last?.role === "user" && (params.scope === "private" || parseFastPathIntent(last.content)?.kind === "property-code")) {
    try {
      if (params.scope === "private") {
        const roster = await findTelegramAgentClients(last.content, actor);
        if (roster !== null) {
          void logAssistantToolCall({ agentId: actor.id, tool: "find_clients", argsSummary: "{}", resultCount: null, question: last.content });
          void logAssistantFastPathTurn({
            agentId: actor.id, channel: "telegram", surface: actor.surface, question: last.content,
            reply: roster, found: 1, startedAt: turnStartedAt,
          });
          return { reply: roster, pending: [], done: [], structured: true };
        }
      }
      const fast = await tryAssistantFastPath(last.content, actor);
      if (fast) {
        void logAssistantToolCall({
          agentId: actor.id,
          tool: fast.tool,
          argsSummary: fast.argsSummary,
          resultCount: fast.cards.length,
          question: last.content,
        });
        void logAssistantFastPathTurn({
          agentId: actor.id, channel: "telegram", surface: actor.surface, question: last.content,
          reply: fast.reply, found: fast.cards.length + (fast.trashed ?? 0), startedAt: turnStartedAt,
        });
        const first = fast.cards[0];
        return {
          reply: fast.reply, pending: [], done: [], structured: true,
          propertySelection: canCaptureCards
            ? propertySelection("search_properties", fast.cards.filter(card => card.kind === "property")) ?? undefined
            : undefined,
          ...(fast.cards.length === 1 && first?.kind === "property" ? { propertyCard: first } : {}),
        };
      }
    } catch (err) {
      console.error("[telegram:assistant:fast-path]", describeError(err));
    }
  }

  const seen = new Map<string, AssistantActionView>();
  let structured = Boolean(params.forwardedEvidence);
  let searchSelection: TurnResult["propertySelection"];
  let propertyLookup: TurnResult["propertySelection"];
  let mixedRead = false;
  let searches = 0;
  const readOnly = Boolean(params.forwardedEvidence || params.readOnlyGroup);
  const typing = params.showWorking ? setInterval(params.showWorking, TYPING_REFRESH_MS) : null;
  const outcome = await runAssistantDetailed(params.history, actor, {
    channel: "telegram",
    turnKey: params.turnKey,
    moneyWallet: params.moneyWallet,
    confirmUi: !readOnly,
    readOnly,
    onConfirm: (action) => seen.set(action.id, action),
    onToolResult: (name, result, args) => {
      structured = true;
      if (!canCaptureCards) return;
      if (name === "search_properties") {
        searches += 1;
        searchSelection = propertySelection(name, result, args) ?? undefined;
      } else if (name === "find_property") {
        propertyLookup ??= propertySelection(name, result, args) ?? undefined;
      } else if (name !== "get_property_card") mixedRead = true;
    },
  }).finally(() => {
    if (typing) clearInterval(typing);
  });
  const all = [...seen.values()];
  const pending = all.filter((a) => a.status === "PENDING");
  const done = all.filter((a) => a.status === "EXECUTED");
  if (!outcome.ok) {
    return { reply: assistantErrorMessage(outcome.code, params.history), pending, done, failed: true };
  }
  return {
    reply: outcome.reply, pending, done, structured,
    propertySelection: !mixedRead && searches < 2 ? searchSelection ?? propertyLookup : undefined,
  };
}

const TEXT_MAX_CHARS = 3900;
const CARD_MAX_CHARS = 3300;

/** Гасит ожидающие действия, которые так и не получили карточки (повтор поможет — они уйдут чистыми). */
async function cancelPending(actions: readonly AssistantActionView[], agentId: string): Promise<void> {
  const actor: AssistantActionActor = { agentId, channel: "telegram", can: () => false };
  for (const a of actions) await discardPendingAssistantAction(a.id, actor, { onlyUnbundled: true }).catch(() => undefined);
}

type ConfirmationBinding =
  | { kind: "bound"; bundleId: string; actionIds: string[] }
  | { kind: "overlap" | "changed" };

async function bindConfirmation(agentId: string, actionIds: string[]): Promise<ConfirmationBinding> {
  return prisma.$transaction(async (tx) => {
    // Lock in the same order even when two requests overlap but list actions differently.
    const rows = await tx.$queryRaw<{ id: string; bundleId: string | null; createdAt: Date }[]>`
      SELECT "id", "bundleId", "createdAt" FROM "AssistantAction"
      WHERE "id" IN (${Prisma.join(actionIds)}) AND "agentId" = ${agentId}
        AND "status" = 'PENDING' AND "expiresAt" > CURRENT_TIMESTAMP
      ORDER BY "id" FOR UPDATE
    `;
    if (rows.length !== actionIds.length) return { kind: "changed" };
    const orderedIds = rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((row) => row.id);
    const existing = rows.find((row) => row.bundleId)?.bundleId;
    if (existing) {
      if (rows.some((row) => row.bundleId !== existing)) return { kind: "overlap" };
      const members = await tx.assistantAction.count({ where: { bundleId: existing } });
      if (members !== actionIds.length) return { kind: "overlap" };
      return { kind: "bound", bundleId: existing, actionIds: orderedIds };
    }
    const bundleId = randomUUID();
    await tx.assistantAction.updateMany({ where: { id: { in: actionIds } }, data: { bundleId } });
    return { kind: "bound", bundleId, actionIds: orderedIds };
  });
}

/** Привязывает ожидающие действия к одной связке и отправляет единую карточку с кнопками. */
async function sendTurnResult(
  chatId: string,
  result: TurnResult,
  ctx: { agentId: string; authorName: string; scope: "private" | "group"; replyTo?: number; messageThreadId?: number; source?: string; fromVoice?: boolean; addressedGroupVoice?: boolean; mode?: AssistantReplyMode; reactTo?: number; requestLanguage?: ReturnType<typeof assistantLanguage>; voiceLanguage?: AssistantSpeechLanguage;
    /** Язык рамки карточки подтверждения (личка: язык сообщения человека). */
    cardLanguage?: ReturnType<typeof assistantLanguage> }
): Promise<void> {
  const maskPhones = ctx.scope === "group";
  const split = splitReaction(result.reply);
  if (split.reaction && ctx.reactTo) void setMessageReaction(chatId, ctx.reactTo, split.reaction);
  const avoidTechnicalNarration = maskPhones && (result.pending.length > 0 || result.propertyCard)
    && assistantGroupClarification(split.text, ctx.requestLanguage) !== null;
  const rendered = avoidTechnicalNarration ? "" : renderAssistantForTelegram(split.text, { maskPhones });
  // Записи уровня B исполнены сразу — человек должен видеть, что именно записано.
  const written = result.done.map((a) => sanitizeAssistantReply(`Записано: ${field(a.preview.title)}`, maskPhones));
  if (result.pending.length === 0) {
    if (result.propertyCard && await sendTelegramPropertyCard(chatId, result.propertyCard, maskPhones, ctx.replyTo)) {
      if (ctx.mode === "voice" && !avoidTechnicalNarration) await sendAssistantVoiceReply(chatId, maskPhones ? sanitizeAssistantReply(split.text, true) : split.text, ctx.replyTo);
      return;
    }
    await sendAssistantReply(chatId, split.text, {
      scope: ctx.scope, fromVoice: ctx.fromVoice, structured: result.structured,
      addressedGroupVoice: ctx.addressedGroupVoice,
      requestLanguage: ctx.requestLanguage, voiceLanguage: ctx.voiceLanguage,
      mode: result.failed ? "text" : ctx.mode, replyTo: ctx.replyTo, messageThreadId: ctx.messageThreadId, written,
    });
    return;
  }
  // Пачка расходов — своя карточка по статьям, со страницами и «Править» (assistantExpenseCard.ts).
  if (!maskPhones && result.pending.length === 1 && result.pending[0]!.tool === ADD_EXPENSES_TOOL) {
    // Карточка говорит сама за себя: фразу модели «проверьте и нажмите» второй репликой не шлём.
    const lead = written.join("\n");
    if (lead.trim()) await sendMessage(chatId, lead, ctx.replyTo).catch(() => undefined);
    if (!(await sendExpenseBatchCard(chatId, result.pending[0]!, ctx.agentId, ctx.replyTo))) {
      await cancelPending(result.pending, ctx.agentId);
      await sendMessage(chatId, "Карточка уже изменилась. Повторите просьбу.", ctx.replyTo);
    }
    return;
  }
  const priceOnlyInGroup = maskPhones && result.pending.every(action => action.tool === "change_property_price");
  const tajikPrice = priceOnlyInGroup && (ctx.requestLanguage === "tg" || ctx.requestLanguage === "mixed");
  const frameLang = cardFrameLang(ctx.cardLanguage ?? ctx.requestLanguage);
  const frame = CARD_FRAME[frameLang];
  const preview = renderBundleCard(result.pending, ctx.authorName, maskPhones, ctx.source, tajikPrice, frameLang);
  const body = [priceOnlyInGroup ? "" : rendered, ...written].filter(Boolean).join("\n");
  // Кнопка без полностью видимой карточки — подтверждение вслепую: слишком длинное не показываем.
  if (preview.length > CARD_MAX_CHARS) {
    await cancelPending(result.pending, ctx.agentId);
    await sendMessage(chatId, "Слишком длинная карточка подтверждения — разбейте просьбу на части.", ctx.replyTo);
    return;
  }
  const pendingById = new Map(result.pending.map((action) => [action.id, action]));
  const binding = await bindConfirmation(ctx.agentId, [...pendingById.keys()]);
  if (binding.kind !== "bound") {
    const tg = ctx.requestLanguage === "tg" || ctx.requestLanguage === "mixed";
    const note = binding.kind === "overlap"
      ? tg ? "Аввал корти пешинаро тасдиқ ё бекор кунед, баъд боз нависед." : "Сначала подтвердите или отмените предыдущую карточку, потом повторите просьбу."
      : tg ? "Корт дигар шуд. Як бори дигар нависед." : "Карточка уже изменилась. Повторите просьбу.";
    await sendMessage(chatId, note, ctx.replyTo);
    return;
  }
  const { bundleId } = binding;
  // Show the same order that pressing either card will execute.
  const card = renderBundleCard(binding.actionIds.map((id) => pendingById.get(id)!), ctx.authorName, maskPhones, ctx.source, tajikPrice, frameLang);
  const irreversible = result.pending.some((a) => a.preview.irreversible);
  // Карточка целиком, ответ модели — по остатку места (не наоборот).
  const room = Math.max(0, TEXT_MAX_CHARS - card.length - 2);
  const text = [body.slice(0, room), card].filter(Boolean).join("\n\n");
  const buttons = [[
    { text: tajikPrice ? "Ҳа" : irreversible ? frame.okIrreversible : maskPhones ? frame.okPlain : frame.ok, callback_data: `as:ok:${bundleId}` },
    { text: tajikPrice ? "Бекор" : maskPhones ? frame.cancelPlain : frame.cancel, callback_data: `as:no:${bundleId}` },
  ]];
  if (priceOnlyInGroup && result.pending.length === 1
      && await sendTelegramPriceConfirmationPhotos(chatId, result.pending[0], text, buttons, ctx.replyTo)) return;
  await sendMessageWithButtons(chatId, text, buttons, ctx.replyTo);
}

type CardScope = Parameters<typeof sendStaffPropertySelection>[0];
const propertyLanguage = (language: ReturnType<typeof assistantLanguage>) => language === "tg" || language === "mixed" ? "tg" : "ru";

async function sendSelectedPropertyCards(scope: CardScope, result: TurnResult, request: string): Promise<boolean> {
  if (!result.propertySelection || result.pending.length || result.done.length || result.failed) return false;
  const lang = propertyLanguage(assistantLanguage([{ role: "user", content: request }]));
  const outcome = await sendStaffPropertySelection(scope, result.propertySelection, propertyPageSize(request), lang);
  if (outcome === "changed") {
    await sendMessage(scope.chatId, lang === "tg" ? "Рӯйхат дигар шуд. Боз як бор пурсед." : "Список изменился. Повторите поиск.", scope.replyTo);
  }
  return outcome !== "fallback";
}

async function replyWithMoreProperties(scope: CardScope, count: number, request: string, quietIfMissing = false): Promise<boolean> {
  if (!(await isAiAssistantEnabled())) return quietIfMissing;
  const lang = /^боз(?!\p{L})/iu.test(request.trim()) ? "tg" : propertyLanguage(assistantLanguage([{ role: "user", content: request }]));
  const outcome = await sendMoreStaffProperties(scope, count, lang);
  if (outcome === "missing" && quietIfMissing) return false;
  if (outcome === "unavailable") {
    await sendMessage(scope.chatId, lang === "tg"
      ? "Хонаҳо ёфтам, лекин кортҳоро фиристода натавонистам. Як бори дигар «боз» нависед."
      : "Варианты нашла, но карточки не отправились. Напишите «ещё» повторно.", scope.replyTo);
  }
  if (outcome === "missing" || outcome === "empty") {
    await sendMessage(scope.chatId, outcome === "missing"
      ? lang === "tg" ? "Аввал гӯед, чӣ хел хона меҷӯед." : "Сначала скажите, какие объекты подобрать."
      : lang === "tg" ? "Бо ҳамин шартҳо дигар хона наёфтам." : "По этим условиям больше вариантов не нашла.", scope.replyTo);
  }
  return true;
}

// ───────────────────────────── личка ─────────────────────────────

const HELP_TEXT =
  "Я помощник CRM. Напишите или надиктуйте просьбу: «найди клиента …», «покажи ОБ-123», «снизь цену ОБ-123 до 90000». " +
  "Всё, что меняет данные, я показываю карточкой «было → станет» и жду вашего «Подтвердить». «Добавь объект» — открыть мастер в личке. /new — начать разговор заново.";

async function loadHistory(chatId: string, agentId: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (!row || row.kind !== DIALOG_KIND || row.agentId !== agentId || row.expiresAt <= new Date()) return [];
  const messages = (row.payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m): m is { role: "user" | "assistant"; content: string } =>
      !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
  );
}

async function saveHistory(chatId: string, agentId: string, history: { role: "user" | "assistant"; content: string }[]) {
  // Чужое состояние в этом же чате (модерация, вопрос монтажёру) не затираем.
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (row && row.kind !== DIALOG_KIND && row.expiresAt > new Date()) return;
  const data = {
    agentId,
    kind: DIALOG_KIND,
    payload: { messages: trimAssistantHistory(history) },
    expiresAt: new Date(Date.now() + DIALOG_TTL_MS),
  };
  await prisma.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
}

async function clearHistory(chatId: string) {
  await prisma.telegramDialogState.deleteMany({ where: { chatId, kind: DIALOG_KIND } });
}

/** Голосовое → текст тем же путём, что POST /transcribe (ai/transcribe.ts). */
async function transcribeVoice(msg: TelegramIncomingMessage, agentId: string, wallet: AssistantMoneyWallet, standalone = false): Promise<{ text: string } | { error: string }> {
  // Платная расшифровка — только если помощник вообще включён и учётка жива.
  if (!(await isAiAssistantEnabled())) return { error: DISABLED_TEXT };
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive) return { error: "Ваша учётка отключена." };
  const cap = await claimAgentAiAction(agentId,
    standalone ? "assistant-telegram-group-standalone-voice" : "assistant-telegram-voice",
    standalone ? ASSISTANT_TG_STANDALONE_VOICE_DAILY_LIMIT : ASSISTANT_TG_VOICE_DAILY_LIMIT);
  if (!cap.allowed) return { error: "Лимит голосовых на сегодня исчерпан — напишите текстом." };
  const media = await handleAssistantMedia(msg, agentId, { allowGroup: msg.chat.type !== "private", wallet });
  if (media.error) return { error: media.text };
  const text = media.extraction?.transcript;
  if (!text?.trim() || media.extraction?.incomplete) {
    console.warn("[telegram:assistant:media] no usable transcript", {
      messageId: msg.message_id, scope: msg.chat.type === "private" ? "private" : "group",
      cause: text?.trim() ? "incomplete" : "empty",
    });
    return { error: "Не удалось полностью распознать речь — напишите просьбу текстом." };
  }
  return { text: text.trim() };
}

/** Пересланная речь — источник фактов. */
function forwardedVoicePrompt(msg: TelegramIncomingMessage, transcript: string): string | null {
  if (!msg.forward_origin && !msg.forward_from_message_id) return null;
  const language = assistantLanguage([{ role: "user", content: transcript }]);
  const prompt = language === "tg" || language === "mixed"
    ? "Аз рӯи ин овоз ба ман ҷавоб деҳ. Агар объект ҷӯянд, бо search_properties ҷустуҷӯ кун. Навъ, масоҳат, ҳолат ва маҳалҳоро дақиқ нигоҳ дор. Агар видео пурсанд, withVideo-ро истифода бар. Агар тирезаҳои зиёд пурсанд, шумораашро бигӯ. Натиҷа ва пайванди кортро деҳ. Агар чизе намерасад, як саволи кӯтоҳ деҳ. Бе сарлавҳа ва бе шарҳи кори худ."
    : "Ответь по делу на это пересланное голосовое. Если в записи ищут варианты объекта, сначала найди их через search_properties. Используй названные тип, диапазон площади, стадию, альтернативные места и наличие видео. Для пожелания о многих окнах покажи фактическое число. Дай только проверенные варианты и ссылки на карточки. Если просьба неясна, задай один короткий вопрос. Без заголовков и служебных фраз.";
  return `${prompt}\n${wrapUntrusted("document", transcript, 3000)}`;
}

function forwardedTextPrompt(text: string): string {
  const language = assistantLanguage([{ role: "user", content: text }]);
  const prompt = language === "tg" || language === "mixed"
    ? "Аз рӯи ин паём кӯтоҳ ҷавоб деҳ. Агар чизе намерасад, як савол деҳ."
    : "Коротко ответь по пересланному сообщению. Если не хватает данных, задай один вопрос.";
  return `${prompt}\n${wrapUntrusted("document", text, 3000)}`;
}

/** Личный чат сотрудника, не монтажёра: всё, что он пишет, — просьба помощнику. */
/**
 * Личка сотрудника — ход помощницы в очереди этого чата, но вне общей очереди апдейтов
 * (runInAssistantLane): долгий ход не держит поллер и остальные чаты. Ответ — через
 * takeDeferredAssistantReply(msg). У handleAssistantPrivate свой перехват ошибок.
 */
export function startAssistantPrivate(msg: TelegramIncomingMessage, agent: { id: string; fullName: string }): void {
  deferAssistantReply(msg, runInAssistantLane(`private:${msg.chat.id}`, () => handleAssistantPrivate(msg, agent), async (err) => {
    await logSystemError("telegram", `Помощник в личке Telegram: ${describeError(err)}`);
  }));
}

export async function handleAssistantPrivate(
  msg: TelegramIncomingMessage,
  agent: { id: string; fullName: string }
): Promise<void> {
  const chatId = String(msg.chat.id);
  const cardScope: CardScope = { chatId, agentId: agent.id, replyTo: msg.message_id };
  const send = (text: string) => sendMessage(chatId, text).then(() => undefined);
  try {
    const videoDocument = msg.document && (msg.document.mime_type?.startsWith("video/")
      || /\.(?:mov|mp4|m4v|mkv|avi|webm)$/iu.test(msg.document.file_name ?? "")) ? msg.document : undefined;
    const video = msg.video ?? msg.video_note ?? videoDocument;
    if (!IS_LOCAL_BOT_API && video?.file_size && video.file_size > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) {
      await send("Это видео больше 20 МБ — в текущем подключении к Telegram я не могу его скачать. Загрузите ролик через CRM-панель объекта. Файл ещё не сохранён в CRM.");
      return;
    }
    const isForwarded = Boolean(msg.forward_origin || msg.forward_from_message_id);
    const forwardedPlain = isForwarded && Boolean((msg.text ?? msg.caption)?.trim());
    const moneyWallet = createAssistantMoneyWallet();
    if (msg.document && await handleTelegramExpenseReceipt(msg, agent.id, moneyWallet)) return;
    if (!isForwarded && await handleTelegramPropertyDraft(msg, agent, transcribeVoice)) return;
    if (msg.photo?.length && await handleTelegramExpenseReceipt(msg, agent.id, moneyWallet)) return;
    let text = (msg.text ?? msg.caption ?? "").trim();
    const fromVoice = Boolean(msg.voice || msg.audio);
    let forwardedEvidence = forwardedPlain;
    if (!forwardedPlain && (text === "/new" || text === "/reset")) {
      await clearHistory(chatId);
      clearStaffPropertyPage(cardScope);
      await send("Начали заново.");
      return;
    }
    if (!forwardedPlain && text.startsWith("/")) {
      await send(HELP_TEXT);
      return;
    }
    if ((msg.photo?.length || msg.document) && text) {
      if (!(await isAiAssistantEnabled())) { await send(DISABLED_TEXT); return; }
      const access = await loadAgentAccess(agent.id);
      if (!access?.isActive) { await send("Ваша учётка отключена."); return; }
      void sendChatAction(chatId).catch(() => {});
      const media = await handleAssistantMedia(msg, agent.id, { wallet: moneyWallet });
      const extracted = access.permissions.has("clients.viewPhone") ? media.text : maskAssistantContacts(media.text);
      // File text is quoted evidence, never a request that may authorize CRM writes.
      for (let offset = 0; offset < extracted.length; offset += 3500) await send(extracted.slice(offset, offset + 3500));
      return;
    }
    if (fromVoice) {
      const voice = await transcribeVoice(msg, agent.id, moneyWallet);
      if ("error" in voice) {
        await send(voice.error);
        return;
      }
      const forwarded = forwardedVoicePrompt(msg, voice.text);
      forwardedEvidence = forwarded !== null;
      text = forwarded ?? voice.text;
    } else if (forwardedPlain) {
      text = forwardedTextPrompt(text);
    }
    if (!text) {
      // Голое фото/видео/файл без слов: молча «👀» (цель назовут следующим сообщением), без текста.
      const bare = msg.photo?.length || msg.video || msg.document || msg.video_note || msg.animation;
      if (bare && msg.message_id) {
        await setMessageReaction(chatId, msg.message_id, "👀");
        return;
      }
      await send(HELP_TEXT);
      return;
    }
    // Ответ на «Править → строка N» в карточке расходов: поправка строки, а не новая просьба.
    if (!forwardedEvidence && await applyExpenseFixMessage(chatId, agent.id, text, msg.message_id)) return;
    const more = !forwardedEvidence && propertyPageRequest(text);
    if (more && await replyWithMoreProperties(cardScope, more, text)) return;
    const previous = await loadHistory(chatId, agent.id);
    if (!forwardedEvidence && isVoiceReplayRequest(text)) {
      if (!(await isAiAssistantEnabled())) { await send(DISABLED_TEXT); return; }
      if (!(await loadAgentAccess(agent.id))?.isActive) { await send("Ваша учётка отключена."); return; }
      const lastReply = previous.slice().reverse().find(message => message.role === "assistant")?.content;
      if (!lastReply) { await send("В этом разговоре пока нет ответа для озвучки."); return; }
      if (!(await replayTelegramAssistantVoice(chatId, lastReply, msg.message_id))) {
        await send("Не получилось озвучить ответ целиком.");
      }
      return;
    }
    const followup = /^а[ \t]+(?:№[ \t]*)?(\d{1,9})[?!.]*$/iu.exec(text);
    const previousQuestion = previous.slice().reverse().find(message => message.role === "user");
    if (followup && previousQuestion && parseFastPathIntent(previousQuestion.content)?.kind === "property-code") {
      text = `объект ${followup[1]}`;
    }
    const showTyping = fromVoice ? undefined : () => void sendChatAction(chatId).catch(() => {});
    showTyping?.();
    const history = [...previous, { role: "user" as const, content: text.slice(0, 4000) }];
    const result = await runTurn({ agentId: agent.id, scope: "private", history, deny: send, moneyWallet, forwardedEvidence, allowPropertyCards: true,
      showWorking: showTyping, turnKey: `tg:${chatId}:${msg.message_id}`,
      validateQueueAudience: async () => (await findAgentByTelegramChatId(chatId))?.id === agent.id,
    });
    if (!result) return;
    if (!await sendSelectedPropertyCards(cardScope, result, text)) {
      const preference = forwardedEvidence ? undefined : requestedAssistantReplyPreference(text);
      await sendTurnResult(chatId, result, {
        agentId: agent.id, authorName: agent.fullName, scope: "private", fromVoice,
        mode: preference?.mode ?? "auto", reactTo: msg.message_id, voiceLanguage: preference?.voiceLanguage,
        requestLanguage: preference?.mode === "voice" ? assistantLanguage([{ role: "user", content: text }]) : undefined,
        cardLanguage: assistantLanguage([{ role: "user", content: text }]),
      });
    }
    await saveHistory(chatId, agent.id, [...history, { role: "assistant", content: result.reply.slice(0, 4000) }]);
  } catch (err) {
    await logSystemError("telegram", `Помощник в личке Telegram: ${describeError(err)}`);
    await send("Не получилось ответить, попробуйте ещё раз.").catch(() => {});
  }
}

// ───────────────────────────── группа ─────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A name in conversation is not an address. Without punctuation require an imperative.
const NAMED_REQUEST = /^(?:пожалуйста[, ]+)?(?:найди|покажи|помоги|проверь|скажи|ответь|подскажи|снизь|подними|измени|поменяй|поставь|сними|удали|верни|добавь|запиши|навис|нишон\s+деҳ|ҷавоб\s+деҳ|санҷ|кумак\s+кун)(?=\s|[!?.,:]|$)/iu;
// A question addressed to the group and Shabnam can follow a greeting.
const GROUP_NAMED_QUESTION = /(?:^|[\n.!?])\s*(?:савол\s+ба\s+(?:(?:аҳли\s+)?гур[ӯу]ҳ\s+ва\s+)?|вопрос\s+(?:(?:к\s+)?(?:коллегам|группе)\s+и\s+|к\s+)?)(?:шабнам|мушовир)(?=$|[\n.!?:—–-])/iu;
const GREETED_BOT = /^(?:салом|ассалому\s+алайкум|привет|здравствуйте|добрый\s+(?:день|вечер|утро))[,!:.\s]+(?:шабнам|мушовир)(?=$|[,!:.?\s—–-])/iu;

/** Позвали бота: прямое имя, @упоминание, /ai или ответ на его сообщение. */
export function addressedToBot(msg: TelegramIncomingMessage, botUsername: string): { addressed: boolean; text: string } {
  const raw = (msg.text ?? msg.caption ?? "").trim();
  const mentionSource = `(^|[^\\w])@${escapeRe(botUsername)}(?![\\w])`;
  const replyToBot =
    msg.reply_to_message?.from?.is_bot === true &&
    msg.reply_to_message.from.username?.toLowerCase() === botUsername.toLowerCase();
  const command = /^\/(?:ai|помощник)(?:@(\w+))?(?:\s|$)/i.exec(raw);
  const commandForUs = command ? !command[1] || command[1].toLowerCase() === botUsername.toLowerCase() : false;
  const mentioned = new RegExp(mentionSource, "i").test(raw);
  const named = /^(?:шабнам|мушовир)(?=$|[\s,:;.!?—–-])/iu.exec(raw) ?? GREETED_BOT.exec(raw);
  const afterName = named ? raw.slice(named[0].length) : "";
  const namedAddress = Boolean(named && (!afterName.trim() || /^\s*[,:;.!?—–-]/u.test(afterName)
    || NAMED_REQUEST.test(afterName.trim()) || requestedGroupParticipation(afterName)));
  const groupQuestion = GROUP_NAMED_QUESTION.exec(raw);
  const addressed = mentioned || replyToBot || commandForUs || namedAddress || Boolean(groupQuestion);
  const addressEnd = groupQuestion ? groupQuestion.index + groupQuestion[0].length : named && namedAddress ? named[0].length : 0;
  let text = raw.slice(addressEnd).replace(new RegExp(mentionSource, "gi"), "$1 ");
  if (commandForUs) text = text.replace(/^\/(?:ai|помощник)(?:@\w+)?/i, "");
  if (addressEnd) text = text.replace(/^[\s,:;.!?—–-]*/u, "");
  return { addressed, text: text.replace(/\s+/g, " ").trim() };
}

/** Сколько после обращения бот читает следующие сообщения ТОГО ЖЕ человека без повторного упоминания. */
export const GROUP_DIALOG_WINDOW_MS = 8 * 60_000;
/** Столько подряд сообщений «не к боту» закрывают окно. */
const GROUP_WINDOW_MAX_JUNK = 3;
const WINDOW_STOP = /^(стоп|спасибо|отмена|хватит|stop)[\s.!]*$/i;
// A bounded follow-up: bare card/number, or an imperative AND a CRM subject.
// Isolated words like «клиент» and «поставь» otherwise pull ordinary chatter into AI.
export function looksLikeBotRequest(text: string): boolean {
  const request = text.trim().replace(/^(?:а\s+)?(?:теперь\s+)?(?:пожалуйста[, ]+)?/iu, "");
  if (/^(?:(?:об|ob|пк)[-\s]?)?\d{1,8}[.!?]?$/iu.test(request)) return true;
  return NAMED_REQUEST.test(request)
    && /(?:об|ob|пк)[-\s]?\d|объект|квартир|клиент|цен[уауы]|статус|перемонт|показ|карточк/iu.test(request);
}

let groupClock: () => number = () => Date.now();
/** Часы окна диалога подменяются только в тестах. */
export function setGroupClockForTests(clock: (() => number) | null): void {
  groupClock = clock ?? (() => Date.now());
}
/** The window is scoped to the group, topic and sender, and carries no message bodies. */
interface GroupDialogWindow {
  until: number;
  junk: number;
  registeredAt: number;
  directed: boolean;
  propertyRef?: string;
  messageId?: number;
}
const dialogWindows = new Map<string, GroupDialogWindow>();
function groupWindowKey(msg: TelegramIncomingMessage): string | null {
  if (!msg.from?.id || msg.from.is_bot || msg.sender_chat) return null;
  return `${msg.chat.id}:${msg.message_thread_id ?? 0}:${msg.from.id}`;
}

function currentWindow(key: string | null, messageId?: number): GroupDialogWindow | undefined {
  if (!key) return;
  const entry = dialogWindows.get(key);
  if (entry && entry.until <= groupClock()) {
    dialogWindows.delete(key);
    return;
  }
  if (entry?.messageId != null && messageId != null && messageId < entry.messageId) return;
  return entry;
}

/** Текст сообщения, если оно внутри открытого окна автора и похоже на просьбу; иначе null. */
function windowRequest(msg: TelegramIncomingMessage, key: string | null): string | null {
  const entry = currentWindow(key, msg.message_id);
  if (!key || !entry) return null;
  const raw = (msg.text ?? "").trim();
  if (!raw) return null;
  if (WINDOW_STOP.test(raw)) {
    dialogWindows.delete(key);
    return null;
  }
  if (!entry.directed) return null;
  if (!looksLikeBotRequest(raw)) {
    entry.junk += 1;
    if (entry.junk >= GROUP_WINDOW_MAX_JUNK) dialogWindows.delete(key);
    return null;
  }
  entry.junk = 0;
  return raw;
}

const GROUP_ADMIN_ROLES = new Set(["ADMIN", "DIRECTOR"]);

async function greetGroup(chatId: string, lines: { ru: string; tg: string }, replyTo?: number): Promise<void> {
  for (const language of ["ru", "tg"] as const) {
    await sendAssistantVoiceReply(chatId, lines[language], replyTo);
  }
}

async function senderOf(msg: TelegramIncomingMessage) {
  if (!msg.from?.id || msg.from.is_bot || msg.sender_chat) return null;
  return findAgentByTelegramUserId(String(msg.from.id));
}

function montageHasReason(command: NonNullable<ReturnType<typeof groupMontageCommand>>): boolean {
  return Boolean(command.tail.replace(/(?:ОБ|OB)[\s\-–—№#]+\d{1,8}/giu, "").trim().replace(/^[\s,.!?:—–-]+$/u, ""));
}

/** Idempotent, human answer from the current queue before the model asks to confirm. */
async function groupMontageReply(
  ref: string, actor: { id: string; mayDelete: boolean }, tajik: boolean, askReason: boolean,
): Promise<string | null> {
  const found = await findPropertiesByRef(ref, { hideOwnPendingDeleteFor: actor.mayDelete ? undefined : actor.id, limit: 1 });
  const property = found.kind === "shortId" ? found.properties[0] : undefined;
  if (!property) {
    // Номер удалённого объекта — справка «в Корзине», а не «не нашла» (пачка 2, lib/trashAccess.ts).
    const trash = { agentId: actor.id, can: (p: string) => p === "properties.delete" && actor.mayDelete, surface: "telegram-group" as const };
    const note = await trashedPropertyNoteFor(ref, trash, tajik ? "tg" : "ru");
    if (note) return note;
    return tajik ? `${ref}-ро дар CRM наёфтам.` : `Не нашла ${ref} в CRM.`;
  }
  if (property.videoHandoffStatus === "QUEUED") {
    const remake = Boolean(property.videoHandoffRemakeReason);
    return tajik ? `Навори ${ref} дар навбат аст${remake ? ". Аз нав месозанд" : ""}.`
      : `${ref} уже в очереди на ${remake ? "перемонтаж" : "монтаж"}.`;
  }
  if (property.videoHandoffStatus === "SENT_TO_EDITOR") {
    const delivered = Boolean(property.videoHandoffDeliveredAt && !property.videoHandoffManualSince);
    return tajik ? (delivered ? `Навори ${ref} назди монтажёр аст.` : `Ҳоло намедонам, ки навори ${ref} ба дасти монтажёр расид ё не.`)
      : (delivered ? `${ref} уже у монтажёра.` : `${ref}: доставка файлов монтажёру ещё не подтверждена.`);
  }
  if (askReason && (property.videoHandoffFinalPath || property.publishedChannels?.length)) {
    return GROUP_REMAKE_REASON_QUESTION[tajik ? "tg" : "ru"](ref);
  }
  return null;
}

/**
 * Сообщение из группы. true — разобрано здесь (бот сам и адресат); false — не про
 * помощника, дальше обычная логика групп (комментарии канала).
 */
export async function handleAssistantGroupMessage(msg: TelegramIncomingMessage, updateId?: number): Promise<boolean> {
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return false;
  const botUsername = await getBotUsername();
  if (!botUsername) return false;
  const chatId = String(msg.chat.id);
  const key = groupWindowKey(msg);
  let { addressed, text } = addressedToBot(msg, botUsername);
  let raw = (msg.text ?? "").trim();
  const isForwarded = Boolean(msg.forward_origin || msg.forward_from_message_id);
  const forwardedText = isForwarded ? (msg.text ?? msg.caption ?? "").trim() : "";
  const groupCommand = isForwarded ? null : new RegExp(`^/assistant_(on|off|quiet|resume)(?:@${escapeRe(botUsername)})?(?:\\s|$)`, "i").exec(raw);
  const verb = groupCommand?.[1].toLowerCase();
  const onOff = verb === "on" || verb === "off" ? groupCommand : null;
  const participation = verb === "quiet" || verb === "resume" ? verb
    : addressed && !isForwarded ? requestedGroupParticipation(text) : null;
  let windowText: string | null = null;
  const membership = groupMembershipEvent(msg.new_chat_members, msg.left_chat_member, botUsername);
  let automatic: ReturnType<typeof unaddressedPropertyQuestion> = null;
  let automaticRead = false;
  let automaticAction: GroupConfirmationTool | null = null;
  const quoted = (msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "").trim().slice(0, 600);
  let statusFollowUp = Boolean(quoted && groupStatusFollowUp(raw, quoted));
  const shortNativeVoice = typeof msg.voice?.duration === "number"
    && msg.voice.duration > 0 && msg.voice.duration <= GROUP_SHORT_VOICE_SECONDS;
  const audioDuration = (msg.voice ?? msg.audio)?.duration;
  const currentRequest = addressed ? text : raw;
  const moreProperties = key && !isForwarded ? propertyPageRequest(currentRequest) : null;
  const replied = msg.reply_to_message;
  const replyInThisConversation = replied?.from?.is_bot === true && replied.from.username?.toLowerCase() === botUsername.toLowerCase()
    && replied.chat.id === msg.chat.id && replied.message_thread_id === msg.message_thread_id;
  const ownBotQuestion = replyInThisConversation ? replied?.text : undefined;
  const typedAcknowledgment = key && !isForwarded && !msg.voice && !msg.audio && (!replied || replyInThisConversation)
    ? groupAcknowledgment(currentRequest) : null;
  const typedInstagram = key && !isForwarded && !msg.voice && !msg.audio
    ? groupInstagramLinkRequest(currentRequest, ownBotQuestion ?? "") : null;
  const publicShell = key && !isForwarded ? matchGroupPublicShellQuestion(currentRequest, addressed, ownBotQuestion) : null;
  const guestListing = key && !isForwarded ? unaddressedPropertyQuestion(currentRequest) : null;
  const historyQuestion = (words: string) => key && !isForwarded
    ? groupHistoryQuestion(words, msg.reply_to_message?.message_id) : null;
  let historySelector = historyQuestion(addressed ? text : raw);
  const entry = currentWindow(key, msg.message_id);
  const continuation = (words: string) => !isForwarded && !msg.reply_to_message
    && isShortPropertyFollowUp(words) ? entry?.propertyRef : undefined;
  let continuationRef = continuation(addressed ? text : raw);
  const standaloneVoice = !addressed && !groupCommand && !membership && !raw
    && typeof audioDuration === "number" && audioDuration > 0 && audioDuration <= GROUP_AUDIO_MAX_SECONDS
    && Boolean(msg.from?.id && !msg.from.is_bot && !msg.sender_chat);
  if (!addressed && !groupCommand && !membership) {
    if (!continuationRef && !isForwarded) windowText = windowRequest(msg, key);
    if (!continuationRef && windowText === null && key && !isForwarded) {
      automatic = unaddressedPropertyQuestion(raw);
      automaticRead = !automatic && (statusFollowUp || (!msg.reply_to_message && unaddressedReadRequest(raw)));
      if (!automatic && !automaticRead && !msg.reply_to_message) automaticAction = unaddressedConfirmationRequest(raw);
    }
    if (!historySelector && !continuationRef && windowText === null && !automatic && !automaticRead && !automaticAction && !standaloneVoice && !publicShell && !moreProperties && !typedAcknowledgment && !typedInstagram) return false;
  }
  const reply = async (message: string) => {
    if (msg.message_thread_id === undefined) await sendMessage(chatId, message, msg.message_id);
    else await sendMessage(chatId, message, msg.message_id, undefined, { messageThreadId: msg.message_thread_id });
  };

  /** Долгая часть хода — вне очереди группы, в очереди этого человека (см. runInAssistantLane). */
  const detach = (work: () => Promise<unknown>): true => {
    const person = msg.from?.id ?? msg.sender_chat?.id ?? "unknown";
    deferAssistantReply(msg, runInAssistantLane(`group:${chatId}:${person}`, work, async (err) => {
      await logSystemError("telegram", `Помощник в группе Telegram: ${describeError(err)}`);
      if (!automatic && !automaticRead && !automaticAction && !membership && (!historySelector || addressed)
          && (!standaloneVoice || addressed)) await reply("Не получилось ответить, попробуйте ещё раз.").catch(() => {});
    }));
    return true;
  };

  try {
    // Группа-обсуждение канала — клиентские комментарии, помощнику там не место.
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { telegramDiscussionGroupId: true },
    });
    if (settings?.telegramDiscussionGroupId === chatId) return false;

    if (membership === "bot-left") {
      await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
      return true;
    }
    const sender = membership === "people-joined" ? null : await senderOf(msg);
    if (onOff || membership === "bot-added") {
      if (!sender) {
        if (!onOff) return true;
        await reply(NOT_LINKED_TEXT);
        return true;
      }
      const access = await loadAgentAccess(sender.id);
      if (!access?.isActive || !GROUP_ADMIN_ROLES.has(access.role)) {
        if (onOff) await reply("Подключать группы может только директор или администратор.");
        return true;
      }
      if (verb !== "off") {
        if (!onOff && !(await isAiAssistantEnabled())) return true;
        const inserted = await prisma.assistantTelegramGroup.createMany({
          data: { chatId, registeredByAgentId: sender.id },
          skipDuplicates: true,
        });
        if (inserted.count === 1 && await isAiAssistantEnabled()) {
          // One atomic registration sends both short welcomes, without member names.
          await greetGroup(chatId, ASSISTANT_GROUP_GREETING, onOff ? msg.message_id : undefined);
        } else if (onOff) {
          await reply(await isAiAssistantEnabled()
            ? "Шабнам уже здесь. Позовите меня по имени, через /ai или ответом на моё сообщение. На ясный рабочий вопрос могу ответить сама."
            : "Группа подключена, но ИИ-помощник выключен в Настройках CRM.");
        }
      } else {
        await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
        await reply("Помощник в этой группе отключён.");
      }
      return true;
    }

    // Чужая группа, куда бота добавили случайно, молчит.
    const registered = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
    if (!registered) return false;
    const now = new Date(groupClock());
    const registeredAt = registered.createdAt.getTime();
    const validateQueueAudience = async () => {
      const [current, viewer] = await Promise.all([
        prisma.assistantTelegramGroup.findUnique({ where: { chatId } }),
        senderOf(msg),
      ]);
      if (!viewer || viewer.id !== sender?.id || !current || current.createdAt.getTime() !== registeredAt) return false;
      return addressed || !current.proactiveMutedUntil || current.proactiveMutedUntil.getTime() <= groupClock();
    };
    if (entry?.registeredAt !== registeredAt) continuationRef = undefined;
    const openWindow = (directed: boolean, propertyRef?: string) => {
      if (!key) return;
      const previous = currentWindow(key);
      if (previous?.registeredAt === registeredAt && previous.messageId != null
          && msg.message_id != null && msg.message_id < previous.messageId) return;
      dialogWindows.delete(key);
      dialogWindows.set(key, {
        until: groupClock() + GROUP_DIALOG_WINDOW_MS, junk: 0, registeredAt,
        directed: directed || (previous?.registeredAt === registeredAt && previous.directed),
        propertyRef, messageId: msg.message_id,
      });
      if (dialogWindows.size > 512) {
        const oldest = dialogWindows.keys().next().value;
        if (oldest) dialogWindows.delete(oldest);
      }
    };
    if (membership === "people-joined") {
      if (!(await isAiAssistantEnabled())) return true;
      const cooldown = new Date(now.getTime() - GROUP_WELCOME_INTERVAL_MS);
      const claim = await prisma.assistantTelegramGroup.updateMany({
        where: {
          chatId, createdAt: registered.createdAt,
          AND: [
            { OR: [{ proactiveMutedUntil: null }, { proactiveMutedUntil: { lte: now } }] },
            { OR: [{ lastJoinWelcomeAt: null }, { lastJoinWelcomeAt: { lte: cooldown } }] },
          ],
        },
        data: { lastJoinWelcomeAt: now },
      });
      if (claim.count === 1) await greetGroup(chatId, ASSISTANT_COLLEAGUE_GREETING);
      return true;
    }
    if (participation) {
      if (!sender || !(await loadAgentAccess(sender.id))?.isActive) return true;
      const update = await prisma.assistantTelegramGroup.updateMany({
        where: { chatId, createdAt: registered.createdAt },
        data: { proactiveMutedUntil: participation === "quiet" ? new Date(now.getTime() + GROUP_QUIET_MS) : null },
      });
      if (update.count === 1) {
        const lang = assistantLanguage([{ role: "user", content: text }]);
        await reply(participation === "quiet"
          ? lang === "tg" ? "Хуб. То ним соат танҳо вақте маро ҷеғ занед, ҷавоб медиҳам." : "Хорошо. Полчаса отвечаю только на прямые обращения."
          : lang === "tg" ? "Хуб, боз худам ба саволҳо ҷавоб медиҳам." : "Хорошо. Снова могу сама отвечать на ясные вопросы по объектам.");
      }
      return true;
    }

    if (!addressed && registered.proactiveMutedUntil && registered.proactiveMutedUntil > now) return false;
    const showWorking = () => void (msg.message_thread_id === undefined
      ? sendChatAction(chatId)
      : sendChatAction(chatId, undefined, "typing", msg.message_thread_id));
    const acknowledge = async (words: string, emoji = groupAcknowledgment(words)): Promise<boolean> => {
      if (!emoji || isForwarded || !key || !sender || msg.message_id === undefined
          || (replied && !replyInThisConversation)) return false;
      // Only opted-in staff rooms get ambient acknowledgments. Laughter needs a direct reply/address.
      const ambient = !addressed && !replyInThisConversation;
      if (ambient && (emoji !== "👍" || !registered.contextEnabledAt)) return false;
      const [enabled, access, current] = await Promise.all([
        isAiAssistantEnabled(), loadAgentAccess(sender.id), prisma.assistantTelegramGroup.findUnique({ where: { chatId } }),
      ]);
      if (!enabled || !access?.isActive || !current || current.createdAt.getTime() !== registeredAt
          || (ambient && (!current.contextEnabledAt || (current.proactiveMutedUntil?.getTime() ?? 0) > groupClock()))) return false;
      const delivery = await setMessageReaction(chatId, msg.message_id, emoji);
      if (delivery === "unavailable" && !ambient) {
        const lang = assistantLanguage([{ role: "user", content: words }]);
        const tajik = lang === "tg" || lang === "mixed"
          || /ра[ҳх]мат|ташаккур|\p{Script=Arabic}/iu.test(words);
        await reply(emoji === "😁" ? "😁" : tajik ? "Ҳар вақт 🙂" : "Обращайся 🙂");
      }
      return true;
    };
    if (typedAcknowledgment && await acknowledge(currentRequest, typedAcknowledgment)) return true;
    const replyWithInstagram = async (request: ReturnType<typeof groupInstagramLinkRequest>): Promise<boolean> => {
      if (!request || isForwarded || !sender || !(await isAiAssistantEnabled())) return false;
      const access = await loadAgentAccess(sender.id);
      if (!access?.isActive) return false;
      const { ref, tajik } = request;
      const found = await findPropertiesByRef(ref, {
        limit: 1, hideOwnPendingDeleteFor: access.permissions.has("properties.delete") ? undefined : sender.id,
      });
      if (!(await validateQueueAudience())) return false;
      const property = found.kind === "shortId" ? found.properties[0] : undefined;
      const url = assistantInstagramLink(property?.instagramUrl);
      // Номер удалённого объекта — справка «в Корзине», а не «не нашла» (пачка 2).
      const trashedNote = property ? null : await trashedPropertyNoteFor(
        ref, { agentId: sender.id, can: (p) => access.permissions.has(p), surface: "telegram-group" }, tajik ? "tg" : "ru");
      if (trashedNote) {
        await reply(trashedNote);
      } else if (!url) {
        await reply(!property
          ? tajik ? `${ref}-ро наёфтам.` : `Не нашла ${ref}.`
          : tajik ? `Дар корти ${ref} линки Instagram нест.` : `В карточке ${ref} нет ссылки на пост в Instagram.`);
      } else {
        const body = tajik ? `Навори ${ref} дар Instagram.` : `Ролик по ${ref} в Instagram.`;
        const buttons = [[{ text: tajik ? "Дар Instagram бинед" : "Смотреть в Instagram", url }]];
        if (msg.message_thread_id === undefined) await sendMessageWithButtons(chatId, body, buttons, msg.message_id);
        else await sendMessageWithButtons(chatId, body, buttons, msg.message_id, msg.message_thread_id);
      }
      return true;
    };
    if (typedInstagram && await replyWithInstagram(typedInstagram)) return true;
    const cardScope: CardScope | undefined = sender && registered.contextEnabledAt && msg.from?.id ? {
      chatId, agentId: sender.id, telegramUserId: String(msg.from.id), threadId: msg.message_thread_id,
      replyTo: msg.message_id,
      group: { registeredAt: registered.createdAt, contextEnabledAt: registered.contextEnabledAt, addressed },
    } : undefined;
    if (moreProperties && cardScope && await replyWithMoreProperties(cardScope, moreProperties, currentRequest, !addressed)) return true;
    // An unlinked user has no CRM actor. Serve only public listing data or approved sales guidance.
    const publicQuestion = publicShell && (publicShell.kind === "guidance" || !sender || publicShell.siteOnly)
      ? { kind: "shell" as const, request: publicShell }
      : !sender && guestListing ? { kind: "listing" as const, request: guestListing } : null;
    if (publicQuestion) {
      if (!(await isAiAssistantEnabled())) return false;
      if (sender && !(await loadAgentAccess(sender.id))?.isActive) return false;
      const cooldown = new Date(now.getTime() - PROACTIVE_GROUP_INTERVAL_MS);
      if (!addressed && registered.lastProactiveReplyAt && registered.lastProactiveReplyAt > cooldown) return false;
      const language = assistantLanguage([{ role: "user", content: currentRequest }]);
      const lang = language === "tg" || language === "mixed" ? "tg" : "ru";
      const answer = publicQuestion.kind === "listing"
        ? await replyPublicListingQuestion(publicQuestion.request.ref, publicQuestion.request.lang)
        : await replyGroupPublicShellQuestion(publicQuestion.request, lang);
      // Public lookup may outlive a disconnect or a quiet command. Recheck before delivery.
      const current = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
      if (!current || current.createdAt.getTime() !== registeredAt) return false;
      if (!addressed) {
        const claim = await prisma.assistantTelegramGroup.updateMany({
          where: {
            chatId, createdAt: registered.createdAt,
            AND: [
              { OR: [{ proactiveMutedUntil: null }, { proactiveMutedUntil: { lte: new Date(groupClock()) } }] },
              { OR: [{ lastProactiveReplyAt: null }, { lastProactiveReplyAt: { lte: cooldown } }] },
            ],
          },
          data: { lastProactiveReplyAt: now },
        });
        if (claim.count !== 1) return false;
      }
      if (publicQuestion.kind === "shell" && answer.includes("<a href=")) {
        if (msg.message_thread_id === undefined) await sendHtmlMessage(chatId, answer, msg.message_id);
        else await sendHtmlMessage(chatId, answer, msg.message_id, undefined, msg.message_thread_id);
      } else await reply(answer);
      return true;
    }
    const moneyWallet = createAssistantMoneyWallet();
    const transcribeGroupVoice = async (agentId: string, standalone = false) => {
      const result = await transcribeVoice(msg, agentId, moneyWallet, standalone);
      if ("text" in result && registered.contextEnabledAt && updateId !== undefined && !isForwarded) {
        await retainAssistantTelegramTranscript(msg, updateId, agentId, result.text).catch(() => {
          console.warn("[telegram:assistant] group audio evidence could not be saved");
        });
      }
      return result;
    };
    let fromVoice = false;
    if (standaloneVoice) {
      if (!sender) return false;
      const voice = await transcribeGroupVoice(sender.id, true);
      if ("error" in voice) return false;
      const current = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
      if (!current || current.createdAt.getTime() !== registered.createdAt.getTime()
        || (current.proactiveMutedUntil && current.proactiveMutedUntil.getTime() > groupClock())) return false;
      fromVoice = true;
      raw = voice.text.replace(/\s+/gu, " ").trim();
      if (audioDuration <= 12 && await acknowledge(raw)) return true;
      if (await replyWithInstagram(groupInstagramLinkRequest(raw, ownBotQuestion ?? ""))) return true;
      const spokenMore = !isForwarded && propertyPageRequest(raw);
      if (spokenMore && cardScope && await replyWithMoreProperties(cardScope, spokenMore, raw, true)) return true;
      historySelector = historyQuestion(raw);
      continuationRef = entry?.registeredAt === registeredAt ? continuation(raw) : undefined;
      statusFollowUp = Boolean(quoted && groupStatusFollowUp(raw, quoted));
      const spoken = addressedToBot({ ...msg, text: raw }, botUsername);
      if (!isForwarded && /^(?:шабнам|мушовир)(?=$|[\s,:;.!?—–-])/iu.test(raw)
        && spoken.addressed && spoken.text && !requestedGroupParticipation(spoken.text)) {
        addressed = true;
        text = spoken.text;
        historySelector = historyQuestion(text);
        continuationRef = entry?.registeredAt === registeredAt ? continuation(text) : undefined;
      } else if (continuationRef || historySelector) {
        text = raw;
      } else {
        automatic = unaddressedPropertyQuestion(raw);
        automaticRead = !automatic && (statusFollowUp || unaddressedReadRequest(raw));
        if (!automatic && !automaticRead && !isForwarded && !msg.reply_to_message) automaticAction = unaddressedConfirmationRequest(raw);
        if (!automatic && !automaticRead && !automaticAction) return false;
      }
    }
    if (automatic || automaticRead || automaticAction || historySelector) {
      if (!sender || !(await isAiAssistantEnabled())) return false;
      const access = await loadAgentAccess(sender.id);
      if (!access?.isActive) return false;
      const historyEnabledAt = registered.contextEnabledAt;
      const historyIncludesUnlinked = registered.contextIncludeUnlinked;
      if (historySelector && !historyEnabledAt && !addressed) return false;
      const cooldown = new Date(now.getTime() - PROACTIVE_GROUP_INTERVAL_MS);
      if (!addressed && registered.lastProactiveReplyAt && registered.lastProactiveReplyAt > cooldown) return false;
      const lookup = automatic ? await findPropertiesByRef(automatic.ref, {
        hideOwnPendingDeleteFor: access.permissions.has("properties.delete") ? undefined : sender.id,
        limit: 1,
      }) : null;
      const property = lookup?.kind === "shortId" ? lookup.properties[0] : undefined;
      if (automatic && !property) return false;
      const claim = addressed ? { count: 1 } : await prisma.assistantTelegramGroup.updateMany({
        where: {
          chatId, createdAt: registered.createdAt,
          AND: [
            { OR: [{ proactiveMutedUntil: null }, { proactiveMutedUntil: { lte: now } }] },
            { OR: [{ lastProactiveReplyAt: null }, { lastProactiveReplyAt: { lte: cooldown } }] },
          ],
        },
        data: { lastProactiveReplyAt: now },
      });
      if (claim.count !== 1) return false;
      if (automatic && property) {
        void logAssistantToolCall({ agentId: sender.id, tool: "telegram.proactive.property", argsSummary: JSON.stringify({ propertyId: property.id }), resultCount: 1 });
        await sendAssistantReply(chatId, proactivePropertyReply(property, automatic.lang), {
          scope: "group", mode: "text", structured: true, replyTo: msg.message_id,
          messageThreadId: msg.message_thread_id, written: [],
        });
        if (!isForwarded) openWindow(false, formatPropertyCode(property.shortId));
        return true;
      }
      if (automaticAction === "send_to_remake") {
        const cmd = groupMontageCommand(raw);
        const refs = groupPropertyRefs(raw);
        const tajik = cmd?.tajik ?? false;
        if (refs.length !== 1) {
          await reply(tajik ? "Кадом объект? Рақамашро навис." : "Какой объект? Напиши номер.");
          return true;
        }
        const answer = await groupMontageReply(refs[0], { id: sender.id, mayDelete: access.permissions.has("properties.delete") },
          tajik, Boolean(cmd && !montageHasReason(cmd)));
        if (answer) { await reply(answer); return true; }
      }

      const currentWords = addressed ? text : raw;
      const requestLanguage = assistantLanguage([{ role: "user", content: currentWords }]);
      let question = (fromVoice ? forwardedVoicePrompt(msg, currentWords) : null) ?? currentWords;
      if (statusFollowUp) question = `${question}\n${wrapUntrusted("document", quoted, 600)}`;
      if (historySelector && msg.from?.id) {
        const evidence = historyEnabledAt ? await loadAssistantTelegramContext({
          chatId, threadId: msg.message_thread_id ?? null, agentId: sender.id,
          telegramUserId: String(msg.from.id), beforeMessageId: msg.message_id, selector: historySelector,
        }) : [];
        if (!evidence.length) {
          const tg = requestLanguage === "tg" || requestLanguage === "mixed";
          await reply(historyEnabledAt
            ? tg ? "Дар гапҳои ҳамин ҷо чизе наёфтам." : "В сохранённых сообщениях этой темы ничего не нашла."
            : tg ? "Гапҳои ин гурӯҳро ҳоло нигоҳ намедорам." : "Память этой группы пока выключена.");
          return true;
        }
        const archived = evidence.map(({ occurredAt, authorLabel, text: excerpt }) => ({
          at: occurredAt.toISOString(), author: authorLabel, text: excerpt,
        }));
        question = `${currentWords}\n${wrapUntrusted("document", JSON.stringify(archived), 3000)}`;
      }
      // Окно диалога — сразу, до долгого хода: уточнение без @ во время хода не теряется (ревью 08.11).
      const earlyRefs = groupPropertyRefs(historySelector ? currentWords : statusFollowUp ? quoted : raw);
      if (!isForwarded) openWindow(false, earlyRefs.length === 1 ? earlyRefs[0] : undefined);
      return detach(async () => {
        showWorking();
        const result = await runTurn({
          showWorking,
          turnKey: `tg:${chatId}:${msg.message_id}`,
          agentId: sender.id, scope: "group", readOnlyGroup: Boolean(historySelector) || !automaticAction,
          validateQueueAudience, forwardedEvidence: isForwarded,
          allowPropertyCards: Boolean(cardScope && !historySelector && !statusFollowUp),
          onlyGroupConfirmation: historySelector ? undefined : automaticAction ?? undefined, moneyWallet,
          history: [{ role: "user", content: maskAssistantContacts(question) }],
          deny: async () => {},
        });
        if (!result || (result.failed && !automaticAction)) return true;
        const current = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
        if (!current || current.createdAt.getTime() !== registered.createdAt.getTime()
            || (!addressed && current.proactiveMutedUntil && current.proactiveMutedUntil.getTime() > groupClock())
            || (historySelector && (current.contextEnabledAt?.getTime() !== historyEnabledAt?.getTime()
              || current.contextIncludeUnlinked !== historyIncludesUnlinked))) {
          if (result.pending.length) await cancelPending(result.pending, sender.id);
          return true;
        }
        if (automaticAction && !historySelector) {
          await sendTurnResult(chatId, result, {
            agentId: sender.id, authorName: sender.fullName, scope: "group", mode: "text", replyTo: msg.message_id,
            messageThreadId: msg.message_thread_id, requestLanguage,
          });
          return true;
        }
        if (cardScope && await sendSelectedPropertyCards(cardScope, result, currentWords)) return true;
        await sendAssistantReply(chatId, splitReaction(result.reply).text, {
          scope: "group", mode: "text", structured: result.structured, replyTo: msg.message_id,
          messageThreadId: msg.message_thread_id, written: [], requestLanguage,
        });
        const refs = groupPropertyRefs(historySelector ? currentWords : statusFollowUp ? quoted : raw);
        if (!isForwarded) openWindow(false, refs.length === 1 ? refs[0] : undefined);
        return true;
      });
    }

    if (windowText !== null && key && dialogWindows.get(key)?.registeredAt !== registeredAt) {
      dialogWindows.delete(key);
      return false;
    }
    if (!addressed && !continuationRef && windowText === null) return false;

    if (!sender) {
      await reply(msg.sender_chat ? "Анонимного админа не узнаю — напишите от своего имени." : NOT_LINKED_TEXT);
      return true;
    }
    let request = windowText ?? text;
    // Упоминание ответом на ЧУЖОЕ сообщение: его текст — содержание просьбы, права — вызвавшего.
    const repliedToThisBot = replied?.from?.is_bot === true && replied.from.username?.toLowerCase() === botUsername.toLowerCase();
    let source: string | undefined;
    let forwardedEvidence = isForwarded;
    const hasAudio = Boolean(msg.voice || msg.audio);
    const quotedForwarded = Boolean(replied?.forward_origin || replied?.forward_from_message_id || replied?.is_automatic_forward);
    let evidenceAfterAudio = "";
    if (forwardedText) {
      if (hasAudio) evidenceAfterAudio = forwardedText;
      else request = forwardedTextPrompt(forwardedText);
    } else if (windowText === null && replied && (replied.from?.is_bot !== true || (quotedForwarded && !repliedToThisBot))) {
      const quoted = (replied.text ?? replied.caption ?? "").trim();
      if (!text && hasAudio && !fromVoice) {
        evidenceAfterAudio = quoted;
      } else if (quotedForwarded) {
        if (!text) forwardedEvidence = true;
        if (quoted) request = text ? `${text}\n${wrapUntrusted("document", quoted, 1000)}` : forwardedTextPrompt(quoted);
      } else if (quoted) {
        source = replied.from?.first_name ?? replied.from?.username ?? "участника группы";
        request = `Сообщение от ${source}: «${quoted.slice(0, 1000)}»${text ? `
Просьба вызвавшего: ${text}` : ""}`;
      }
    } else if (!repliedToThisBot && statusFollowUp && quoted) {
      request = `${request}\n${wrapUntrusted("document", quoted, 600)}`;
    }
    let audioWords: string | undefined;
    if (hasAudio && !fromVoice && (!request || isForwarded)) {
      if (addressed && !isForwarded) showWorking();
      const voice = await transcribeGroupVoice(sender.id);
      if ("error" in voice) {
        await reply(voice.error);
        return true;
      }
      audioWords = voice.text;
      if (await acknowledge(audioWords)) return true;
      if (await replyWithInstagram(groupInstagramLinkRequest(audioWords, ownBotQuestion ?? ""))) return true;
      request = forwardedVoicePrompt(msg, audioWords) ?? audioWords;
      if (evidenceAfterAudio) request += `\n${wrapUntrusted("document", evidenceAfterAudio, 1000)}`;
      fromVoice = true;
    }
    if (!request) {
      if (forwardedEvidence) return false;
      if (!(await isAiAssistantEnabled())) { await reply(DISABLED_TEXT); return true; }
      if (!(await loadAgentAccess(sender.id))?.isActive) { await reply("Ваша учётка отключена."); return true; }
      openWindow(true);
      await reply("Слушаю. Что нужно сделать?");
      return true;
    }
    // Deterministic intents only use the current message, before quoted context was added.
    const words = audioWords ?? windowText ?? text;
    const spokenMore = fromVoice && !forwardedEvidence && propertyPageRequest(words);
    if (spokenMore && cardScope && await replyWithMoreProperties(cardScope, spokenMore, words)) return true;
    const command = forwardedEvidence ? null : groupMontageCommand(words);
    const reasonReply = !forwardedEvidence && repliedToThisBot && isGroupRemakeReasonQuestion(quoted)
      && words.length <= 280 && !/^(?:спасибо|рахмат|раҳмат|стоп|отмена)[.!]?$/iu.test(words);
    const currentRefs = groupPropertyRefs(words);
    const refs = currentRefs.length ? currentRefs : repliedToThisBot ? groupPropertyRefs(quoted) : [];
    const language = assistantLanguage([{ role: "user", content: words }]);
    const tajik = command?.tajik || language === "tg" || language === "mixed"
      || (language === "unknown" && repliedToThisBot && assistantLanguage([{ role: "user", content: quoted }]) === "tg");
    if (continuationRef) {
      request = tajik ? `${words}\nРақами объект: ${continuationRef}.` : `${words}\nНомер объекта: ${continuationRef}.`;
    } else if (command || reasonReply) {
      const access = await loadAgentAccess(sender.id);
      if (!access?.isActive || !(await isAiAssistantEnabled())) return true;
      if (refs.length > 1 || (!refs.length && command && !command.tail)) {
        await reply(tajik ? "Кадом объект? Рақамашро навис." : "Какой объект? Напиши номер.");
        return true;
      }
      if (refs.length === 1) {
        const ref = refs[0];
        const answer = await groupMontageReply(ref, { id: sender.id, mayDelete: access.permissions.has("properties.delete") },
          tajik, Boolean(!reasonReply && command && !montageHasReason(command)));
        if (answer) { await reply(answer); return true; }
        if (reasonReply) {
          request = tajik ? `Навори ${ref}-ро ба монтажи дубора фирист. Чиро иваз кунем: ${words}`
            : `Верни ролик ${ref} на перемонтаж. Что поправить: ${words}`;
        } else if (!currentRefs.length) {
          request = tajik ? `${request}\nРақами объект: ${ref}.` : `${request}\nНомер объекта: ${ref}.`;
        }
      }
    } else if (!currentRefs.length && repliedToThisBot && (statusFollowUp || isGroupPropertyFollowUp(words))) {
      if (refs.length > 1) {
        await reply(tajik ? "Кадом объект? Рақамашро навис." : "Какой объект? Напиши номер.");
        return true;
      }
      if (refs.length === 1) request = tajik ? `${request}\nРақами объект: ${refs[0]}.` : `${request}\nНомер объекта: ${refs[0]}.`;
    }
    // Окно диалога — сразу, до долгого хода: «а за 600?» без @ во время хода попадёт в него и
    // встанет в очередь этого человека после первого хода (ревью 08.11).
    if (!forwardedEvidence) openWindow(addressed || windowText !== null, continuationRef ?? (refs.length === 1 ? refs[0] : undefined));
    return detach(async () => {
      const keepWorking = !fromVoice || !audioWords ? showWorking : undefined;
      keepWorking?.();
      // Окно диалога открывается (и продлевается) на обработанном обращении.
      const result = await runTurn({
        showWorking: keepWorking,
        agentId: sender.id,
        moneyWallet,
        scope: "group",
        allowPropertyCards: Boolean(cardScope && !continuationRef && !statusFollowUp),
        readOnlyGroup: Boolean(continuationRef),
        validateQueueAudience, forwardedEvidence,
        turnKey: `tg:${chatId}:${msg.message_id}`,
        history: [{ role: "user", content: request.slice(0, 4000) }],
        deny: reply,
      });
      if (!result) return true;
      if (continuationRef) {
        const current = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
        if (!current || current.createdAt.getTime() !== registeredAt
            || (!addressed && current.proactiveMutedUntil && current.proactiveMutedUntil.getTime() > groupClock())) return true;
      }
      if (!result.failed && !forwardedEvidence) openWindow(addressed || windowText !== null, continuationRef ?? (refs.length === 1 ? refs[0] : undefined));
      if (cardScope?.group && await sendSelectedPropertyCards({ ...cardScope,
        group: { ...cardScope.group, addressed } }, result, words)) return true;
      const preference = forwardedEvidence ? undefined : requestedAssistantReplyPreference(words);
      await sendTurnResult(chatId, result, {
        agentId: sender.id,
        authorName: sender.fullName,
        scope: "group",
        fromVoice,
        addressedGroupVoice: addressed && fromVoice && !forwardedEvidence && shortNativeVoice,
        mode: preference?.mode ?? "auto",
        voiceLanguage: preference?.voiceLanguage,
        reactTo: msg.message_id,
        replyTo: msg.message_id,
        messageThreadId: msg.message_thread_id,
        source,
        requestLanguage: language === "mixed" ? language : tajik ? "tg" : language,
      });
    });
  } catch (err) {
    await logSystemError("telegram", `Помощник в группе Telegram: ${describeError(err)}`);
    if (!automatic && !automaticRead && !automaticAction && !membership && (!historySelector || addressed)
        && (!standaloneVoice || addressed)) await reply("Не получилось ответить, попробуйте ещё раз.").catch(() => {});
  }
  return true;
}

// ───────────────────────────── кнопки ─────────────────────────────

/** Одна связка — одно исполнение за раз (двойное нажатие разными callback id). */
const bundleChains = new Map<string, Promise<unknown>>();
function serializeBundle<T>(bundleId: string, work: () => Promise<T>): Promise<T> {
  const prev = bundleChains.get(bundleId) ?? Promise.resolve();
  const run = prev.then(work, work);
  const tail = run.catch(() => undefined);
  bundleChains.set(bundleId, tail);
  void tail.then(() => {
    if (bundleChains.get(bundleId) === tail) bundleChains.delete(bundleId);
  });
  return run;
}

/** Кто нажал: по Telegram user id; в личке с ботом — ещё и по привязанному чату. */
async function clickerOf(query: TelegramCallbackQuery) {
  const chatId = query.message?.chat.id;
  if (query.from?.id) {
    const byUser = await findAgentByTelegramUserId(String(query.from.id));
    if (byUser) return byUser;
    // Привязка до П5 хранила только чат; в личке chat.id совпадает с user id.
    if (chatId !== undefined && chatId === query.from.id) return findAgentByTelegramChatId(String(chatId));
  }
  return null;
}

const FAIL_STATUS_NOTE: Record<string, string> = {
  STALE: "данные изменились, повторите просьбу",
  EXPIRED: "время на подтверждение вышло, попросите заново",
  FORBIDDEN: "недостаточно прав",
};

/** `as:ok|no:<связка>`. true — это наша кнопка (обработана или отклонена). */
export async function handleAssistantCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (query.data?.startsWith("ef:")) return handleTelegramExpenseReceiptCallback(query);
  if (query.data?.startsWith("ay:")) {
    if (!(await claimCallback(query.id))) { await answerCallbackQuery(query.id); return true; }
    const clicker = await clickerOf(query).catch(() => null);
    return handleExpenseFileQuestionCallback(query, clicker?.id ?? null);
  }
  if (query.data?.startsWith("ax:")) {
    if (!(await claimCallback(query.id))) { await answerCallbackQuery(query.id); return true; }
    const clicker = await clickerOf(query).catch(() => null);
    return handleExpenseCardCallback(query, clicker?.id ?? null);
  }
  if (await handleTelegramPropertyDraftCallback(query)) return true;
  if (!query.data?.startsWith("as:")) return false;
  const match = BUNDLE_CALLBACK.exec(query.data);
  if (!match) {
    await answerCallbackQuery(query.id);
    return true;
  }
  // Повторная доставка того же нажатия не выполняется заново.
  if (!(await claimCallback(query.id))) {
    await answerCallbackQuery(query.id);
    return true;
  }
  const [, verb, bundleId] = match;
  const chatId = query.message?.chat.id !== undefined ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;
  const tajikPrice = /^Нархи ОБ-/u.test(query.message?.caption ?? query.message?.text ?? "");
  try {
    const clicker = await clickerOf(query);
    if (!clicker) {
      await answerCallbackQuery(query.id, "Привяжите аккаунт в личке с ботом");
      return true;
    }
    const actions = await prisma.assistantAction.findMany({ where: { bundleId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (actions.length === 0) {
      await answerCallbackQuery(query.id, "Карточка устарела");
      return true;
    }
    // Только автор. Чужому ничего не исполняется и не отменяется.
    if (actions.some((a) => a.agentId !== clicker.id)) {
      await answerCallbackQuery(query.id, "Подтвердить может только автор просьбы");
      return true;
    }
    if (!(await isAiAssistantEnabled())) {
      await answerCallbackQuery(query.id, DISABLED_TEXT);
      return true;
    }
    const access = await loadAgentAccess(clicker.id);
    if (!access || !access.isActive || isReadOnlyRole(access.role)) {
      await answerCallbackQuery(query.id, "Нет прав на это действие");
      return true;
    }
    const callbackChat = query.message?.chat;
    const groupRegistrationAllows = async (): Promise<boolean> => {
      if (callbackChat?.type !== "group" && callbackChat?.type !== "supergroup") return true;
      // Re-read after waiting for the bundle lock: /assistant_off must also stop
      // old cards whose callbacks were queued behind an in-flight operation.
      // A DB failure reaches the existing catch before either broker operation.
      const registered = await prisma.assistantTelegramGroup.findUnique({
        where: { chatId: String(callbackChat.id) },
      });
      if (!registered) {
        await answerCallbackQuery(query.id, "Помощник в этой группе отключён");
        return false;
      }
      // Re-enabling creates a new registration. Old cards must not revive; equal
      // timestamps are rejected too, avoiding millisecond precision ambiguity.
      const stale = actions.filter((action) => action.createdAt.getTime() <= registered.createdAt.getTime());
      if (stale.length > 0) {
        // Preparing the same request can reuse an old PENDING row until expiry.
        // Do not promise an immediate retry or cancel a row shared with another UI.
        const pendingExpiry = Math.max(0, ...stale.filter((action) => action.status === "PENDING")
          .map((action) => action.expiresAt.getTime()));
        const waitMinutes = Math.ceil(Math.max(0, pendingExpiry - Date.now()) / 60_000);
        await answerCallbackQuery(query.id, waitMinutes > 0
          ? `Группа подключена заново — повторите просьбу через ${waitMinutes} мин.`
          : "Группа подключена заново — повторите просьбу");
        return false;
      }
      return true;
    };
    const actor = actionActorOf(clicker.id, access, callbackChat?.type === "private");

    if (verb === "no") {
      const executed = await serializeBundle(bundleId, async () => {
        if (!(await groupRegistrationAllows())) return null;
        for (const a of actions) await discardPendingAssistantAction(a.id, actor).catch(() => undefined);
        return prisma.assistantAction.count({ where: { bundleId, status: { in: ["EXECUTED", "CONFIRMED"] } } });
      });
      if (executed === null) return true;
      // Часть цепочки могла успеть исполниться до отмены — правду об этом не прячем.
      const note = executed > 0 ? "Часть действий уже была выполнена, остальные отменены" : "Отменено";
      await answerCallbackQuery(query.id, note);
      const isExpenseBatch = actions.length === 1 && actions[0]!.tool === ADD_EXPENSES_TOOL;
      const expenseNote = executed === 0 && isExpenseBatch ? await expenseBatchOutcomeText(actions, false).catch(() => null) : null;
      if (expenseNote && chatId && messageId) {
        await editMessageText(chatId, messageId, expenseNote, null).catch(() => {});
        return true;
      }
      if (chatId && query.message && messageId) {
        await editTelegramConfirmationMessage(query.message, sanitizeAssistantReply(tajikPrice && executed === 0 ? "Бекор шуд" : `✖ ${note} (${clicker.fullName})`, chatId.startsWith("-"))).catch(() => {});
      }
      return true;
    }

    const outcome = await serializeBundle(bundleId, async () => {
      if (!(await groupRegistrationAllows())) return null;
      return executeBundle(actions.map((a) => a.id), actor, tajikPrice);
    });
    if (outcome === null) return true;
    if (outcome.kind === "busy") {
      await answerCallbackQuery(query.id, "Уже выполняется");
      return true;
    }
    if (outcome.kind === "retry") {
      await answerCallbackQuery(query.id, outcome.message);
      return true;
    }
    if (outcome.kind === "replay") {
      await answerCallbackQuery(query.id, "Уже выполнено");
      return true;
    }
    await answerCallbackQuery(query.id, outcome.failed ? "Выполнено не всё" : "Готово");
    if (!chatId) return true;
    const expenseDone = !outcome.failed && actions.length === 1 && actions[0]!.tool === ADD_EXPENSES_TOOL
      ? await expenseBatchOutcomeText(actions, true).catch(() => null) : null;
    if (expenseDone) {
      if (messageId) await editMessageText(chatId, messageId, expenseDone, null).catch(() => sendMessage(chatId, expenseDone).catch(() => {}));
      else await sendMessage(chatId, expenseDone).catch(() => {});
      return true;
    }
    const isGroup = chatId.startsWith("-");
    const mark = outcome.failed ? "⚠️" : "✅";
    const summary = isGroup
      ? outcome.priceResult ?? (outcome.lines.length === 1
        ? `${mark} ${outcome.lines[0].replace(/^[•✖↺] /u, "")}`
        : `${outcome.failed ? "Не всё получилось" : "Готово"}:\n${outcome.lines.join("\n")}`)
      : `${mark} ${clicker.fullName}:\n${outcome.lines.join("\n")}`;
    const safeSummary = sanitizeAssistantReply(summary, isGroup);
    if (query.message && messageId) {
      await editTelegramConfirmationMessage(query.message, safeSummary).catch(async (err: unknown) => {
        if (isGroup && (!(err instanceof TelegramApiError) || err.errorCode !== 400 || /message is not modified/i.test(err.message))) return;
        // A definitive edit failure may use one standalone message. Never quote our own card.
        await sendMessage(chatId, safeSummary, undefined, undefined, { singleAttempt: true }).catch(() => {});
      });
    } else {
      await sendMessage(chatId, safeSummary).catch(() => {});
    }
    return true;
  } catch (err) {
    await logSystemError("telegram", `Кнопка помощника в Telegram: ${describeError(err)}`);
    await answerCallbackQuery(query.id, "Не получилось, попробуйте ещё раз").catch(() => {});
    return true;
  }
}

type BundleOutcome =
  | { kind: "busy" }
  | { kind: "retry"; message: string }
  | { kind: "replay" }
  | { kind: "done"; failed: boolean; lines: string[]; priceResult?: string };

export function renderGroupPriceResult(action: AssistantActionView, tajik = false): string | undefined {
  if (action.tool !== "change_property_price" || typeof action.preview.becomes.Цена !== "string"
    || !action.result || typeof action.result !== "object") return undefined;
  const result = action.result as { applied?: unknown; status?: unknown; propertyShortId?: unknown };
  const shortId = result.propertyShortId;
  if (typeof shortId !== "number" || !Number.isSafeInteger(shortId) || shortId < 1) return undefined;
  const price = field(action.preview.becomes.Цена).replace(/\s+с\.?$/u, tajik ? " сомонӣ" : " сомони");
  const code = formatPropertyCode(shortId);
  if (result.applied === true) return `${code} · ${tajik ? "нарх шуд" : "цена теперь"} ${price}`;
  if (result.status === "PENDING") return tajik ? `${code} · ${price}, ҳоло роҳбар бояд розӣ шавад` : `${code} · цена ${price} ждёт одобрения`;
  return undefined;
}

/**
 * Исполняет связку по порядку. На первой неудаче остальные ожидающие ОТМЕНЯЮТСЯ
 * (перемонтаж после неудавшейся цены не уходит). «Уже исполняется» (параллельный
 * запрос держит строку) — не неудача: ничего не отменяем и не повторяем.
 */
async function executeBundle(ids: string[], actor: AssistantActionActor, tajikPrice: boolean): Promise<BundleOutcome> {
  const lines: string[] = [];
  let ranAny = false;
  let failed = false;
  let priceResult: string | undefined;
  for (let i = 0; i < ids.length; i++) {
    try {
      const access = await loadAgentAccess(actor.agentId, prisma);
      if (!access?.isActive || isReadOnlyRole(access.role)) {
        throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на это действие");
      }
      const currentActor = actionActorOf(actor.agentId, access, actor.telegramPrivate === true);
      const { action, replay } = await confirmAssistantAction(ids[i], currentActor);
      if (!replay) ranAny = true;
      if (!replay && ids.length === 1) priceResult = renderGroupPriceResult(action, tajikPrice);
      lines.push(`${replay ? "↺" : "•"} ${action.preview.title}`);
    } catch (err) {
      if (err instanceof AssistantActionError && err.code === "IN_PROGRESS") return { kind: "busy" };
      if (err instanceof AssistantActionError && err.code === "CONFIRM_RETRY") return { kind: "retry", message: err.message };
      failed = true;
      const code = err instanceof AssistantActionError ? err.code : "";
      const reason = err instanceof AssistantActionError ? FAIL_STATUS_NOTE[code] ?? err.message : "не получилось выполнить";
      lines.push(`✖ ${reason}`);
      if (!(err instanceof AssistantActionError)) {
        await logSystemError("ai", `Помощник Telegram: действие ${ids[i]} упало: ${describeError(err)}`);
      }
      for (const rest of ids.slice(i + 1)) await discardPendingAssistantAction(rest, actor).catch(() => undefined);
      if (ids.length > 1) lines.push("Остальные действия отменены.");
      break;
    }
  }
  if (!ranAny && !failed) return { kind: "replay" };
  return { kind: "done", failed, lines, priceResult };
}
