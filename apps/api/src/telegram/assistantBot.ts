import { randomUUID } from "node:crypto";
import { isReadOnlyRole, trimAssistantHistory, type PermissionId } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadAgentAccess, type AgentAccess } from "../auth/middleware.js";
import { actorFromAccess, type AssistantActor } from "../ai/assistant/actor.js";
import { ASSISTANT_ERROR_MESSAGES, isAiAssistantEnabled, runAssistantDetailed } from "../ai/assistant.js";
import { tryAssistantFastPath } from "../ai/assistantFastPath.js";
import { transcribeAudio } from "../ai/transcribe.js";
import {
  AssistantActionError,
  cancelAssistantAction,
  confirmAssistantAction,
  type AssistantActionActor,
  type AssistantActionView,
} from "../lib/assistantActions.js";
import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import { maskPhonesInFreeText } from "../lib/clientPhone.js";
import { findAgentByTelegramChatId, findAgentByTelegramUserId } from "../lib/telegramAgentLink.js";
import { claimCallback } from "../lib/telegramModeration.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { logAssistantToolCall } from "../lib/aiAssistantAudit.js";
import {
  answerCallbackQuery as answerCallbackQueryRaw,
  editMessageText,
  getBotUsername,
  sendChatAction,
  sendMessage,
  sendMessageWithButtons,
  setMessageReaction,
  type TelegramCallbackQuery,
  type TelegramIncomingMessage,
} from "./api.js";
import { fetchTelegramAttachments } from "./attachments.js";

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
const GROUP_HIDDEN_PERMISSIONS: readonly PermissionId[] = ["clients.viewPhone", "finance.view", "reports.view"];

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
  if (scope === "private") return actorFromAccess(agentId, access);
  const permissions = new Set(access.permissions);
  for (const hidden of GROUP_HIDDEN_PERMISSIONS) permissions.delete(hidden);
  return { ...actorFromAccess(agentId, { role: access.role, permissions }), hiddenTools: GROUP_HIDDEN_TOOLS };
}

/** Актор брокера на нажатии: ПОЛНЫЕ свежие права нажавшего, канал telegram. */
function actionActorOf(agentId: string, access: AgentAccess): AssistantActionActor {
  return { agentId, channel: "telegram", can: (permission) => access.permissions.has(permission) };
}

// ───────────────────────────── рендер ─────────────────────────────

function publicBase(): string | null {
  const raw = process.env.CRM_PUBLIC_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

const MD_LINK = /\[([^\]\n]+)\]\((\/[^)\s]*)\)/g;

/**
 * Ответ помощника (markdown со ссылками вида `[Имя](/clients/ID)`) → простой текст
 * для Telegram. Относительные ссылки в Telegram не работают — делаем абсолютными
 * (CRM_PUBLIC_URL); адреса не маскируются, а вот телефоны и @ники в тексте — да,
 * когда `maskPhones`: сначала прячем ссылки, потом маскируем остальное.
 */
