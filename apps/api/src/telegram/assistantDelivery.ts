import {
  ASSISTANT_ACTION_STATUSES, CLIENT_STATUSES, PROPERTY_CHANGE_KINDS, PROPERTY_CHANGE_STATUSES,
  PROPERTY_CONDITIONS, PROPERTY_DELETE_REQUEST_REASONS, PROPERTY_STATUSES, PROPERTY_TYPES, VIDEO_REMAKE_REASONS,
} from "@royal-home/shared";
import type { ClientLanguage } from "../ai/clientLanguage.js";
import { listAssistantToolPlugins } from "../ai/assistant/tools/index.js";
import { sendHtmlMessage, sendMessage, sendMessageWithButtons, TelegramApiError, type TelegramInlineButton } from "./api.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import {
  ASSISTANT_VOICE_PART_CHARS, assistantCardLinks, escapeHtml, prepareAssistantReply, prepareAssistantVoicePart,
  renderAssistantForTelegram, renderAssistantHtml,
  sanitizeAssistantReply, splitHumanMessages, type AssistantReplyMode, type AssistantSpeechLanguage,
} from "./assistantReply.js";
import { describeError } from "../lib/describeError.js";
import { GROUP_REMAKE_REASON_QUESTION } from "./assistantGroupParticipation.js";

const MAX_CARD_BUTTONS = 5;
const TEXT_LAYOUT = /\p{N}|^\s*[-•▪*]\s|\n\s*\n/mu;
/**
 * Абзацы беседы — это реплики, а не вёрстка (владелец, 14.11.2026): на голосовое «Салом!» модель
 * ответила двумя абзацами приветствия, пустая строка посчиталась списком, и голоса не было.
 * Пустая строка без цифр, пунктов и ссылок превращается в разделитель реплик `|||`; данные
 * (цифры, пункты, ссылки) остаются текстом, как и прежде.
 */
