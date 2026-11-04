import {
  ASSISTANT_ACTION_STATUSES, CLIENT_STATUSES, PROPERTY_CHANGE_KINDS, PROPERTY_CHANGE_STATUSES,
  PROPERTY_CONDITIONS, PROPERTY_DELETE_REQUEST_REASONS, PROPERTY_STATUSES, PROPERTY_TYPES, VIDEO_REMAKE_REASONS,
} from "@royal-home/shared";
import type { ClientLanguage } from "../ai/clientLanguage.js";
import { listAssistantToolPlugins } from "../ai/assistant/tools/index.js";
import { sendHtmlMessage, sendMessage, sendMessageWithButtons, TelegramApiError, type TelegramInlineButton } from "./api.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import {
  assistantCardLinks, escapeHtml, prepareAssistantReply, renderAssistantForTelegram, renderAssistantHtml,
  sanitizeAssistantReply, splitHumanMessages, type AssistantReplyMode,
} from "./assistantReply.js";
import { describeError } from "../lib/describeError.js";
import { GROUP_REMAKE_REASON_QUESTION } from "./assistantGroupParticipation.js";

const MAX_CARD_BUTTONS = 5;
const AUTO_VOICE_MAX_CHARS = 180;
const TEXT_LAYOUT = /\p{N}|^\s*[-•▪*]\s|\n\s*\n/mu;
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

/** Send the useful format first. Automatic audio is reserved for short conversation. */
export async function sendAssistantReply(chatId: string, text: string, ctx: {
  scope: "private" | "group";
  fromVoice?: boolean;
  /** Adapter proof: a short native voice explicitly addressed to this group bot, never a forward. */
  addressedGroupVoice?: boolean;
  structured?: boolean;
  mode?: AssistantReplyMode;
  requestLanguage?: ClientLanguage;
  replyTo?: number;
  written: string[];
}): Promise<boolean> {
  const maskPhones = ctx.scope === "group";
  const clarification = maskPhones ? assistantGroupClarification(text, ctx.requestLanguage) : null;
  const plan = prepareAssistantReply(clarification ?? text, maskPhones);
  const parts = splitHumanMessages(plan.text);
  if (!parts.length) parts.push("");
  const structured = Boolean(ctx.structured || plan.needsText || ctx.written.length
    || plan.text.length > AUTO_VOICE_MAX_CHARS || parts.length > 2 || TEXT_LAYOUT.test(plan.text));
  let canSpeak = !clarification && (ctx.mode === "voice" || (ctx.mode !== "text" && ctx.fromVoice
    && (ctx.scope === "private" || ctx.addressedGroupVoice === true) && !structured));
  const buttonPaths = new Set<string>();

  for (const [i, textPart] of parts.entries()) {
    const part = prepareAssistantReply(textPart, maskPhones);
    const written = i === parts.length - 1 ? ctx.written.map(entry => sanitizeAssistantReply(entry, maskPhones)) : [];
    const replyTo = i === 0 ? ctx.replyTo : undefined;
    const buttons: TelegramInlineButton[][] = [];
    for (const { path, text, url } of assistantCardLinks(part.text, maskPhones)) {
      if (buttonPaths.size >= MAX_CARD_BUTTONS) break;
      if (buttonPaths.has(path)) continue;
      buttonPaths.add(path);
      buttons.push([{ text, url }]);
    }

    if (canSpeak && part.language !== "text-only" && part.speech.length >= 3) {
      const delivered = await sendAssistantVoiceReply(chatId, part.speech, replyTo);
      if (delivered && !structured && !part.needsText && !buttons.length) continue;
      if (!delivered) canSpeak = false;
    }
    const html = [renderAssistantHtml(part.text, { maskPhones }), ...written.map(escapeHtml)].filter(Boolean).join("\n");
    if (html && html.length <= 3900) {
      try {
        if (buttons.length) await sendHtmlMessage(chatId, html, replyTo, buttons);
        else await sendHtmlMessage(chatId, html, replyTo);
        continue;
      } catch (err) {
        if (!(err instanceof TelegramApiError && err.errorCode === 400 && /can't parse entities/i.test(err.message))) {
          console.warn("[telegram:assistant] HTML: результат доставки не подтверждён, без повтора:", describeError(err));
          return false;
        }
      }
    }
    const plain = [renderAssistantForTelegram(part.text, { maskPhones }), ...written].filter(Boolean).join("\n") || "Готово.";
    if (buttons.length) await sendMessageWithButtons(chatId, plain, buttons, replyTo);
    else await sendMessage(chatId, plain, replyTo);
  }
  return true;
}
