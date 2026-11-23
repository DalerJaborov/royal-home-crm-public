import { assistantInstagramLink, dropVoiceAvailabilityClaims, renderAssistantForTelegram, requestedAssistantReplyMode, requestedAssistantReplyPreference, sanitizeAssistantReply, splitReaction, splitVoiceMarker,
  type AssistantReplyMode, type AssistantSpeechLanguage } from "./assistantReply.js";
import { assistantGroupClarification, sendAssistantReply } from "./assistantDelivery.js";
import { editTelegramConfirmationMessage, sendTelegramPriceConfirmationPhotos } from "./assistantConfirmationPhotos.js";
import { ASSISTANT_COLLEAGUE_GREETING, ASSISTANT_GROUP_GREETING } from "./assistantGroupPhrases.js";
import { matchGroupPublicShellQuestion, replyGroupPublicShellQuestion, replyPublicListingQuestion } from "./assistantGroupPublicListing.js";
import { loadAssistantTelegramContext, retainAssistantTelegramTranscript } from "./assistantGroupContext.js";
import { findPropertiesByRef } from "../lib/propertyRefLookup.js";
import { trashedPropertyNoteFor } from "../ai/assistant/tools/propertyPresenter.js";
import { GROUP_QUIET_MS, GROUP_REMAKE_REASON_QUESTION, GROUP_WELCOME_INTERVAL_MS, PROACTIVE_GROUP_INTERVAL_MS, groupAcknowledgment, groupHistoryQuestion, groupInstagramLinkRequest, groupMembershipEvent, groupMigrationEvent, groupMontageCommand, groupPropertyRefs, groupStatusFollowUp, isGroupPropertyFollowUp, isGroupRemakeReasonQuestion, isShortPropertyFollowUp, proactivePropertyReply, requestedGroupParticipation, unaddressedConfirmationRequest, unaddressedPropertyQuestion, unaddressedReadRequest, type GroupConfirmationTool } from "./assistantGroupParticipation.js";
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
import { attachedFileHiddenTools, attachedRequest } from "./assistantAttachedRequest.js";
import { listAssistantToolPlugins } from "../ai/assistant/tools/index.js";
import { getPropertyWorkList } from "../ai/assistant/tools/getPropertyWorkStatus.js";
import { parseFastPathIntent, tryAssistantFastPath } from "../ai/assistantFastPath.js";
import { findTelegramAgentClients, replayTelegramAssistantVoice, sendTelegramPropertyCard } from "./assistantReadResults.js";
import { clearAssistantDialog, lastUserTurnMessageId, mergeAssistantDialog, patchLiveAssistantDialog, userTurnRecord } from "./assistantDialogState.js";
import { deleteSentAsk, deleteSentReply, deleteSentScope, isDeleteSentRequest, isVoiceReplayRequest } from "./assistantChatCommands.js";
import { deletableSentMessages, forgetSentMessages, mergeSentEntries } from "./sentMessageLog.js";
import { clearStaffPropertyPage, propertyPageRequest, propertyPageSize, propertySelection, propertyWorkflowRequest, sendMoreStaffProperties, sendStaffPropertySelection } from "./assistantPropertyPages.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import { handleTelegramPropertyDraft, handleTelegramPropertyDraftCallback, isPropertyDraftStartText } from "./assistantPropertyDraft.js";
import { handlePropertyOfferCallback } from "./assistantPropertyOffers.js";
import { handleNarrationCallback, handleNarrationTextReply } from "./assistantNarration.js";
import { handleNarrationPreviewCallback } from "./narrationPreviewBot.js";
import { handleFreeNarrationCallback, handleFreeNarrationMessage, looksLikeNarrationDictation, narrationDictationReply } from "./assistantFreeNarration.js";
import { handleStaffClipCallback, handleStaffClipMessage, handleStaffClipText } from "./staffClip.js";
import { handleStaffSocialCallback, handleStaffSocialPhoto, handleStaffSocialText, type DeferWork } from "./staffSocialPost.js";
import { handleExpenseFileQuestionCallback, handleTelegramExpenseReceipt, handleTelegramExpenseReceiptCallback } from "./assistantExpenseReceipt.js";
import { ADD_EXPENSES_TOOL } from "../ai/assistant/tools/expenseBatchTool.js";
import { applyExpenseFixMessage, expenseBatchOutcomeText, handleExpenseCardCallback, isExpiredExpenseBatch, sendExpenseBatchCard, showExpiredExpenseCard } from "./assistantExpenseCard.js";
import { handleExpenseFollowupText, handleExpenseTextMessage, rememberExpensePhoto } from "./assistantExpenseFollowup.js";
import { handleAssistantMedia } from "./assistantMedia.js";
import { createAssistantMoneyWallet, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import {
  AssistantActionError,
  discardPendingAssistantAction,
  confirmAssistantAction,
  undoAssistantAction,
  type AssistantActionActor,
  type AssistantActionView,
} from "../lib/assistantActions.js";
import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import { maskAssistantContacts } from "../lib/assistantContacts.js";
import { findAgentByTelegramChatId, findAgentByTelegramUserId } from "../lib/telegramAgentLink.js";
import { claimCallback } from "../lib/telegramModeration.js";
import { handlePaymentReminderCallback } from "../lib/paymentReminders.js";
import { handleNoticePreferenceText, handleStaffNoticeCallback } from "./staffNotice.js";
import { handleTrashRestoreCallback } from "./trashRestoreNotice.js";
import { handleShowingQuestionCallback, showingQuestionContext } from "./showingQuestionNotice.js";
import { migrateAssistantGroupChat } from "../lib/assistantGroupMigration.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { trackBackgroundTask } from "../lib/shutdownState.js";
import { logAssistantFastPathTurn, logAssistantToolCall, logAssistantTurn } from "../lib/aiAssistantAudit.js";
import {
  bundleNeedsStepUp,
  bundleNeedsStepUpByIds,
  cancelStepUpForBundle,
  findPendingStepUp,
  parseStepUpCode,
  rememberStepUpPrompt,
  startStepUpChallenge,
  stepUpText,
  verifyStepUpCode,
  type PendingStepUp,
  type StepUpKind,
  type StepUpLanguage,
} from "./assistantStepUp.js";
import { STAFF_TOOL_NAMES } from "../ai/assistant/tools/staffToolNames.js";
import {
  answerCallbackQuery as answerCallbackQueryRaw,
  deletePrivateMessage,
  getBotUsername,
  editMessageText, sendChatAction, sendHtmlMessage,
  sendMessage,
  removeKeyboard,
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

const BUNDLE_CALLBACK = /^as:(ok|no|undo):([0-9a-f-]{36})$/;

/**
 * Кнопка «↩️ Отменить» после исполнения (10.11.2026) — только в личке и только для
 * раздела «Команда» и передачи клиента: там откат есть в брокере (права, роль,
 * пауза, заморозка, передача дел). Остальные карточки Telegram ведут себя как раньше.
 */
const UNDO_IN_TELEGRAM: ReadonlySet<string> = new Set<string>([...STAFF_TOOL_NAMES, "change_client_agent"]);
const undoButtons = (bundleId: string) => [[{ text: "↩️ Отменить", callback_data: `as:undo:${bundleId}` }]];


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
  // «Сделки» Шабнам (10.11.2026): деньги и доли — только в личке. Сами инструменты
  // тоже не объявляются вне лички (dealToolsAllowed), это вторая стена.
  "get_deal_card",
  "get_my_commission",
  "get_payouts_due",
  "get_company_stats",
  "get_finance_summary",
  "get_lead_sources",
  // «Мозг компании» (17.11.2026, tools/brainReadTools.ts): сводки по компании, людям,
  // звонкам и сбоям — только в личке, как get_company_stats. Список буквами; сверку с
  // реестром держит tests/ai-assistant-brain-read-tools.test.ts.
  "get_day_snapshot",
  "get_unworked",
  "get_my_day",
  "get_missed_calls",
  "get_team_load",
  "get_stuck_work",
  // Реестр строек (21.11.2026, tools/registryReadTool.ts): только сотрудникам и только в личке.
  "get_construction_registry",
  // Разбор клиентской базы (17.11.2026, tools/clientBaseOverviewTool.ts): числа по агентам — только личка.
  "get_client_base_overview",
  // Сообщение коллеге от имени просящего (17.11.2026, tools/sendStaffMessageTool.ts): текст и получатель — только личка.
  "send_staff_message",
  "get_client_last_call",
  "create_task",
  "reschedule_task",
  "add_client_note",
  // Выход объекта из монтажа в продажу, «Готово» (17.11.2026): публикует на сайт и уведомляет агента — только в личке.
  "complete_property_editing",
  // Смена статуса объекта (17.11.2026): теперь меняется сразу (снять с продажи, продано) и закрывает показы и посты — только в личке.
  "change_property_status",
  // Озвучка объекта словами (18.11.2026, tools/narrationTools.ts): текст озвучки, файлы и одобрение (ролик уходит в соцсети) — только в личке.
  // Список буквами (не импортом): сверку с реестром держит tests/assistant-narration-tools.test.ts.
  "narration_status", "send_narration_audio", "request_narration", "approve_narration",
  // Удаление клиента (15.11.2026): карточка клиента и подтверждение — только в личке.
  "delete_client",
  // Возврат клиента из Корзины (17.11.2026): та же карточка клиента — только личка.
  "restore_client",
  // Сотрудники и права — только личка (владелец 10.11.2026): в группе ни читать, ни менять.
  ...STAFF_TOOL_NAMES,
  // Личная настройка уведомлений (14.11.2026): только в личке; в группе — вторая стена к allowed().
  "set_notification_pref",
  // Рынок под запрос клиента (14.11.2026): бюджет и пожелания клиента только в личке; цена объекта против рынка в группе допустима.
  "market_for_client",
  // Деньги в общей группе не показываются и не меняются (10.11.2026): все инструменты расходов.
  // Список буквами (не импортом): сверку с реестром держит тест assistant-expense-batch.
  "list_expenses", "get_expense_summary", "get_expense_forecast", "get_expense_pivot", "list_recurring_expenses",
  "list_expense_archive", "list_expense_categories", "add_expenses", "update_expense", "delete_expense", "restore_expense",
  "pay_expense", "undo_expense_payment", "create_recurring_expense", "update_recurring_expense", "delete_recurring_expense",
  "recurring_expense_payment", "create_expense_category", "update_expense_category", "get_expense_history",
  // «Режим директора» (17.11.2026, ai/assistant/tools/directorTools.ts): заявки, журнал ошибок, здоровье,
  // рубильники — только в личке. Буквами (не импортом): сверку с DIRECTOR_TOOL_NAMES держит
  // tests/ai-assistant-director-tools.test.ts.
  "list_pending_requests", "decide_request", "get_error_log", "resolve_error", "get_system_health", "list_switches", "set_switch",
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

/**
 * Актор брокера на нажатии: ПОЛНЫЕ свежие права нажавшего, канал telegram. `telegramChatId` — id
 * лички из апдейта (только для лички): по нему дверь lib/assistantStaffStepUpWaiver.ts сверяет,
 * что директор работает без кода в своём привязанном чате.
 */
function actionActorOf(agentId: string, access: AgentAccess, telegramPrivate: boolean, telegramChatId?: string): AssistantActionActor {
  return {
    agentId, channel: "telegram", telegramPrivate,
    ...(telegramPrivate && telegramChatId ? { telegramChatId } : {}),
    can: (permission) => access.permissions.has(permission),
  };
}

// ───────────────────────────── рендер ─────────────────────────────

const FIELD_MAX = 120;
function field(value: unknown, max = FIELD_MAX): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "—" : String(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lines(record: Record<string, unknown>, max = FIELD_MAX): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}: ${field(v, max)}`)
    .join("; ");
}

/** Текст озвучки в карточке читается целиком (было → станет): 120 знаков хватает на цену, но не на текст ролика. */
const NARRATION_FIELD_MAX = 1300;

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
/** Буквы, которых нет в русском, — по ним видно, что инструмент построил карточку по-таджикски. */
const TAJIK_LETTERS = /[ӣӯқғҳҷҒҚҲҶӢӮ]/u;

/** Язык рамки карточки: таджикский, только если все карточки построены по-таджикски и разговор таджикский. */
export function bundleFrameLang(actions: readonly Pick<AssistantActionView, "preview">[], language: ReturnType<typeof assistantLanguage> | undefined): CardFrameLang {
  return actions.length > 0 && actions.every((a) => TAJIK_LETTERS.test(a.preview.title)) && cardFrameLang(language) === "tg" ? "tg" : "ru";
}
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
    // Сообщение коллеге (send_staff_message): текст показывается ЦЕЛИКОМ, без обрезки field() —
    // подтверждают ровно то, что уйдёт. Длину держит сам инструмент (≤ 1000 знаков).
    if (a.tool === "send_staff_message" && typeof p.becomes.Сообщение === "string") {
      return [head, `   ${p.becomes.Сообщение}`, `   ⚠️ ${p.risk ?? frame.irreversible}`].join("\n");
    }
    const max = (a.tool === "request_narration" || a.tool === "approve_narration") ? NARRATION_FIELD_MAX : FIELD_MAX;
    return [
      head,
      `   ${frame.was}: ${lines(p.was, max)}`,
      `   ${frame.becomes}: ${lines(p.becomes, max)}`,
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
  /** Модель поняла просьбу ответить голосом (метка `[голос]`, уже вырезанная из reply). */
  voiceRequested?: boolean;
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
  /** Прямое обращение в группе: даёт модели инструмент set_group_quiet (ai/assistant/tools/groupQuietTool.ts). */
  groupChat?: { chatId: string; registeredAt: number };
  /** Личка: id чата из апдейта — для двери «директор без кода» (lib/assistantStaffStepUpWaiver.ts). */
  privateChatId?: string;
  /** К запросу приложен текст файла: записи без карточки подтверждения закрыты (attachedFileHiddenTools). */
  attachedFile?: boolean;
  /**
   * Справка ТОЛЬКО для модели (открытые вопросы Шабнам о показах, 22.11.2026): ставится перед
   * последней репликой сотрудника в запросе к модели. В историю разговора, быстрые пути, язык
   * ответа и разбор очереди монтажа не идёт — там только слова сотрудника (ревью 22.11).
   */
  modelContext?: string;
}

/** История для модели: справка перед последней репликой сотрудника; сама история не меняется. */
export function withModelContext<T extends { role: "user" | "assistant"; content: string }>(history: T[], context?: string): T[] {
  const last = history[history.length - 1];
  if (!context || last?.role !== "user") return history;
  return [...history.slice(0, -1), { ...last, content: context + last.content }];
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

/**
 * Вид ответа: метка модели `[голос]` — главное (она понимает просьбу любыми словами), разбор
 * фраз — страховка. Язык голоса при метке — язык самого ответа (assistantDelivery берёт его первым).
 */
function replyPreference(result: TurnResult, fallback: ReturnType<typeof requestedAssistantReplyPreference> | undefined) {
  return result.voiceRequested ? { mode: "voice" as const, voiceLanguage: fallback?.voiceLanguage } : fallback;
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
  if (params.attachedFile) actor.hiddenTools = new Set([...(actor.hiddenTools ?? []), ...attachedFileHiddenTools()]);
  // Мастер объекта (уровень A, но пишет в черновик) — только на собственную просьбу сотрудника: пересланный
  // текст продавца, файл или ход «только читать» не открывают мастер и не льют чужие данные в черновик.
  if (params.forwardedEvidence || params.readOnlyGroup || params.onlyGroupConfirmation || params.attachedFile) {
    actor.hiddenTools = new Set([...(actor.hiddenTools ?? []), "start_property_draft"]);
  }
  // «Помолчи» словами модели — только на прямое обращение: ни пересылка, ни автоответ его не включают.
  if (params.groupChat && params.scope === "group" && !params.forwardedEvidence && !params.readOnlyGroup && !params.onlyGroupConfirmation) {
    actor.groupChat = params.groupChat;
  }
  if (params.scope === "private" && params.privateChatId) actor.telegramChatId = params.privateChatId;
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
      const fast = await tryAssistantFastPath(last.content, actor, assistantLanguage(params.history) === "tg" ? "tg" : "ru");
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
  const outcome = await runAssistantDetailed(withModelContext(params.history, params.modelContext), actor, {
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
  // Модель не решает, работает ли голос: такие фразы вырезаются до отправки и до истории.
  // Метку `[голос]` (модель поняла просьбу ответить голосом) снимаем здесь же — в историю и
  // в текст она не попадает. Пересланное — чужие слова, не просьба этого человека.
  const marked = splitVoiceMarker(outcome.reply);
  return {
    reply: dropVoiceAvailabilityClaims(marked.text), voiceRequested: marked.voice && !params.forwardedEvidence, pending, done, structured,
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
  // Язык рамки = язык содержимого инструментов (повторное ревью 10.11.2026): таджикская рамка только
  // если все карточки построены по-таджикски и собеседник говорит по-таджикски; иначе русская целиком.
  const frameLang = bundleFrameLang(result.pending, ctx.cardLanguage ?? ctx.requestLanguage);
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
  // Код на кнопке — та же дверь, что у брокера на нажатии (директор без кода, 23.11.2026).
  const needsCode = !tajikPrice && await bundleNeedsStepUpByIds(binding.actionIds, {
    agentId: ctx.agentId, channel: "telegram", telegramPrivate: ctx.scope === "private",
    ...(ctx.scope === "private" ? { telegramChatId: chatId } : {}), can: () => false,
  });
  // Карточка целиком, ответ модели — по остатку места (не наоборот).
  const room = Math.max(0, TEXT_MAX_CHARS - card.length - 2);
  const text = [body.slice(0, room), card].filter(Boolean).join("\n\n");
  const buttons = [[
    // Сотрудники и права: кнопка честно говорит, что дальше спросят код (assistantStepUp.ts). Рамка — на
    // языке содержимого (у карточек сотрудников она русская), поэтому и надпись кнопки — русская.
    { text: tajikPrice ? "Ҳа" : needsCode ? "🔐 Подтвердить кодом" : irreversible ? frame.okIrreversible : maskPhones ? frame.okPlain : frame.ok, callback_data: `as:ok:${bundleId}` },
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

/**
 * Контакт из Telegram («Поделиться номером» или визитка) → строка для помощницы (21.11.2026).
 * Имя из чужой визитки — данные, а не команда: переводы строк и длина урезаны.
 */
export function staffContactPrompt(contact: { phone_number: string; first_name?: string }): string {
  const digits = contact.phone_number.replace(/[^\d]/g, "");
  const name = (contact.first_name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `Контакт: ${name ? `${name}, ` : ""}+${digits}`;
}

const HELP_TEXT =
  "Я помощник CRM. Напишите или надиктуйте просьбу: «найди клиента …», «покажи ОБ-123», «снизь цену ОБ-123 до 90000». " +
  "Всё, что меняет данные, я показываю карточкой «было → станет» и жду вашего «Подтвердить». «Добавь объект» — открыть мастер в личке. /new — начать разговор заново.";

type HistoryMessage = { role: "user" | "assistant"; content: string };

/** История разговора и номер Telegram-сообщения последней реплики человека в ней (если он записан). */
async function loadDialog(chatId: string, agentId: string): Promise<{ messages: HistoryMessage[]; lastUserMessageId?: number }> {
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (!row || row.kind !== DIALOG_KIND || row.agentId !== agentId || row.expiresAt <= new Date()) return { messages: [] };
  const payload = (row.payload ?? null) as Record<string, unknown> | null;
  const raw = payload?.messages;
  const messages = Array.isArray(raw)
    ? raw.filter((m): m is HistoryMessage => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    : [];
  const lastUser = messages.slice().reverse().find((m) => m.role === "user");
  const lastUserMessageId = lastUser ? lastUserTurnMessageId(payload, lastUser.content) : undefined;
  return { messages, ...(lastUserMessageId ? { lastUserMessageId } : {}) };
}

async function loadHistory(chatId: string, agentId: string): Promise<HistoryMessage[]> {
  return (await loadDialog(chatId, agentId)).messages;
}

async function saveHistory(chatId: string, agentId: string, history: HistoryMessage[], userMessageId?: number) {
  // Сливаем с живым состоянием, а не пишем заново: запомненные фото расходов, «внеси расходы» и правка строки
  // карточки лежат в том же payload и не должны пропадать после каждого хода модели (assistantDialogState.ts).
  // Чужое состояние в этом же чате (модерация, вопрос монтажёру) не затираем — это внутри merge.
  const lastUser = history.slice().reverse().find((m) => m.role === "user");
  await mergeAssistantDialog({
    chatId, agentId,
    // sent — номера своих сообщений этого чата (sentMessageLog.ts): «удали присланное» после перезапуска.
    // lastUserTurn — номер сообщения последней реплики: список расходов из неё получает ключ этого сообщения.
    change: (payload) => ({
      ...payload, messages: trimAssistantHistory(history), sent: deletableSentMessages(chatId),
      lastUserTurn: lastUser && userMessageId ? userTurnRecord(lastUser.content, userMessageId) : null,
    }),
    expiresAt: () => new Date(Date.now() + DIALOG_TTL_MS),
  });
}

/**
 * «УДАЛИ ВСЁ, ЧТО ПРИСЛАЛА» — ТОЛЬКО ЛИЧКА, ТОЛЬКО СВОИ СООБЩЕНИЯ (17.11.2026).
 * Номера — из журнала отправленного (sentMessageLog.ts) и из состояния диалога (после перезапуска).
 * Telegram удаляет только младше 48 часов; что не удалилось — говорим честно числом. Без карточки:
 * владелец решил, что обратимость здесь не нужна. В группе этого пути нет вовсе.
 */
async function deleteOwnPrivateMessages(chatId: string, agentId: string, text: string, lang: "ru" | "tg"): Promise<string> {
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  const own = Boolean(row && row.kind === DIALOG_KIND && row.agentId === agentId);
  if (own) mergeSentEntries(chatId, (row!.payload as { sent?: unknown } | null)?.sent);
  const scope = deleteSentScope(text);
  // Неясная фраза («убери голосовые ответы», «удали сообщение для Нозы») ничего не стирает — спрашиваем.
  if (scope === "ask") return deleteSentAsk(lang);
  const all = deletableSentMessages(chatId);
  const targets = scope === "last" ? all.slice(-1) : all;
  const deleted: number[] = [];
  // По одному, с конца: Telegram держит частоту сам (call() ждёт retry_after).
  for (const entry of [...targets].reverse()) {
    if (await deletePrivateMessage(chatId, entry.id)) deleted.push(entry.id);
  }
  // И удалённые, и неудаляемые (старше окна, уже стёрты руками) больше не пробуем.
  forgetSentMessages(chatId, targets.map((e) => e.id));
  // Только поле sent и только в свежем состоянии под замком: payload, прочитанный ДО цикла удаления,
  // затёр бы историю и запомненные фото, записанные за это время (assistantDialogState.ts).
  if (own) {
    await patchLiveAssistantDialog({ chatId, agentId, change: (payload) => ({ ...payload, sent: deletableSentMessages(chatId) }) })
      .catch(() => false);
  }
  return deleteSentReply(lang, deleted.length, targets.length);
}

async function clearHistory(chatId: string) {
  await clearAssistantDialog(chatId);
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
  const media = await handleAssistantMedia(msg, agentId, {
    allowGroup: msg.chat.type !== "private", wallet, language: () => stepUpLanguageOf(String(msg.chat.id), agentId),
  });
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
    // Контакт сотрудника: свой номер — уже подключён, лишнюю кнопку «Поделиться номером» снимаем;
    // чужая визитка — слова для помощницы («найди или заведи клиента»), а не общая подсказка.
    let contactText = "";
    if (msg.contact) {
      if (msg.contact.user_id != null && String(msg.contact.user_id) === String(msg.from?.id ?? "")) {
        await removeKeyboard(chatId, "Это ваш номер, вы уже подключены к CRM. Пишите просьбу словами.");
        return;
      }
      contactText = staffContactPrompt(msg.contact);
    }
    const moneyWallet = createAssistantMoneyWallet();
    if (msg.document && await handleTelegramExpenseReceipt(msg, agent.id, moneyWallet)) return;
    // «Править текст» озвучки (15 минут после кнопки) — раньше мастера объекта и общего ответа.
    // Голосовое в эти 15 минут — тоже новый текст озвучки: расшифровка той же дверью, что у обычного голосового.
    if (!isForwarded && await handleNarrationTextReply(msg, agent, (m) => transcribeVoice(m, agent.id, moneyWallet))) return;
    // «Озвучь текст» (16.11.2026): дословная озвучка текста сотрудника выбранным голосом — telegram/assistantFreeNarration.ts.
    if (await handleFreeNarrationMessage(msg, agent, isForwarded)) return;
    // Новая подпись поста без объекта (10 минут после «Изменить подпись») — telegram/staffSocialPost.ts.
    if (!isForwarded && await handleStaffSocialText(msg, agent)) return;
    // Ответ «к какому объекту ролик» (30 минут после вопроса) — telegram/staffClip.ts.
    if (!isForwarded && await handleStaffClipText(msg, agent)) return;
    if (!isForwarded && await handleTelegramPropertyDraft(msg, agent, transcribeVoice)) return;
    // Фото или альбом с «опубликуй» — пост в соцсети без объекта (21.11.2026). ПОСЛЕ мастера объекта:
    // сотрудник в мастере, фото с «выложи» — это фото объекта. Без этих слов фото идут дальше (расходы).
    if (!isForwarded && await handleStaffSocialPhoto(msg, agent)) return;
    // Ролик от СММщика или другого сотрудника (12.11.2026): сам находит объект, дальше
    // «Готов к выпуску» или «Нужен монтаж». В мастере объекта видео остаётся исходником (выше).
    if (await handleStaffClipMessage(msg, agent)) return;
    if (msg.photo?.length && await handleTelegramExpenseReceipt(msg, agent.id, moneyWallet)) return;
    let text = (msg.text ?? msg.caption ?? "").trim() || contactText;
    const fromVoice = Boolean(msg.voice || msg.audio);
    let forwardedEvidence = forwardedPlain;
    let attachedFileText = "";
    if (!forwardedPlain && (text === "/new" || text === "/reset")) {
      await clearHistory(chatId);
      clearStaffPropertyPage(cardScope);
      // remove_keyboard: у давно привязанных кнопка клиентского бота исчезает при первом /new.
      await removeKeyboard(chatId, "Начали заново.");
      return;
    }
    if (!forwardedPlain && text.startsWith("/")) {
      if (text === "/start" || text.startsWith("/start@")) await removeKeyboard(chatId, HELP_TEXT);
      else await send(HELP_TEXT);
      return;
    }
    // Фото или файл с подписью СВОИМИ словами (17.11.2026, журнал прода 10–11.11; одна дверь с #268 —
    // telegram/assistantAttachedRequest.ts): подпись — просьба сотрудника, текст файла — цитата-данные в
    // границах недоверенного содержимого, записи без карточки на таком ходе закрыты. Раньше текст только
    // пересказывался и ход кончался без истории — «внеси их» следующим сообщением модель выполнить не могла.
    if ((msg.photo?.length || msg.document) && text) {
      if (!(await isAiAssistantEnabled())) { await send(DISABLED_TEXT); return; }
      const access = await loadAgentAccess(agent.id);
      if (!access?.isActive) { await send("Ваша учётка отключена."); return; }
      void sendChatAction(chatId).catch(() => {});
      const media = await handleAssistantMedia(msg, agent.id, { wallet: moneyWallet, language: () => stepUpLanguageOf(chatId, agent.id) });
      const extracted = access.permissions.has("clients.viewPhone") ? media.text : maskAssistantContacts(media.text);
      if (forwardedPlain || media.error || !media.extraction) {
        // File text is quoted evidence, never a request that may authorize CRM writes.
        for (let offset = 0; offset < extracted.length; offset += 3500) await send(extracted.slice(offset, offset + 3500));
        return;
      }
      // Подпись — слова сотрудника, а не часть файла (17.11.2026): «оплатил рекламу 300» раньше терялась,
      // человеку возвращали только распознанный текст. Теперь подпись идёт обычным ходом помощницы,
      // текст файла приложен к нему недоверенным документом (как у пересланных сообщений).
      attachedFileText = extracted;
    }
    if (fromVoice) {
      const voice = await transcribeVoice(msg, agent.id, moneyWallet);
      if ("error" in voice) {
        await send(voice.error);
        return;
      }
      // «Добавь объект» голосом (21.11.2026): мастер выше видит только текст, и голосовая просьба
      // уходила в общий ответ, где помощница отвечала «не могу». Расшифровка — тот же разбор фразы.
      if (!isForwarded && isPropertyDraftStartText(voice.text)
        && await handleTelegramPropertyDraft({ ...msg, voice: undefined, audio: undefined, text: voice.text, caption: undefined }, agent, transcribeVoice)) return;
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
        // Фото без слов у того, кто ведёт расходы, помнится 30 минут: «мана акс, ворид кун» следом
        // разберёт его как расходы (assistantExpenseFollowup.ts), а не уйдёт модели без фото.
        if (msg.photo?.length) await rememberExpensePhoto(msg, agent.id).catch(() => false);
        await setMessageReaction(chatId, msg.message_id, "👀");
        return;
      }
      await send(HELP_TEXT);
      return;
    }
    const textLang = (): "ru" | "tg" => {
      const language = assistantLanguage([{ role: "user", content: text }]);
      return language === "tg" || language === "mixed" ? "tg" : "ru";
    };
    // «Удали всё, что прислала» (17.11.2026): свои сообщения этого личного чата, без модели.
    if (!forwardedEvidence && isDeleteSentRequest(text)) {
      if (!(await loadAgentAccess(agent.id))?.isActive) { await send("Ваша учётка отключена."); return; }
      await send(await deleteOwnPrivateMessages(chatId, agent.id, text, textLang()));
      return;
    }
    // Длинный текст «для озвучки» мимо разбора «Озвучь текст:» — подсказка, а не ход модели (17.11.2026).
    if (!forwardedEvidence && looksLikeNarrationDictation(text)) {
      await send(narrationDictationReply(textLang(), fromVoice));
      if (fromVoice) await send(text.slice(0, 3500));
      return;
    }
    // Ответ на «Править → строка N» в карточке расходов: поправка строки, а не новая просьба.
    // Свои слова человека (не пересланное и не подпись с цитатой файла) — для разборов кодом ниже:
    // подпись к файлу идёт модели вместе с файлом, иначе разбор списка расходов съел бы подпись без файла.
    const ownWords = !forwardedEvidence && !attachedFileText.trim();
    if (ownWords && await applyExpenseFixMessage(chatId, agent.id, text, msg.message_id)) return;
    const more = ownWords && propertyPageRequest(text);
    if (more && await replyWithMoreProperties(cardScope, more, text)) return;
    // «Не присылай мне такое», «что у меня выключено», «включи обратно уведомления …» —
    // личные отключения. ПОСЛЕ карточек (правка строки расходов, «ещё варианты»): рабочий
    // ответ на карточку важнее; разбор узкий и чужую фразу пропускает дальше (staffNotice.ts).
    if (ownWords && await handleNoticePreferenceText(msg, agent, text)) return;
    const dialog = await loadDialog(chatId, agent.id);
    const previous = dialog.messages;
    // Расходы списком в этом сообщении — одна карточка кодом; «вот фото / внеси эти / повтори карточку»
    // без данных — запомненные фото, карточка за сутки или одна фраза, чего не хватает (17.11.2026).
    if (ownWords && await handleExpenseTextMessage({ chatId, agentId: agent.id, text, messageId: msg.message_id })) return;
    if (ownWords && await handleExpenseFollowupText({
      chatId, agentId: agent.id, text, messageId: msg.message_id,
      previousUserText: previous.slice().reverse().find((m) => m.role === "user")?.content,
      previousUserMessageId: dialog.lastUserMessageId,
    })) return;
    if (ownWords && isVoiceReplayRequest(text)) {
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
    // Открытые вопросы Шабнам о показах (22.11.2026): «да, был», «перенесли на завтра в шесть» без
    // справки не к чему привязать. Пусто, если вопросов нет; пересланное — чужие слова, справка не нужна.
    // Справка уходит только в запрос к модели (modelContext): в истории остаются слова сотрудника целиком.
    const showingContext = forwardedEvidence ? "" : await showingQuestionContext(agent.id).catch(() => "");
    const history = [...previous, { role: "user" as const, content: attachedRequest(text, attachedFileText).slice(0, 4000) }];
    const result = await runTurn({ agentId: agent.id, scope: "private", privateChatId: chatId, history, deny: send, moneyWallet, forwardedEvidence, allowPropertyCards: true,
      attachedFile: Boolean(attachedFileText.trim()), modelContext: showingContext || undefined,
      showWorking: showTyping, turnKey: `tg:${chatId}:${msg.message_id}`,
      validateQueueAudience: async () => (await findAgentByTelegramChatId(chatId))?.id === agent.id,
    });
    if (!result) return;
    if (!await sendSelectedPropertyCards(cardScope, result, text)) {
      const preference = replyPreference(result, forwardedEvidence ? undefined : requestedAssistantReplyPreference(text));
      await sendTurnResult(chatId, result, {
        agentId: agent.id, authorName: agent.fullName, scope: "private", fromVoice,
        mode: preference?.mode ?? "auto", reactTo: msg.message_id, voiceLanguage: preference?.voiceLanguage,
        requestLanguage: preference?.mode === "voice" ? assistantLanguage([{ role: "user", content: text }]) : undefined,
        // Язык разговора, а не одного сообщения: «5000» или «ҳа» не сбивают на русский.
        cardLanguage: assistantLanguage(history.slice(-6)),
      });
    }
    await saveHistory(chatId, agent.id, [...history, { role: "assistant", content: result.reply.slice(0, 4000) }], msg.message_id);
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
  // Группа стала супергруппой: регистрация переезжает на новый id. ДО проверки «группа подключена»
  // (на новом id её ещё нет) и без отправителя-сотрудника: это служебное сообщение Telegram, в чат ничего не пишем.
  const migration = groupMigrationEvent(msg.chat.id, msg.migrate_to_chat_id, msg.migrate_from_chat_id);
  if (migration) {
    try {
      await migrateAssistantGroupChat(migration.oldChatId, migration.newChatId);
    } catch (err) {
      // Событие Telegram второй раз не пришлёт; регистрацию дотянет сторож (lib/assistantGroupWatchdog.ts).
      await logSystemError("telegram", `Шабнам: не удалось перенести подключённую группу в супергруппу: ${describeError(err)}`, {
        dedupKey: "assistant-group-migration-failed",
      });
    }
    return true;
  }
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
        groupChat: addressed ? { chatId, registeredAt } : undefined,
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
      const preference = replyPreference(result, forwardedEvidence ? undefined : requestedAssistantReplyPreference(words));
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
  // «🔕 Не присылать такое» / «🔔 Включить обратно» — под любым сообщением помощницы по её почину.
  if (await handleStaffNoticeCallback(query)) return true;
  // «♻️ Восстановить» под сообщением руководству об удалении своего объекта/клиента через Шабнам.
  if (await handleTrashRestoreCallback(query)) return true;
  // «Договорились о показе?» / «У вас был показ?» (22.11.2026) — telegram/showingQuestionNotice.ts.
  if (await handleShowingQuestionCallback(query)) return true;
  // «✅ Оплатил» / «⏰ Напомнить завтра» под напоминанием об оплате подписки.
  if (await handlePaymentReminderCallback(query)) return true;
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
  if (await handlePropertyOfferCallback(query)) return true;
  if (await handleNarrationCallback(query)) return true;
  if (await handleNarrationPreviewCallback(query)) return true;
  if (await handleFreeNarrationCallback(query)) return true;
  // Ролик и пост без объекта: долгое (скачать, ИИ, публикация) — в очереди этого чата, как ход
  // помощницы в личке; разбор остальных апдейтов нажатие не держит, кнопка отвечает сразу.
  const chatLane: DeferWork = async (work) => {
    void runInAssistantLane(`private:${query.message?.chat.id ?? query.from?.id}`, work, async (err) => {
      await logSystemError("telegram", `Кнопка ролика или поста в Telegram: ${describeError(err)}`);
    });
  };
  if (await handleStaffClipCallback(query, chatLane)) return true;
  if (await handleStaffSocialCallback(query, chatLane)) return true;
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
    const actor = actionActorOf(clicker.id, access, callbackChat?.type === "private", chatId ?? undefined);

    // «Записать» под пачкой расходов, у которой вышло время: честно «ничего не записала» на языке
    // карточки и «Показать снова» с теми же строками (17.11.2026: 10–11.11 две карточки истекли молча).
    // Выключенная группа гасит и эту кнопку: «Показать снова» заводит новую карточку (сборка 22.11.2026).
    if (verb === "ok" && chatId && messageId && isExpiredExpenseBatch(actions)) {
      if (!(await groupRegistrationAllows())) return true;
      await answerCallbackQuery(query.id, await showExpiredExpenseCard(chatId, messageId, actions[0]!, bundleId));
      return true;
    }

    if (verb === "no") {
      const executed = await serializeBundle(bundleId, async () => {
        if (!(await groupRegistrationAllows())) return null;
        for (const a of actions) await discardPendingAssistantAction(a.id, actor).catch(() => undefined);
        await cancelStepUpForBundle(bundleId);
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

    if (verb === "undo") {
      if (callbackChat?.type !== "private" || !chatId) {
        await answerCallbackQuery(query.id, "Отменить можно в личке с Шабнам");
        return true;
      }
      const executed = actions.filter((a) => a.status === "EXECUTED");
      if (executed.length === 0) {
        await answerCallbackQuery(query.id, actions.some((a) => a.status === "UNDONE") ? "Уже отменено" : "Отменять нечего");
        return true;
      }
      // Откат того, что стояло за подтверждением личности, — тоже только с кодом.
      if (await bundleNeedsStepUp(executed, actor)) {
        await askStepUpCode({ agentId: clicker.id, chatId, bundleId, kind: "undo", cardMessageId: messageId, answer: (text) => answerCallbackQuery(query.id, text) });
        return true;
      }
      const undone = await serializeBundle(bundleId, () => undoBundle(executed.map((a) => a.id), actor));
      await answerCallbackQuery(query.id, undone.failed ? "Отменено не всё" : "Отменено");
      await showOnCard(chatId, messageId, undoSummary(undone, clicker.fullName), null);
      return true;
    }

    // Сотрудники, права, сброс 2FA (10.11.2026): как в CRM за подтверждением личности —
    // здесь только кодом Google Authenticator, отдельным сообщением (assistantStepUp.ts).
    // Уже исполненная или истёкшая карточка кода не просит: дальше «Уже выполнено» / «время вышло».
    const awaiting = actions.some((a) => a.status === "PENDING" && a.expiresAt.getTime() > Date.now());
    if (awaiting && await bundleNeedsStepUp(actions, actor)) {
      if (callbackChat?.type !== "private" || !chatId) {
        await answerCallbackQuery(query.id, "Это действие доступно в личке с Шабнам");
        return true;
      }
      await askStepUpCode({ agentId: clicker.id, chatId, bundleId, cardMessageId: messageId, answer: (text) => answerCallbackQuery(query.id, text) });
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
    if (!isGroup && outcome.undoable && messageId) {
      await showOnCard(chatId, messageId, safeSummary, undoButtons(bundleId));
      return true;
    }
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
  | { kind: "done"; failed: boolean; lines: string[]; priceResult?: string; undoable: boolean };

/** Текст «изменено, но не всё» из итога действия (changeRequestTool.ts::honestAppliedOutcome). */
export function partialResultNote(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = result as { status?: unknown; message?: unknown };
  return value.status === "PARTIAL" && typeof value.message === "string" && value.message.trim() ? value.message.trim() : undefined;
}

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
  let undoable = false;
  for (let i = 0; i < ids.length; i++) {
    try {
      const access = await loadAgentAccess(actor.agentId, prisma);
      if (!access?.isActive || isReadOnlyRole(access.role)) {
        throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на это действие");
      }
      const currentActor: AssistantActionActor = {
        ...actionActorOf(actor.agentId, access, actor.telegramPrivate === true, actor.telegramChatId),
        // Код проверен в этом же исполнении (assistantStepUp.ts) — только для него.
        ...(actor.stepUpVerified === true ? { stepUpVerified: true } : {}),
      };
      const { action, replay } = await confirmAssistantAction(ids[i], currentActor);
      if (!replay) ranAny = true;
      if (!replay && ids.length === 1) priceResult = renderGroupPriceResult(action, tajikPrice);
      lines.push(`${replay ? "↺" : "•"} ${action.preview.title}`);
      // «Изменено, но не всё» (заявка FAILED после записи, 17.11.2026) — не прятать за «Готово».
      const partial = partialResultNote(action.result);
      if (partial) lines.push(`⚠️ ${partial}`);
      if (action.undoUntil && UNDO_IN_TELEGRAM.has(action.tool)) undoable = true;
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
  return { kind: "done", failed, lines, priceResult, undoable: undoable && !failed };
}

/** Откат связки — в обратном порядке; на первой неудаче останавливаемся и говорим правду. */
async function undoBundle(ids: string[], actor: AssistantActionActor): Promise<{ failed: boolean; lines: string[] }> {
  const lines: string[] = [];
  let failed = false;
  const order = [...ids].reverse();
  for (const [index, id] of order.entries()) {
    try {
      const access = await loadAgentAccess(actor.agentId, prisma);
      if (!access?.isActive || isReadOnlyRole(access.role)) {
        throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на это действие");
      }
      const currentActor: AssistantActionActor = {
        ...actionActorOf(actor.agentId, access, actor.telegramPrivate === true, actor.telegramChatId),
        ...(actor.stepUpVerified === true ? { stepUpVerified: true } : {}),
      };
      const { action, replay } = await undoAssistantAction(id, currentActor);
      lines.push(`${replay ? "↺" : "↩️"} ${action.preview.title}`);
    } catch (err) {
      failed = true;
      lines.push(`✖ ${err instanceof AssistantActionError ? FAIL_STATUS_NOTE[err.code] ?? err.message : "не получилось отменить"}`);
      if (!(err instanceof AssistantActionError)) await logSystemError("ai", `Помощник Telegram: откат ${id} упал: ${describeError(err)}`);
      if (index < order.length - 1) lines.push("Остальное не отменено.");
      break;
    }
  }
  return { failed, lines };
}

/** Итог отката: при сбое честно «не всё отменено» и что именно. */
function undoSummary(undone: { failed: boolean; lines: string[] }, name: string): string {
  const head = undone.failed ? `⚠️ Не всё отменено (${name}):` : `↩️ ${name}:`;
  return sanitizeAssistantReply(`${head}\n${undone.lines.join("\n")}`, false);
}

/** Итог на месте карточки (личка): правим её текст и кнопки, не вышло — одно отдельное сообщение. */
async function showOnCard(chatId: string, messageId: number | undefined, text: string, buttons: ReturnType<typeof undoButtons> | null) {
  if (!messageId) {
    await sendMessage(chatId, text).catch(() => {});
    return;
  }
  await editMessageText(chatId, messageId, text, buttons).catch(async () => {
    await sendMessage(chatId, text).catch(() => {});
  });
}

// ───────────────────────────── код Google Authenticator ─────────────────────────────

async function stepUpLanguageOf(chatId: string, agentId: string): Promise<StepUpLanguage> {
  const history = await loadHistory(chatId, agentId).catch(() => []);
  const last = history.slice().reverse().find((m) => m.role === "user");
  if (!last) return "ru";
  const language = assistantLanguage([{ role: "user", content: last.content }]);
  return language === "tg" || language === "mixed" ? "tg" : "ru";
}

/** «Подтвердить» на карточке со step-up: просим код, ничего не исполняем. */
async function askStepUpCode(input: {
  agentId: string;
  chatId: string;
  bundleId: string;
  kind?: StepUpKind;
  cardMessageId?: number;
  answer: (text: string) => Promise<unknown>;
}): Promise<void> {
  const language = await stepUpLanguageOf(input.chatId, input.agentId);
  const started = await startStepUpChallenge({ ...input, language });
  if (started.kind === "no_totp") {
    await input.answer(language === "tg" ? "Google Authenticator фаъол нест" : "Не включён Google Authenticator");
    await sendMessage(input.chatId, stepUpText("noTotp", language)).catch(() => {});
    return;
  }
  if (started.kind === "locked") {
    await input.answer(language === "tg" ? "Тасдиқ муваққатан баста аст" : "Подтверждение временно закрыто");
    await sendMessage(input.chatId, stepUpText("locked", language)).catch(() => {});
    return;
  }
  await input.answer(language === "tg" ? "Кодро нависед" : "Введите код из приложения");
  const sent = (await sendMessage(input.chatId, stepUpText("prompt", language)).catch(() => null)) as { message_id?: number } | null;
  await rememberStepUpPrompt(started.challengeId, sent?.message_id);
}

/** Итог исполнения связки — тот же вид, что после обычного нажатия в личке. */
function privateSummary(outcome: Extract<BundleOutcome, { kind: "done" }>, clickerName: string): string {
  const mark = outcome.failed ? "⚠️" : "✅";
  return sanitizeAssistantReply(`${mark} ${clickerName}:\n${outcome.lines.join("\n")}`, false);
}

async function runVerifiedBundle(challenge: PendingStepUp, agent: { id: string; fullName: string }): Promise<void> {
  const tg = challenge.language === "tg";
  const access = await loadAgentAccess(agent.id, prisma);
  if (!access?.isActive || isReadOnlyRole(access.role)) {
    await sendMessage(challenge.chatId, tg ? "Барои ин кор ҳуқуқ нест." : "Нет прав на это действие.").catch(() => {});
    return;
  }
  const actions = await prisma.assistantAction.findMany({
    where: { bundleId: challenge.bundleId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, agentId: true, status: true },
  });
  if (actions.length === 0 || actions.some((a) => a.agentId !== agent.id)) {
    await sendMessage(challenge.chatId, tg ? "Корт кӯҳна шуд. Боз нависед." : "Карточка устарела. Повторите просьбу.").catch(() => {});
    return;
  }
  const actor: AssistantActionActor = { ...actionActorOf(agent.id, access, true, challenge.chatId), stepUpVerified: true };
  if (challenge.kind === "undo") {
    const undone = await serializeBundle(challenge.bundleId, () => undoBundle(actions.map((a) => a.id), actor));
    await showOnCard(challenge.chatId, challenge.cardMessageId ?? undefined, undoSummary(undone, agent.fullName), null);
    return;
  }
  const outcome = await serializeBundle(challenge.bundleId, () => executeBundle(actions.map((a) => a.id), actor, false));
  if (outcome.kind !== "done") {
    const note = outcome.kind === "busy" ? "Уже выполняется." : outcome.kind === "replay" ? "Уже выполнено." : outcome.message;
    await sendMessage(challenge.chatId, note).catch(() => {});
    return;
  }
  const summary = privateSummary(outcome, agent.fullName);
  await showOnCard(challenge.chatId, challenge.cardMessageId ?? undefined, summary, outcome.undoable ? undoButtons(challenge.bundleId) : null);
}

/**
 * Сообщение в личке, пока ждём код (telegram/bot.ts зовёт ДО остальных обработчиков
 * текста). true — это был код, и он обработан; false — обычное сообщение, дальше по
 * обычному пути. Сообщение с кодом удаляется сразу — и верное, и неверное.
 */
export async function handleAssistantStepUpMessage(msg: TelegramIncomingMessage, agent: { id: string; fullName: string }): Promise<boolean> {
  if (msg.chat.type !== "private" || msg.forward_origin || msg.forward_from_message_id) return false;
  const chatId = String(msg.chat.id);
  const voice = Boolean(msg.voice || msg.audio || msg.video_note);
  const code = voice ? null : parseStepUpCode(msg.text);
  if (!voice && !code) return false;
  const challenge = await findPendingStepUp(chatId, agent.id);
  if (!challenge) return false;
  if (voice) {
    // Голос кодом не считается: просим цифрами; распознавать цифры из речи — путь к ошибкам и утечке.
    if (challenge.expired) return false;
    await sendMessage(chatId, stepUpText("voice", challenge.language)).catch(() => {});
    return true;
  }
  const messageId = msg.message_id;
  // Проверка и исполнение — в очереди этого чата (как ход помощницы): два кода подряд
  // не проверяются наперегонки, а долгая передача дел не держит общую очередь апдейтов.
  deferAssistantReply(msg, runInAssistantLane(`private:${chatId}`, async () => {
    // Сообщение с кодом удаляется ДО проверки — и верное, и неверное.
    if (messageId && !(await deletePrivateMessage(chatId, messageId))) {
      await sendMessage(chatId, stepUpText("notDeleted", challenge.language)).catch(() => {});
    }
    await checkStepUpCode(chatId, challenge, code!, agent);
  }, async (err) => {
    await logSystemError("telegram", `Помощник: проверка кода Google Authenticator: ${describeError(err)}`);
  }));
  return true;
}

async function checkStepUpCode(chatId: string, challenge: PendingStepUp, code: string, agent: { id: string; fullName: string }): Promise<void> {
  try {
    const verdict = await verifyStepUpCode(challenge, code);
    if (verdict.kind === "gone") return;
    if (verdict.kind !== "passed") {
      if (challenge.kind === "confirm" && (verdict.kind === "locked" || verdict.kind === "no_totp" || verdict.kind === "inactive")) {
        const actor: AssistantActionActor = { agentId: agent.id, channel: "telegram", telegramPrivate: true, can: () => false };
        const rows = await prisma.assistantAction.findMany({ where: { bundleId: challenge.bundleId }, select: { id: true } });
        for (const row of rows) await discardPendingAssistantAction(row.id, actor).catch(() => undefined);
      }
      await sendMessage(chatId, verdict.message).catch(() => {});
      return;
    }
    if (challenge.promptMessageId) void deletePrivateMessage(chatId, challenge.promptMessageId);
    await runVerifiedBundle(challenge, agent);
  } catch (err) {
    await logSystemError("telegram", `Помощник: проверка кода Google Authenticator: ${describeError(err)}`);
    await sendMessage(chatId, challenge.language === "tg" ? "Нашуд, боз кӯшиш кунед." : "Не получилось, попробуйте ещё раз.").catch(() => {});
  }
}
