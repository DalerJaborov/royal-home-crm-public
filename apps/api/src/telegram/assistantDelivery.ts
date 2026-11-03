import { sendHtmlMessage, sendMessage, TelegramApiError } from "./api.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import { escapeHtml, prepareAssistantReply, renderAssistantForTelegram, renderAssistantHtml, sanitizeAssistantReply, splitHumanMessages } from "./assistantReply.js";
import { describeError } from "../lib/describeError.js";
/** No sleeps: send sequentially to preserve the model's order. Pending cards use the broker. */
export async function sendAssistantReply(chatId: string, text: string, ctx: {
  scope: "private" | "group";
  fromVoice?: boolean;
  replyTo?: number;
  written: string[];
}): Promise<void> {
  const maskPhones = ctx.scope === "group";
  const plan = prepareAssistantReply(text, maskPhones);
  const parts = splitHumanMessages(plan.text);
  if (parts.length === 0)
    parts.push("");
  const plans = parts.map((part) => prepareAssistantReply(part, maskPhones));
  let canSpeak = ctx.fromVoice === true && plan.language !== "text-only";
  for (const [i, part] of plans.entries()) {
    const written = i === plans.length - 1 ? ctx.written.map((entry) => sanitizeAssistantReply(entry, maskPhones)) : [];
    const replyTo = i === 0 ? ctx.replyTo : undefined;
    if (canSpeak && part.language !== "text-only" && part.speech.length >= 3) {
      const delivered = await sendAssistantVoiceReply(chatId, part.speech, replyTo);
      if (delivered && !part.needsText && ctx.written.length === 0) continue;
      if (!delivered) canSpeak = false;
    }
    const html = [renderAssistantHtml(part.text, { maskPhones }), ...written.map(escapeHtml)].filter(Boolean).join("\n");
    if (html && html.length <= 3900) {
      try {
        await sendHtmlMessage(chatId, html, replyTo);
        continue;
      }
      catch (err) {
        if (!(err instanceof TelegramApiError && err.errorCode === 400 && /can't parse entities/i.test(err.message))) {
          console.warn("[telegram:assistant] HTML: результат доставки не подтверждён, без повтора:", describeError(err));
          return;
        }
      }
    }
    const plain = [renderAssistantForTelegram(part.text, { maskPhones }), ...written].filter(Boolean).join("\n");
    await sendMessage(chatId, plain || "Готово.", replyTo);
  }
}
