import { sendHtmlMessage, sendMessage, sendMessageWithButtons, TelegramApiError, type TelegramInlineButton } from "./api.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import {
  assistantCardLinks, escapeHtml, prepareAssistantReply, renderAssistantForTelegram, renderAssistantHtml,
  sanitizeAssistantReply, splitHumanMessages, type AssistantReplyMode,
} from "./assistantReply.js";
import { describeError } from "../lib/describeError.js";

const MAX_CARD_BUTTONS = 5;
const AUTO_VOICE_MAX_CHARS = 180;
const TEXT_LAYOUT = /\p{N}|^\s*[-•▪*]\s|\n\s*\n/mu;

/** Send the useful format first. Automatic audio is reserved for short conversation. */
export async function sendAssistantReply(chatId: string, text: string, ctx: {
  scope: "private" | "group";
  fromVoice?: boolean;
  structured?: boolean;
  mode?: AssistantReplyMode;
  replyTo?: number;
  written: string[];
}): Promise<boolean> {
  const maskPhones = ctx.scope === "group";
  const plan = prepareAssistantReply(text, maskPhones);
  const parts = splitHumanMessages(plan.text);
  if (!parts.length) parts.push("");
  const structured = Boolean(ctx.structured || plan.needsText || ctx.written.length
    || plan.text.length > AUTO_VOICE_MAX_CHARS || parts.length > 2 || TEXT_LAYOUT.test(plan.text));
  let canSpeak = ctx.mode === "voice" || (ctx.mode !== "text" && ctx.fromVoice && ctx.scope === "private" && !structured);
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
