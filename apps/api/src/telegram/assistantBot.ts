import { renderAssistantForTelegram, requestedAssistantReplyMode, sanitizeAssistantReply, splitReaction, type AssistantReplyMode } from "./assistantReply.js";
import { assistantGroupClarification, sendAssistantReply } from "./assistantDelivery.js";
import { editTelegramConfirmationMessage, sendTelegramPriceConfirmationPhotos } from "./assistantConfirmationPhotos.js";
import { ASSISTANT_COLLEAGUE_GREETING, ASSISTANT_GROUP_GREETING } from "./assistantGroupPhrases.js";
import { loadAssistantTelegramContext, retainAssistantTelegramTranscript } from "./assistantGroupContext.js";
import { findPropertiesByRef } from "../lib/propertyRefLookup.js";
import { GROUP_QUIET_MS, GROUP_REMAKE_REASON_QUESTION, GROUP_WELCOME_INTERVAL_MS, PROACTIVE_GROUP_INTERVAL_MS, groupHistoryQuestion, groupMembershipEvent, groupMontageCommand, groupPropertyRefs, groupStatusFollowUp, isGroupPropertyFollowUp, isGroupRemakeReasonQuestion, isShortPropertyFollowUp, proactivePropertyReply, requestedGroupParticipation, unaddressedConfirmationRequest, unaddressedPropertyQuestion, unaddressedReadRequest, type GroupConfirmationTool } from "./assistantGroupParticipation.js";
export { renderAssistantForTelegram } from "./assistantReply.js";
import { randomUUID } from "node:crypto";
import { formatPropertyCode, isReadOnlyRole, trimAssistantHistory, type AssistantPropertyCard, type PermissionId } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadAgentAccess, type AgentAccess } from "../auth/middleware.js";
import { actorFromAccess, type AssistantActor } from "../ai/assistant/actor.js";
import { ASSISTANT_ERROR_MESSAGES, isAiAssistantEnabled, runAssistantDetailed } from "../ai/assistant.js";
import { assistantLanguage } from "../ai/assistant/languageRouting.js";
import { wrapUntrusted } from "../ai/untrustedContent.js";
import { listAssistantToolPlugins } from "../ai/assistant/tools/index.js";
import { parseFastPathIntent, tryAssistantFastPath } from "../ai/assistantFastPath.js";
import { findTelegramAgentClients, isVoiceReplayRequest, replayTelegramAssistantVoice, sendTelegramPropertyCard, sendTelegramPropertyPreviews } from "./assistantReadResults.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import { handleTelegramPropertyDraft, handleTelegramPropertyDraftCallback } from "./assistantPropertyDraft.js";
import { handleAssistantMedia } from "./assistantMedia.js";
import { createAssistantMoneyWallet, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import {
  AssistantActionError,
  cancelAssistantAction,
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
import { logAssistantToolCall } from "../lib/aiAssistantAudit.js";
import {
  answerCallbackQuery as answerCallbackQueryRaw,
  getBotUsername,
  sendChatAction,
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
]);

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
function actionActorOf(agentId: string, access: AgentAccess): AssistantActionActor {
  return { agentId, channel: "telegram", can: (permission) => access.permissions.has(permission) };
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
export function renderBundleCard(actions: readonly AssistantActionView[], authorName: string, maskPhones = false, source?: string, tajik = false): string {
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
      `   Было: ${lines(p.was)}`,
      `   Станет: ${lines(p.becomes)}`,
      p.risk ? `   ${p.irreversible ? "⚠️ " : ""}${field(p.risk)}` : p.irreversible ? "   ⚠️ Необратимо" : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const origin = source ? `По сообщению ${source}
` : "";
  if (maskPhones && actions.length === 1 && actions[0]?.tool === "change_property_price") {
    return sanitizeAssistantReply(parts[0] ?? "", true);
  }
  const card = `${origin}Подтвердите действие${actions.length > 1 ? "я" : ""}:\n\n${parts.join("\n\n")}\n\nПодтвердить может только ${authorName}.`;
  return sanitizeAssistantReply(card, maskPhones);
}

// ───────────────────────────── ход помощника ─────────────────────────────

interface TurnResult {
  reply: string;
  propertyCard?: AssistantPropertyCard;
  failed?: true;
  structured?: boolean;
  propertyResults?: boolean;
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
  agentId: string;
  scope: "private" | "group";
  history: { role: "user" | "assistant"; content: string }[];
  /** Для сообщения-отказа до запуска модели. */
  deny: (text: string) => Promise<void>;
}

/** Общий ход: рубильник → права → потолок → быстрый путь → ядро. null — отказ уже отправлен. */
async function runTurn(params: TurnParams): Promise<TurnResult | null> {
  if (!(await isAiAssistantEnabled())) {
    await params.deny(DISABLED_TEXT);
    return null;
  }
  const access = await loadAgentAccess(params.agentId);
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
  if (params.readOnlyGroup || params.onlyGroupConfirmation) {
    actor.hiddenTools = new Set([...GROUP_HIDDEN_TOOLS, "get_client_history", "get_client_card", "web_reference"]);
  }
  if (params.onlyGroupConfirmation) {
    actor.hiddenTools = new Set([...(actor.hiddenTools ?? []), ...listAssistantToolPlugins()
      .filter(plugin => plugin.level !== "A" && (plugin.level !== "C" || plugin.name !== params.onlyGroupConfirmation))
      .map(plugin => plugin.name)]);
  }
  const last = params.history[params.history.length - 1];

  // In a group the deterministic path is limited to a property number.
  if (!params.readOnlyGroup && !params.onlyGroupConfirmation && last?.role === "user" && (params.scope === "private" || parseFastPathIntent(last.content)?.kind === "property-code")) {
    try {
      if (params.scope === "private") {
        const roster = await findTelegramAgentClients(last.content, actor);
        if (roster !== null) {
          void logAssistantToolCall({ agentId: actor.id, tool: "find_clients", argsSummary: "{}", resultCount: null });
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
        });
        const first = fast.cards[0];
        return {
          reply: fast.reply, pending: [], done: [], structured: true,
          propertyResults: fast.cards.some(card => card.kind === "property"),
          ...(fast.cards.length === 1 && first?.kind === "property" ? { propertyCard: first } : {}),
        };
      }
    } catch (err) {
      console.error("[telegram:assistant:fast-path]", describeError(err));
    }
  }

  const seen = new Map<string, AssistantActionView>();
  let structured = Boolean(params.forwardedEvidence);
  let propertyResults = false;
  const readOnly = Boolean(params.forwardedEvidence || params.readOnlyGroup);
  const outcome = await runAssistantDetailed(params.history, actor, {
    channel: "telegram",
    moneyWallet: params.moneyWallet,
    confirmUi: !readOnly,
    readOnly,
    onConfirm: (action) => seen.set(action.id, action),
    onToolResult: name => {
      structured = true;
      if (name === "search_properties" || name === "find_property" || name === "get_property_card") propertyResults = true;
    },
  });
  const all = [...seen.values()];
  const pending = all.filter((a) => a.status === "PENDING");
  const done = all.filter((a) => a.status === "EXECUTED");
  if (!outcome.ok) {
    return { reply: ASSISTANT_ERROR_MESSAGES[outcome.code], pending, done, failed: true };
  }
  return { reply: outcome.reply, pending, done, structured, propertyResults };
}

const TEXT_MAX_CHARS = 3900;
const CARD_MAX_CHARS = 3300;

/** Гасит ожидающие действия, которые так и не получили карточки (повтор поможет — они уйдут чистыми). */
async function cancelPending(actions: readonly AssistantActionView[], agentId: string): Promise<void> {
  const actor: AssistantActionActor = { agentId, channel: "telegram", can: () => false };
  for (const a of actions) await cancelAssistantAction(a.id, actor).catch(() => undefined);
}

/** Привязывает ожидающие действия к одной связке и отправляет единую карточку с кнопками. */
async function sendTurnResult(
  chatId: string,
  result: TurnResult,
  ctx: { agentId: string; authorName: string; scope: "private" | "group"; replyTo?: number; source?: string; fromVoice?: boolean; addressedGroupVoice?: boolean; mode?: AssistantReplyMode; reactTo?: number; requestLanguage?: ReturnType<typeof assistantLanguage> }
): Promise<void> {
  const maskPhones = ctx.scope === "group";
  const split = splitReaction(result.reply);
  if (split.reaction && ctx.reactTo) await setMessageReaction(chatId, ctx.reactTo, split.reaction);
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
    const delivered = await sendAssistantReply(chatId, split.text, {
      scope: ctx.scope, fromVoice: ctx.fromVoice, structured: result.structured,
      addressedGroupVoice: ctx.addressedGroupVoice,
      requestLanguage: ctx.requestLanguage,
      mode: result.failed ? "text" : ctx.mode, replyTo: ctx.replyTo, written,
    });
    if (delivered && ctx.scope === "private" && result.propertyResults) {
      await sendTelegramPropertyPreviews(chatId, split.text, ctx.replyTo);
    }
    return;
  }
  const priceOnlyInGroup = maskPhones && result.pending.every(action => action.tool === "change_property_price");
  const tajikPrice = priceOnlyInGroup && (ctx.requestLanguage === "tg" || ctx.requestLanguage === "mixed");
  const card = renderBundleCard(result.pending, ctx.authorName, maskPhones, ctx.source, tajikPrice);
  const body = [priceOnlyInGroup ? "" : rendered, ...written].filter(Boolean).join("\n");
  // Кнопка без полностью видимой карточки — подтверждение вслепую: слишком длинное не показываем.
  if (card.length > CARD_MAX_CHARS) {
    await cancelPending(result.pending, ctx.agentId);
    await sendMessage(chatId, "Слишком длинная карточка подтверждения — разбейте просьбу на части.", ctx.replyTo);
    return;
  }
  const bundleId = randomUUID();
  const bound = await prisma.assistantAction.updateMany({
    where: { id: { in: result.pending.map((a) => a.id) }, agentId: ctx.agentId, status: "PENDING" },
    data: { bundleId },
  });
  // Привязалась только часть — карточка показала бы то, что не исполнится: ничего не оставляем.
  if (bound.count !== result.pending.length) {
    await cancelPending(result.pending, ctx.agentId);
    await sendMessage(chatId, "Не получилось подготовить карточку, повторите просьбу.", ctx.replyTo);
    return;
  }
  const irreversible = result.pending.some((a) => a.preview.irreversible);
  // Карточка целиком, ответ модели — по остатку места (не наоборот).
  const room = Math.max(0, TEXT_MAX_CHARS - card.length - 2);
  const text = [body.slice(0, room), card].filter(Boolean).join("\n\n");
  const buttons = [[
    { text: tajikPrice ? "Ҳа" : irreversible ? "✅ Подтвердить (необратимо)" : maskPhones ? "Подтвердить" : "✅ Подтвердить", callback_data: `as:ok:${bundleId}` },
    { text: tajikPrice ? "Бекор" : maskPhones ? "Отмена" : "✖ Отмена", callback_data: `as:no:${bundleId}` },
  ]];
  if (priceOnlyInGroup && result.pending.length === 1
      && await sendTelegramPriceConfirmationPhotos(chatId, result.pending[0], text, buttons, ctx.replyTo)) return;
  await sendMessageWithButtons(chatId, text, buttons, ctx.replyTo);
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
  if (!text?.trim() || media.extraction?.incomplete) return { error: "Не удалось полностью распознать речь — напишите просьбу текстом." };
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
export async function handleAssistantPrivate(
  msg: TelegramIncomingMessage,
  agent: { id: string; fullName: string }
): Promise<void> {
  const chatId = String(msg.chat.id);
  const send = (text: string) => sendMessage(chatId, text).then(() => undefined);
  try {
    const videoDocument = msg.document && (msg.document.mime_type?.startsWith("video/")
      || /\.(?:mov|mp4|m4v|mkv|avi|webm)$/iu.test(msg.document.file_name ?? "")) ? msg.document : undefined;
    const video = msg.video ?? msg.video_note ?? videoDocument;
    if (!IS_LOCAL_BOT_API && video?.file_size && video.file_size > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) {
      await send("Это видео больше 20 МБ — в текущем подключении к Telegram я не могу его скачать. Загрузите ролик через CRM-панель объекта. Файл ещё не сохранён в CRM.");
      return;
    }
    const forwardedPlain = Boolean(msg.text?.trim() && (msg.forward_origin || msg.forward_from_message_id));
    if (!forwardedPlain && await handleTelegramPropertyDraft(msg, agent, transcribeVoice)) return;
    const moneyWallet = createAssistantMoneyWallet();
    let text = (msg.text ?? msg.caption ?? "").trim();
    const fromVoice = Boolean(msg.voice || msg.audio);
    let forwardedEvidence = forwardedPlain;
    if (!forwardedPlain && (text === "/new" || text === "/reset")) {
      await clearHistory(chatId);
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
    const previous = await loadHistory(chatId, agent.id);
    if (!forwardedEvidence && isVoiceReplayRequest(text)) {
      if (!(await isAiAssistantEnabled())) { await send(DISABLED_TEXT); return; }
      if (!(await loadAgentAccess(agent.id))?.isActive) { await send("Ваша учётка отключена."); return; }
      const lastReply = previous.slice().reverse().find(message => message.role === "assistant")?.content;
      if (!lastReply) { await send("В этом разговоре пока нет ответа для озвучки."); return; }
      if (!(await replayTelegramAssistantVoice(chatId, lastReply, msg.message_id))) {
        await send("Не получилось озвучить ответ целиком. Текст выше в чате.");
      }
      return;
    }
    const followup = /^а[ \t]+(?:№[ \t]*)?(\d{1,9})[?!.]*$/iu.exec(text);
    const previousQuestion = previous.slice().reverse().find(message => message.role === "user");
    if (followup && previousQuestion && parseFastPathIntent(previousQuestion.content)?.kind === "property-code") {
      text = `объект ${followup[1]}`;
    }
    if (!fromVoice) void sendChatAction(chatId);
    const history = [...previous, { role: "user" as const, content: text.slice(0, 4000) }];
    const result = await runTurn({ agentId: agent.id, scope: "private", history, deny: send, moneyWallet, forwardedEvidence });
    if (!result) return;
    await sendTurnResult(chatId, result, { agentId: agent.id, authorName: agent.fullName, scope: "private", fromVoice,
      mode: forwardedEvidence ? "auto" : requestedAssistantReplyMode(text), reactTo: msg.message_id,
    });
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
  const named = /^(?:шабнам|мушовир)(?=$|[\s,:;.!?—–-])/iu.exec(raw);
  const afterName = named ? raw.slice(named[0].length) : "";
  const namedAddress = Boolean(named && (!afterName.trim() || /^\s*[,:;.!?—–-]/u.test(afterName)
    || NAMED_REQUEST.test(afterName.trim()) || requestedGroupParticipation(afterName)));
  const addressed = mentioned || replyToBot || commandForUs || namedAddress;
  let text = raw.replace(new RegExp(mentionSource, "gi"), "$1 ");
  if (commandForUs) text = text.replace(/^\/(?:ai|помощник)(?:@\w+)?/i, "");
  if (named && namedAddress) text = text.slice(named[0].length).replace(/^[\s,:;.!?—–-]*/u, "");
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

function currentWindow(key: string | null): GroupDialogWindow | undefined {
  if (!key) return;
  const entry = dialogWindows.get(key);
  if (entry && entry.until <= groupClock()) {
    dialogWindows.delete(key);
    return;
  }
  return entry;
}

/** Текст сообщения, если оно внутри открытого окна автора и похоже на просьбу; иначе null. */
function windowRequest(msg: TelegramIncomingMessage, key: string | null): string | null {
  const entry = currentWindow(key);
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
  if (!property) return tajik ? `${ref}-ро дар CRM наёфтам.` : `Не нашла ${ref} в CRM.`;
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
  const forwardedPlain = isForwarded && Boolean(raw);
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
  const historyQuestion = (words: string) => key && !isForwarded
    ? groupHistoryQuestion(words, msg.reply_to_message?.message_id) : null;
  let historySelector = historyQuestion(addressed ? text : raw);
  const entry = currentWindow(key);
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
    if (!historySelector && !continuationRef && windowText === null && !automatic && !automaticRead && !automaticAction && !standaloneVoice) return false;
  }
  const reply = (t: string) => sendMessage(chatId, t, msg.message_id).then(() => undefined);

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
          scope: "group", mode: "text", structured: true, replyTo: msg.message_id, written: [],
        });
        openWindow(false, formatPropertyCode(property.shortId));
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
      let question = statusFollowUp ? `${currentWords}\n${wrapUntrusted("document", quoted, 600)}` : currentWords;
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
        const archived = evidence.map(({ occurredAt, text: excerpt }) => ({ at: occurredAt.toISOString(), text: excerpt }));
        question = `${currentWords}\n${wrapUntrusted("document", JSON.stringify(archived), 3000)}`;
      }
      const result = await runTurn({
        agentId: sender.id, scope: "group", readOnlyGroup: Boolean(historySelector) || !automaticAction,
        onlyGroupConfirmation: historySelector ? undefined : automaticAction ?? undefined, moneyWallet,
        history: [{ role: "user", content: maskAssistantContacts(question) }],
        deny: async () => {},
      });
      if (!result || (result.failed && !automaticAction)) return true;
      const current = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
      if (!current || current.createdAt.getTime() !== registered.createdAt.getTime()
          || (!addressed && current.proactiveMutedUntil && current.proactiveMutedUntil.getTime() > groupClock())
          || (historySelector && current.contextEnabledAt?.getTime() !== historyEnabledAt?.getTime())) {
        if (result.pending.length) await cancelPending(result.pending, sender.id);
        return true;
      }
      if (automaticAction && !historySelector) {
        await sendTurnResult(chatId, result, {
          agentId: sender.id, authorName: sender.fullName, scope: "group", mode: "text", replyTo: msg.message_id,
          requestLanguage,
        });
        return true;
      }
      await sendAssistantReply(chatId, splitReaction(result.reply).text, {
        scope: "group", mode: "text", structured: result.structured, replyTo: msg.message_id, written: [],
        requestLanguage,
      });
      const refs = groupPropertyRefs(historySelector ? currentWords : statusFollowUp ? quoted : raw);
      openWindow(false, refs.length === 1 ? refs[0] : undefined);
      return true;
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
    const replied = msg.reply_to_message;
    const repliedToThisBot = replied?.from?.is_bot === true && replied.from.username?.toLowerCase() === botUsername.toLowerCase();
    let source: string | undefined;
    if (forwardedPlain) {
      request = forwardedTextPrompt(raw);
    } else if (windowText === null && replied && replied.from?.is_bot !== true) {
      const quoted = (replied.text ?? replied.caption ?? "").trim();
      if (quoted) {
        source = replied.from?.first_name ?? replied.from?.username ?? "участника группы";
        request = `Сообщение от ${source}: «${quoted.slice(0, 1000)}»${text ? `
Просьба вызвавшего: ${text}` : ""}`;
      }
    } else if (!repliedToThisBot && statusFollowUp && quoted) {
      request = `${request}\n${wrapUntrusted("document", quoted, 600)}`;
    }
    let forwardedEvidence = forwardedPlain;
    if (!request && (msg.voice || msg.audio)) {
      const voice = await transcribeGroupVoice(sender.id);
      if ("error" in voice) {
        await reply(voice.error);
        return true;
      }
      const forwarded = forwardedVoicePrompt(msg, voice.text);
      forwardedEvidence = forwarded !== null;
      request = forwarded ?? voice.text;
      fromVoice = true;
    }
    if (!request) {
      if (!(await isAiAssistantEnabled())) { await reply(DISABLED_TEXT); return true; }
      if (!(await loadAgentAccess(sender.id))?.isActive) { await reply("Ваша учётка отключена."); return true; }
      openWindow(true);
      await reply("Слушаю. Что нужно сделать?");
      return true;
    }
    const words = fromVoice ? request : windowText ?? text;
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
    if (!fromVoice) void sendChatAction(chatId);
    // Окно диалога открывается (и продлевается) на обработанном обращении.
    const result = await runTurn({
      agentId: sender.id,
      moneyWallet,
      scope: "group",
      readOnlyGroup: Boolean(continuationRef),
      forwardedEvidence,
      history: [{ role: "user", content: request.slice(0, 4000) }],
      deny: reply,
    });
    if (!result) return true;
    if (continuationRef) {
      const current = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
      if (!current || current.createdAt.getTime() !== registeredAt
          || (!addressed && current.proactiveMutedUntil && current.proactiveMutedUntil.getTime() > groupClock())) return true;
    }
    if (!result.failed && !forwardedPlain) openWindow(addressed || windowText !== null, continuationRef ?? (refs.length === 1 ? refs[0] : undefined));
    await sendTurnResult(chatId, result, {
      agentId: sender.id,
      authorName: sender.fullName,
      scope: "group",
      fromVoice,
      addressedGroupVoice: addressed && fromVoice && !forwardedEvidence && shortNativeVoice,
      mode: forwardedEvidence ? "auto" : requestedAssistantReplyMode(fromVoice ? request : windowText ?? text),
      reactTo: msg.message_id,
      replyTo: msg.message_id,
      source,
      requestLanguage: tajik ? "tg" : language,
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
    const actions = await prisma.assistantAction.findMany({ where: { bundleId }, orderBy: { createdAt: "asc" } });
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
    const actor = actionActorOf(clicker.id, access);

    if (verb === "no") {
      const executed = await serializeBundle(bundleId, async () => {
        if (!(await groupRegistrationAllows())) return null;
        for (const a of actions) await cancelAssistantAction(a.id, actor).catch(() => undefined);
        return prisma.assistantAction.count({ where: { bundleId, status: { in: ["EXECUTED", "CONFIRMED"] } } });
      });
      if (executed === null) return true;
      // Часть цепочки могла успеть исполниться до отмены — правду об этом не прячем.
      const note = executed > 0 ? "Часть действий уже была выполнена, остальные отменены" : "Отменено";
      await answerCallbackQuery(query.id, note);
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
    if (outcome.kind === "replay") {
      await answerCallbackQuery(query.id, "Уже выполнено");
      return true;
    }
    await answerCallbackQuery(query.id, outcome.failed ? "Выполнено не всё" : "Готово");
    if (!chatId) return true;
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
      const { action, replay } = await confirmAssistantAction(ids[i], actor);
      if (!replay) ranAny = true;
      if (!replay && ids.length === 1) priceResult = renderGroupPriceResult(action, tajikPrice);
      lines.push(`${replay ? "↺" : "•"} ${action.preview.title}`);
    } catch (err) {
      if (err instanceof AssistantActionError && err.code === "IN_PROGRESS") return { kind: "busy" };
      failed = true;
      const code = err instanceof AssistantActionError ? err.code : "";
      const reason = err instanceof AssistantActionError ? FAIL_STATUS_NOTE[code] ?? err.message : "не получилось выполнить";
      lines.push(`✖ ${reason}`);
      if (!(err instanceof AssistantActionError)) {
        await logSystemError("ai", `Помощник Telegram: действие ${ids[i]} упало: ${describeError(err)}`);
      }
      for (const rest of ids.slice(i + 1)) await cancelAssistantAction(rest, actor).catch(() => undefined);
      if (ids.length > 1) lines.push("Остальные действия отменены.");
      break;
    }
  }
  if (!ranAny && !failed) return { kind: "replay" };
  return { kind: "done", failed, lines, priceResult };
}