export function renderAssistantForTelegram(text: string, opts: { maskPhones: boolean }): string {
  const base = publicBase();
  const links: string[] = [];
  let out = text.replace(MD_LINK, (_m, label: string, path: string) => {
    const shown = opts.maskPhones ? maskPhonesInFreeText(label) : label;
    links.push(base ? `${shown} — ${base}${path}` : shown);
    return `\u0000${links.length - 1}\u0000`;
  });
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  if (opts.maskPhones) out = maskPhonesInFreeText(out);
  // eslint-disable-next-line no-control-regex
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? "");
}

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
export function renderBundleCard(actions: readonly AssistantActionView[], authorName: string, maskPhones = false, source?: string): string {
  const parts = actions.map((a, i) => {
    const p = a.preview;
    const head = actions.length > 1 ? `${i + 1}) ${p.title}` : p.title;
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
  const card = `${origin}Подтвердите действие${actions.length > 1 ? "я" : ""}:\n\n${parts.join("\n\n")}\n\nПодтвердить может только ${authorName}.`;
  return maskPhones ? maskPhonesInFreeText(card) : card;
}

// ───────────────────────────── ход помощника ─────────────────────────────

interface TurnResult {
  reply: string;
  /** Карточки, ждущие «Подтвердить» (уровень C). */
  pending: AssistantActionView[];
  /** Уже выполненные записи уровня B (заметки, задачи). */
  done: AssistantActionView[];
}

interface TurnParams {
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
  const last = params.history[params.history.length - 1];

  // Полоса А (0 моделей) — только в личке: быстрый путь ищет по номеру телефона.
  if (params.scope === "private" && last?.role === "user") {
    try {
      const fast = await tryAssistantFastPath(last.content, actor);
      if (fast) {
        void logAssistantToolCall({
          agentId: actor.id,
          tool: fast.tool,
          argsSummary: fast.argsSummary,
          resultCount: fast.cards.length,
        });
        return { reply: fast.reply, pending: [], done: [] };
      }
    } catch (err) {
      console.error("[telegram:assistant:fast-path]", describeError(err));
    }
  }

  const seen = new Map<string, AssistantActionView>();
  const outcome = await runAssistantDetailed(params.history, actor, {
    channel: "telegram",
    confirmUi: true,
    onConfirm: (action) => seen.set(action.id, action),
  });
  const all = [...seen.values()];
  const pending = all.filter((a) => a.status === "PENDING");
  const done = all.filter((a) => a.status === "EXECUTED");
  if (!outcome.ok) {
    return { reply: ASSISTANT_ERROR_MESSAGES[outcome.code], pending, done };
  }
  return { reply: outcome.reply, pending, done };
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
  ctx: { agentId: string; authorName: string; scope: "private" | "group"; replyTo?: number; source?: string }
): Promise<void> {
  const maskPhones = ctx.scope === "group";
  const rendered = renderAssistantForTelegram(result.reply, { maskPhones });
  // Записи уровня B исполнены сразу — человек должен видеть, что именно записано.
  const written = result.done.map((a) => `Записано: ${field(a.preview.title)}`);
  const body = [rendered, ...written].filter(Boolean).join("\n");
  if (result.pending.length === 0) {
    await sendMessage(chatId, body || "Готово.", ctx.replyTo);
    return;
  }
  const card = renderBundleCard(result.pending, ctx.authorName, maskPhones, ctx.source);
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
  await sendMessageWithButtons(
    chatId,
    text,
    [
      [
        { text: irreversible ? "✅ Подтвердить (необратимо)" : "✅ Подтвердить", callback_data: `as:ok:${bundleId}` },
        { text: "✖ Отмена", callback_data: `as:no:${bundleId}` },
      ],
    ],
    ctx.replyTo
  );
}

// ───────────────────────────── личка ─────────────────────────────

const HELP_TEXT =
  "Я помощник CRM. Напишите или надиктуйте просьбу: «найди клиента …», «покажи ОБ-123», «снизь цену ОБ-123 до 90000». " +
  "Всё, что меняет данные, я показываю карточкой «было → станет» и жду вашего «Подтвердить». /new — начать разговор заново.";

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
async function transcribeVoice(msg: TelegramIncomingMessage, agentId: string): Promise<{ text: string } | { error: string }> {
  // Платная расшифровка — только если помощник вообще включён и учётка жива.
  if (!(await isAiAssistantEnabled())) return { error: DISABLED_TEXT };
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive) return { error: "Ваша учётка отключена." };
  const cap = await claimAgentAiAction(agentId, "assistant-telegram-voice", ASSISTANT_TG_VOICE_DAILY_LIMIT);
  if (!cap.allowed) return { error: "Лимит голосовых на сегодня исчерпан — напишите текстом." };
  const fetched = await fetchTelegramAttachments(msg);
  const audio = fetched.audios[0];
  if (!audio) return { error: "Не получилось скачать голосовое — попробуйте ещё раз или напишите текстом." };
  const text = await transcribeAudio(audio.buffer, audio.filename || "voice.ogg", audio.mediaType);
  if (text === null) return { error: "Не удалось распознать речь — напишите текстом." };
  if (!text.trim()) return { error: "Речь не распознана — похоже, запись пустая." };
  return { text: text.trim() };
}

/** Личный чат сотрудника, не монтажёра: всё, что он пишет, — просьба помощнику. */
export async function handleAssistantPrivate(
  msg: TelegramIncomingMessage,
  agent: { id: string; fullName: string }
): Promise<void> {
  const chatId = String(msg.chat.id);
  const send = (text: string) => sendMessage(chatId, text).then(() => undefined);
  try {
    let text = msg.text?.trim() ?? "";
    if (text === "/new" || text === "/reset") {
      await clearHistory(chatId);
      await send("Начали заново.");
      return;
    }
    if (text.startsWith("/")) {
      await send(HELP_TEXT);
      return;
    }
    if (msg.voice || msg.audio) {
      void sendChatAction(chatId).catch(() => {});
      const voice = await transcribeVoice(msg, agent.id);
      if ("error" in voice) {
        await send(voice.error);
        return;
      }
      text = voice.text;
      await send(`🎤 «${text.slice(0, 300)}»`);
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
    void sendChatAction(chatId).catch(() => {});
    const history = [...(await loadHistory(chatId, agent.id)), { role: "user" as const, content: text.slice(0, 4000) }];
    const result = await runTurn({ agentId: agent.id, scope: "private", history, deny: send });
    if (!result) return;
    await sendTurnResult(chatId, result, { agentId: agent.id, authorName: agent.fullName, scope: "private" });
    await saveHistory(chatId, agent.id, [...history, { role: "assistant", content: result.reply.slice(0, 4000) }]);
  } catch (err) {
    await logSystemError("telegram", `Помощник в личке Telegram: ${describeError(err)}`);
    await send("Не получилось ответить, попробуйте ещё раз.").catch(() => {});
  }
}

// ───────────────────────────── группа ─────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Позвали ли бота: @упоминание, команда /ai, ответ на его сообщение. */
export function addressedToBot(msg: TelegramIncomingMessage, botUsername: string): { addressed: boolean; text: string } {
  const raw = (msg.text ?? msg.caption ?? "").trim();
  const mentionSource = `(^|[^\\w])@${escapeRe(botUsername)}(?![\\w])`;
  const replyToBot =
    msg.reply_to_message?.from?.is_bot === true &&
    msg.reply_to_message.from.username?.toLowerCase() === botUsername.toLowerCase();
  const command = /^\/(?:ai|помощник)(?:@(\w+))?(?:\s|$)/i.exec(raw);
  const commandForUs = command ? !command[1] || command[1].toLowerCase() === botUsername.toLowerCase() : false;
  const mentioned = new RegExp(mentionSource, "i").test(raw);
  const addressed = mentioned || replyToBot || commandForUs;
  let text = raw.replace(new RegExp(mentionSource, "gi"), "$1 ");
  if (commandForUs) text = text.replace(/^\/(?:ai|помощник)(?:@\w+)?/i, "");
  return { addressed, text: text.replace(/\s+/g, " ").trim() };
}

/** Сколько после обращения бот читает следующие сообщения ТОГО ЖЕ человека без повторного упоминания. */
export const GROUP_DIALOG_WINDOW_MS = 8 * 60_000;
/** Столько подряд сообщений «не к боту» закрывают окно. */
const GROUP_WINDOW_MAX_JUNK = 3;
const WINDOW_STOP = /^(стоп|спасибо|отмена|хватит|stop)[\s.!]*$/i;
// Грубый предфильтр «похоже на просьбу к боту» — до модели: болтовню не читаем и не тратим вызов.
const REQUEST_HINTS =
  /(об|ob)[-\s]?\d|пк[-\s]?\d|\d{4,}|снизи|сними|подними|измени|поменя|продан|перемонт|найди|покажи|отправь|верни|удали|поставь|добавь|запиши|цен[уа]|статус|клиент|показ/i;

export function looksLikeBotRequest(text: string): boolean {
  return REQUEST_HINTS.test(text);
}

let groupClock: () => number = () => Date.now();
/** Часы окна диалога подменяются только в тестах. */
export function setGroupClockForTests(clock: (() => number) | null): void {
  groupClock = clock ?? (() => Date.now());
}
/** Окна раздельные: ключ — чат и человек; чужие сообщения внутри окна другого не читаются. */
const dialogWindows = new Map<string, { until: number; junk: number }>();
const windowKey = (chatId: string, userId: number | string) => `${chatId}:${userId}`;

/** Текст сообщения, если оно внутри открытого окна автора и похоже на просьбу; иначе null. */
function windowRequest(msg: TelegramIncomingMessage, chatId: string): string | null {
  if (!msg.from?.id || msg.from.is_bot || msg.sender_chat) return null;
  const key = windowKey(chatId, msg.from.id);
  const entry = dialogWindows.get(key);
  if (!entry) return null;
  if (entry.until <= groupClock()) {
    dialogWindows.delete(key);
    return null;
  }
  const raw = (msg.text ?? "").trim();
  if (!raw) return null;
  if (WINDOW_STOP.test(raw)) {
    dialogWindows.delete(key);
    return null;
  }
  if (!looksLikeBotRequest(raw)) {
    entry.junk += 1;
    if (entry.junk >= GROUP_WINDOW_MAX_JUNK) dialogWindows.delete(key);
    return null;
  }
  entry.junk = 0;
  return raw;
}

const GROUP_ADMIN_ROLES = new Set(["ADMIN", "DIRECTOR"]);

async function senderOf(msg: TelegramIncomingMessage) {
  if (!msg.from?.id || msg.from.is_bot || msg.sender_chat) return null;
  return findAgentByTelegramUserId(String(msg.from.id));
}

/**
 * Сообщение из группы. true — разобрано здесь (бот сам и адресат); false — не про
 * помощника, дальше обычная логика групп (комментарии канала).
 */
export async function handleAssistantGroupMessage(msg: TelegramIncomingMessage): Promise<boolean> {
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return false;
  const botUsername = await getBotUsername();
  if (!botUsername) return false;
  const chatId = String(msg.chat.id);
  const { addressed, text } = addressedToBot(msg, botUsername);
  const raw = (msg.text ?? "").trim();
  const onOff = new RegExp(`^/assistant_(on|off)(?:@${escapeRe(botUsername)})?(?:\\s|$)`, "i").exec(raw);
  let windowText: string | null = null;
  if (!addressed && !onOff) {
    windowText = windowRequest(msg, chatId);
    if (windowText === null) return false;
  }
  const reply = (t: string) => sendMessage(chatId, t, msg.message_id).then(() => undefined);

  try {
    // Группа-обсуждение канала — клиентские комментарии, помощнику там не место.
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { telegramDiscussionGroupId: true },
    });
    if (settings?.telegramDiscussionGroupId === chatId) return false;

    const sender = await senderOf(msg);

    if (onOff) {
      if (!sender) {
        await reply(NOT_LINKED_TEXT);
        return true;
      }
      const access = await loadAgentAccess(sender.id);
      if (!access?.isActive || !GROUP_ADMIN_ROLES.has(access.role)) {
        await reply("Подключать группы может только директор или администратор.");
        return true;
      }
      if (onOff[1].toLowerCase() === "on") {
        await prisma.assistantTelegramGroup.upsert({
          where: { chatId },
          create: { chatId, registeredByAgentId: sender.id },
          update: {},
        });
        await reply("Помощник подключён. Позовите меня: @упоминание, /ai или ответом на моё сообщение.");
      } else {
        await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
        await reply("Помощник в этой группе отключён.");
      }
      return true;
    }

    // Чужая группа, куда бота добавили случайно, молчит.
    const registered = await prisma.assistantTelegramGroup.findUnique({ where: { chatId } });
    if (!registered) return false;

    if (!sender) {
      await reply(msg.sender_chat ? "Анонимного админа не узнаю — напишите от своего имени." : NOT_LINKED_TEXT);
      return true;
    }
    // Голос в группе принимается только ответом боту (иначе упоминания нет).
    let request = windowText ?? text;
    // Упоминание ответом на ЧУЖОЕ сообщение: его текст — содержание просьбы, права — вызвавшего.
    const replied = msg.reply_to_message;
    let source: string | undefined;
    if (windowText === null && replied && replied.from?.is_bot !== true) {
      const quoted = (replied.text ?? replied.caption ?? "").trim();
      if (quoted) {
        source = replied.from?.first_name ?? replied.from?.username ?? "участника группы";
        request = `Сообщение от ${source}: «${quoted.slice(0, 1000)}»${text ? `
Просьба вызвавшего: ${text}` : ""}`;
      }
    }
    if (!request && (msg.voice || msg.audio)) {
      void sendChatAction(chatId).catch(() => {});
      const voice = await transcribeVoice(msg, sender.id);
      if ("error" in voice) {
        await reply(voice.error);
        return true;
      }
      request = voice.text;
    }
    if (!request) {
      await reply("Слушаю. Напишите просьбу после упоминания.");
      return true;
    }
    void sendChatAction(chatId).catch(() => {});
    // Окно диалога открывается (и продлевается) на обработанном обращении.
    if (msg.from?.id) dialogWindows.set(windowKey(chatId, msg.from.id), { until: groupClock() + GROUP_DIALOG_WINDOW_MS, junk: 0 });
    const result = await runTurn({
      agentId: sender.id,
      scope: "group",
      history: [{ role: "user", content: request.slice(0, 4000) }],
      deny: reply,
    });
    if (!result) return true;
    await sendTurnResult(chatId, result, {
      agentId: sender.id,
      authorName: sender.fullName,
      scope: "group",
      replyTo: msg.message_id,
      source,
    });
  } catch (err) {
    await logSystemError("telegram", `Помощник в группе Telegram: ${describeError(err)}`);
    await reply("Не получилось ответить, попробуйте ещё раз.").catch(() => {});
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
    const actor = actionActorOf(clicker.id, access);

    if (verb === "no") {
      const executed = await serializeBundle(bundleId, async () => {
        for (const a of actions) await cancelAssistantAction(a.id, actor).catch(() => undefined);
        return prisma.assistantAction.count({ where: { bundleId, status: { in: ["EXECUTED", "CONFIRMED"] } } });
      });
      // Часть цепочки могла успеть исполниться до отмены — правду об этом не прячем.
      const note = executed > 0 ? "Часть действий уже была выполнена, остальные отменены" : "Отменено";
      await answerCallbackQuery(query.id, note);
      if (chatId && messageId) {
        await editMessageText(chatId, messageId, `✖ ${note} (${clicker.fullName})`, null).catch(() => {});
      }
      return true;
    }

    const outcome = await serializeBundle(bundleId, () => executeBundle(actions.map((a) => a.id), actor));
    if (outcome.kind === "busy") {
      await answerCallbackQuery(query.id, "Уже выполняется");
      return true;
    }
    if (outcome.kind === "replay") {
      await answerCallbackQuery(query.id, "Уже выполнено");
      return true;
    }
    await answerCallbackQuery(query.id, outcome.failed ? "Выполнено не всё" : "Готово");
    const mark = outcome.failed ? "⚠️" : "✅";
    const summary = `${mark} ${clicker.fullName}:\n${outcome.lines.join("\n")}`;
    if (!chatId) return true;
    if (chatId.startsWith("-")) {
      // Группа: карточку гасим, итог — отдельным коротким сообщением, чтобы его увидели все.
      if (messageId) await editMessageText(chatId, messageId, `${mark} Обработано (${clicker.fullName})`, null).catch(() => {});
      await sendMessage(chatId, summary, messageId).catch(() => {});
    } else if (messageId) {
      await editMessageText(chatId, messageId, summary, null).catch(async () => {
        await sendMessage(chatId, summary).catch(() => {});
      });
    } else {
      await sendMessage(chatId, summary).catch(() => {});
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
  | { kind: "done"; failed: boolean; lines: string[] };

/**
 * Исполняет связку по порядку. На первой неудаче остальные ожидающие ОТМЕНЯЮТСЯ
 * (перемонтаж после неудавшейся цены не уходит). «Уже исполняется» (параллельный
 * запрос держит строку) — не неудача: ничего не отменяем и не повторяем.
 */
async function executeBundle(ids: string[], actor: AssistantActionActor): Promise<BundleOutcome> {
  const lines: string[] = [];
  let ranAny = false;
  let failed = false;
  for (let i = 0; i < ids.length; i++) {
    try {
      const { action, replay } = await confirmAssistantAction(ids[i], actor);
      if (!replay) ranAny = true;
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
  return { kind: "done", failed, lines };
}
