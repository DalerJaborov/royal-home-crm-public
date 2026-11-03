import { sendHtmlMessage, sendMessage, TelegramApiError } from "./api.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import { escapeHtml, prepareAssistantReply, renderAssistantForTelegram, renderAssistantHtml, splitHumanMessages } from "./assistantReply.js";
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
  if (ctx.fromVoice && plan.language !== "text-only") {
    let spokenAll = true;
    for (const [i, part] of plans.entries()) {
      if (part.speech.length < 3) {
        spokenAll = false;
        continue;
      }
      if (!(await sendAssistantVoiceReply(chatId, part.speech, i === 0 ? ctx.replyTo : undefined))) {
        spokenAll = false;
        break; // Do not spend more on later parts after a provider/delivery failure.
      }
    }
    if (spokenAll && ctx.written.length === 0 && !plan.needsText && plans.every((part) => !part.needsText))
      return;
  }
  for (const [i, part] of plans.entries()) {
    const written = i === plans.length - 1 ? ctx.written : [];
    const replyTo = i === 0 ? ctx.replyTo : undefined;
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