const DATA_LAYOUT = /\p{N}|^\s*[-•▪*]\s|\]\(|(?:https?:\/\/|www\.)/imu;
const CONVERSATION_PARAGRAPH = /[ \t]*\n[ \t]*\n\s*/gu;
export function conversationParagraphsAsReplies(text: string): string {
  return DATA_LAYOUT.test(text) ? text : text.replace(CONVERSATION_PARAGRAPH, "\n|||\n");
}
const CRM_CODES = new Set<string>([
  ...ASSISTANT_ACTION_STATUSES, ...CLIENT_STATUSES, ...PROPERTY_CHANGE_KINDS, ...PROPERTY_CHANGE_STATUSES,
  ...PROPERTY_CONDITIONS, ...PROPERTY_DELETE_REQUEST_REASONS, ...PROPERTY_STATUSES, ...PROPERTY_TYPES, ...VIDEO_REMAKE_REASONS,
]);
const REMAKE_CODES = new Set<string>(VIDEO_REMAKE_REASONS.filter(code => code !== "OTHER"));
const CRM_TOKEN = /(?<![\p{L}\p{N}_@])[A-Za-z][A-Za-z0-9_]*(?![\p{L}\p{N}_])/gu;
const INTERNAL_WORK_PHASE = /^(?:WITH_EDITOR|SENDING_TO_EDITOR|WAITING_FOR_(?:EDITOR|MANUAL_UPLOAD)|EDITING_PATH_UNCONFIRMED|EDITOR_(?:DELIVERY_UNCONFIRMED|QUEUE_ON_HOLD)|FINAL_VIDEO_[A-Z_]+|PUBLICATION_[A-Z_]+|AUTO_MONTAGE_[A-Z_]+)$/u;
const CODE_CONTEXT = /(?:\b(?:reason|status|kind|type)|причин[ауые]|статус|категори[яю]|тип)\s*[:=]?\s*[`"']?$/iu;
const INTERNAL_ASSIGNMENT = /(?<![\p{L}\p{N}_@])(?:reason|status|kind|type|ref|comment)(?:\s*=|["']\s*:)/iu;
const REMAKE_CONTEXT = /перемонтаж|монтаж[её]р|(?:^|[^\p{L}])навор(?:[^\p{L}]|$)|send_to_remake|removeFromSocial/iu;

/** Reject model-generated enum menus and tool syntax before any group transport. */
export function assistantGroupClarification(text: string, requestLanguage?: ClientLanguage): string | null {
  const visibleText = text.replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1").replace(/(?:https?:\/\/|www\.)[^\s)]+/gi, "");
  let technical = INTERNAL_ASSIGNMENT.test(visibleText);
  let remake = false;
  const tokens = [...visibleText.matchAll(CRM_TOKEN)];
  const codeList = new Set(tokens.map(([token]) => token).filter(token => CRM_CODES.has(token) && token !== "OTHER")).size > 1;
  for (const match of tokens) {
    const token = match[0];
    const upper = token.toUpperCase();
    if (INTERNAL_WORK_PHASE.test(upper)) { technical = true; continue; }
    if (!CRM_CODES.has(upper)) continue;
    const before = visibleText.slice(Math.max(0, match.index - 35), match.index);
    if (!upper.includes("_") && (token !== upper || !(codeList || before.endsWith("`") || CODE_CONTEXT.test(before)))) continue;
    technical = true;
    remake ||= REMAKE_CODES.has(upper);
  }
  // Use the registered tool names and fields so new tools get the same delivery guard.
  if (!technical && tokens.some(([token]) => token.includes("_") || /[a-z][A-Z]/.test(token))) {
    const tools = listAssistantToolPlugins();
    const names = new Set(tools.map(tool => tool.name));
    const fields = new Set(tools.flatMap(tool => {
      const properties = tool.parameters?.properties;
      return properties && typeof properties === "object" ? Object.keys(properties).filter(key => /[a-z][A-Z]/.test(key)) : [];
    }));
    technical = tokens.some(([token]) => names.has(token) || fields.has(token));
  }
  if (!technical) return null;
  remake ||= REMAKE_CONTEXT.test(visibleText);
  const objectCodes = [...new Set([...visibleText.matchAll(/(?:^|[^\p{L}\p{N}])(ОБ-\d{1,10})(?![\p{L}\p{N}])/giu)]
    .map(([, code]) => code.toUpperCase()))];
  const objectCode = objectCodes.length === 1 ? objectCodes[0] : undefined;
  const tajik = requestLanguage === "tg" || requestLanguage === "mixed"
    || ((!requestLanguage || requestLanguage === "unknown") && prepareAssistantReply(visibleText, true).language === "tg");
  if (remake) {
    if (objectCode) return GROUP_REMAKE_REASON_QUESTION[tajik ? "tg" : "ru"](objectCode);
    return tajik ? "Дар навор чиро ислоҳ кунем?" : "Что нужно поправить в ролике?";
  }
  if (tajik) return objectCode ? `Дар ${objectCode} чиро аниқ кунем?` : "Чиро аниқ кунем?";
  return objectCode ? `Что уточнить по ${objectCode}?` : "Что именно нужно уточнить?";
}

const VOICE_LEAD_CHARS = ASSISTANT_VOICE_PART_CHARS;
const VOICE_FAILED_NOTICE = { ru: "Голосом сейчас не вышло, пишу текстом.", tg: "Ҳоло бо овоз нашуд, навишта мефиристам." } as const;
const voiceNoticeLanguage = (request: ClientLanguage | undefined, plan: "ru" | "tg" | "text-only"): "ru" | "tg" =>
  request === "tg" || request === "mixed" || (request !== "ru" && plan === "tg") ? "tg" : "ru";
const BULLET_LIST = /^\s*(?:[-•▪*]|\d+[.)])\s/mu;

/**
 * Начало ответа для голоса: целые предложения до ~180 знаков (цифры уже словами). null — озвучивать нечего:
 * ответ со ссылкой, контактом, обещанием «пришлю текстом», списком или неясным языком.
 */
function voiceLead(plan: ReturnType<typeof prepareAssistantReply>): string | null {
  if (plan.ambiguousLanguage || plan.needsWrittenDetails || plan.language === "text-only"
    || BULLET_LIST.test(plan.text) || plan.speech.length < 3) return null;
  if (plan.speech.length <= VOICE_LEAD_CHARS) return plan.speech;
  const cut = plan.speech.slice(0, VOICE_LEAD_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end >= 40) return cut.slice(0, end + 1);
  // Цифры в тексте: резать посреди предложения нельзя, обрезанная сумма («сто двадцать пять тысяч…») — другая цена.
  if (/\p{N}/u.test(plan.text)) return null;
  const space = cut.lastIndexOf(" ");
  return space >= 40 ? `${cut.slice(0, space).replace(/[,;:\s]+$/u, "")}…` : null;
}

/** Send the useful format first. Automatic audio is reserved for short conversation. */
export async function sendAssistantReply(chatId: string, text: string, ctx: {
  scope: "private" | "group";
  fromVoice?: boolean;
  /** Adapter proof: a short native voice explicitly addressed to this group bot, never a forward. */
  addressedGroupVoice?: boolean;
  structured?: boolean;
  mode?: AssistantReplyMode;
  requestLanguage?: ClientLanguage;
  voiceLanguage?: AssistantSpeechLanguage;
  replyTo?: number;
  messageThreadId?: number;
  written: string[];
}): Promise<boolean> {
  const maskPhones = ctx.scope === "group";
  const clarification = maskPhones ? assistantGroupClarification(text, ctx.requestLanguage) : null;
  const voiceRequested = ctx.mode === "voice" || (ctx.mode !== "text" && ctx.fromVoice === true
    && (ctx.scope === "private" || ctx.addressedGroupVoice === true));
  const plan = prepareAssistantReply(clarification ?? (voiceRequested ? conversationParagraphsAsReplies(text) : text), maskPhones);
  const needsWrittenDetails = Boolean(ctx.structured || plan.needsWrittenDetails || ctx.written.length || TEXT_LAYOUT.test(plan.text));
  const explicitConversation = ctx.mode === "voice" && !needsWrittenDetails && !clarification;
  const parts = splitHumanMessages(plan.text, explicitConversation ? ASSISTANT_VOICE_PART_CHARS : undefined);
  if (!parts.length) parts.push("");
  // Длина — у каждой реплики: две короткие реплики беседы озвучиваются, одна длинная — нет.
  const structured = needsWrittenDetails || plan.truncated || parts.length > 2
    || parts.some(part => part.length > ASSISTANT_VOICE_PART_CHARS);
  const requestVoiceLanguage = ctx.requestLanguage === "mixed" ? undefined
    : ctx.requestLanguage === "ru" || ctx.requestLanguage === "tg" ? ctx.requestLanguage : ctx.voiceLanguage;
  const conversationLanguage = plan.language === "text-only" ? requestVoiceLanguage : plan.language;
  // Голосовой вопрос в личке: ответ без языковых примет («Сегодня три показа.») озвучивается на языке вопроса, а при
  // неясном языке по-русски (только кириллица, смешанный язык не трогаем): иначе голос терялся (24.11.2026).
  const spokenAnswerLanguage = ctx.scope === "private" && ctx.fromVoice === true && ctx.mode !== "text" && !ctx.structured
    ? requestVoiceLanguage ?? (ctx.requestLanguage === "mixed" ? undefined : "ru" as const) : undefined;
  let canSpeak = !clarification && !plan.ambiguousLanguage && voiceRequested && (ctx.mode === "voice" || !structured);
  const buttonPaths = new Set<string>();
  // Голосовой вопрос в личке получает голос, даже когда ответ длинный или с цифрами (владелец, 24.11.2026:
  // «голосовые вообще не отправляет»): коротко озвучиваем начало, полный текст идёт следом. Группу так не
  // озвучиваем (не спамим), как и ссылки, списки, итоги инструментов и всё, где слова нужно читать глазами.
  let spokenAny = false;
  let voiceNotice = "";
  const leadPlan = ctx.mode !== "voice" && ctx.scope === "private" && voiceRequested && structured
    && !ctx.structured && !ctx.written.length && !clarification
    ? prepareAssistantVoicePart(plan.text, maskPhones, spokenAnswerLanguage).part : null;
  const lead = leadPlan ? voiceLead(leadPlan) : null;
  if (lead && leadPlan) {
    const fallback = leadPlan.language === "text-only" ? undefined : leadPlan.language;
    spokenAny = ctx.messageThreadId !== undefined
      ? await sendAssistantVoiceReply(chatId, lead, ctx.replyTo, fallback, ctx.messageThreadId)
      : fallback ? await sendAssistantVoiceReply(chatId, lead, ctx.replyTo, fallback) : await sendAssistantVoiceReply(chatId, lead, ctx.replyTo);
    canSpeak = false;
  }

  for (const [i, textPart] of parts.entries()) {
    const { part, fallbackLanguage } = prepareAssistantVoicePart(textPart, maskPhones, explicitConversation ? conversationLanguage : spokenAnswerLanguage);
    const written = i === parts.length - 1 ? ctx.written.map(entry => sanitizeAssistantReply(entry, maskPhones)) : [];
    // The topic is shared by all parts; only quote the request where it helps.
    const replyTo = i === 0 || (explicitConversation && ctx.scope === "group") ? ctx.replyTo : undefined;
    const buttons: TelegramInlineButton[][] = [];
    for (const { path, text, url } of assistantCardLinks(part.text, maskPhones)) {
      if (buttonPaths.size >= MAX_CARD_BUTTONS) break;
      if (buttonPaths.has(path)) continue;
      buttonPaths.add(path);
      buttons.push([{ text, url }]);
    }

    const shortEnough = !explicitConversation || (!part.truncated && part.text.length <= ASSISTANT_VOICE_PART_CHARS);
    if (canSpeak && shortEnough && part.language !== "text-only" && part.speech.length >= 3) {
      const delivered = ctx.messageThreadId !== undefined
        ? await sendAssistantVoiceReply(chatId, part.speech, replyTo, fallbackLanguage, ctx.messageThreadId)
        : fallbackLanguage ? await sendAssistantVoiceReply(chatId, part.speech, replyTo, fallbackLanguage)
          : await sendAssistantVoiceReply(chatId, part.speech, replyTo);
      if (delivered) spokenAny = true;
      if (delivered && (explicitConversation || !structured) && !part.needsText && !buttons.length) continue;
      if (!delivered) {
        canSpeak = false;
        // Явно просили голос, а он не ушёл: говорим об этом, а не молчим (текст всё равно приходит).
        if (ctx.mode === "voice" && !spokenAny) voiceNotice = VOICE_FAILED_NOTICE[voiceNoticeLanguage(ctx.requestLanguage, plan.language)];
      }
    }
    const notice = voiceNotice;
    voiceNotice = "";
    const html = [notice ? escapeHtml(notice) : "", renderAssistantHtml(part.text, { maskPhones }), ...written.map(escapeHtml)].filter(Boolean).join("\n");
    if (html && html.length <= 3900) {
      try {
        if (ctx.messageThreadId !== undefined) await sendHtmlMessage(chatId, html, replyTo, buttons.length ? buttons : undefined, ctx.messageThreadId);
        else if (buttons.length) await sendHtmlMessage(chatId, html, replyTo, buttons);
        else await sendHtmlMessage(chatId, html, replyTo);
        continue;
      } catch (err) {
        if (!(err instanceof TelegramApiError && err.errorCode === 400 && /can't parse entities/i.test(err.message))) {
          console.warn("[telegram:assistant] HTML: результат доставки не подтверждён, без повтора:", describeError(err));
          return false;
        }
      }
    }
    const plain = [notice, renderAssistantForTelegram(part.text, { maskPhones }), ...written].filter(Boolean).join("\n") || "Готово.";
    if (buttons.length) {
      if (ctx.messageThreadId !== undefined) await sendMessageWithButtons(chatId, plain, buttons, replyTo, ctx.messageThreadId);
      else await sendMessageWithButtons(chatId, plain, buttons, replyTo);
    } else if (ctx.messageThreadId !== undefined) {
      await sendMessage(chatId, plain, replyTo, undefined, { messageThreadId: ctx.messageThreadId });
    } else await sendMessage(chatId, plain, replyTo);
  }
  return true;
}
