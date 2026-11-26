/**
 * Pure decision «this customer turn gets no text reply» — split out of messengers/replyChain.ts (17.11.2026) so the staff alert
 * (lib/clientWaitingAlert.ts) can read the same rule without importing the channel reply chain (import cycle
 * legacyQualifyDoor → channelStaffAlert → clientWaitingAlert → replyChain → legacyQualifyDoor). replyChain re-exports it.
 */
import type { ChatMessage } from "../ai/client.js";
import { guardFired } from "../ai/guardMetrics.js";
import { ackReactionTurn, lastBotSpeech } from "../ai/ackTurnDoor.js";
import { shouldStaySilentOnBareShare } from "../ai/bareShareRepeat.js";
import { photoAlreadyAcknowledged } from "../ai/photoAckGuard.js";

/**
 * ХОД, НА КОТОРЫЙ БОТ НЕ ОТВЕЧАЕТ ТЕКСТОМ (владелец 25.09.2026; аудит audit-1,
 * находка 8). Те же три отсечки, что в messengers/conversation.ts, — общими
 * функциями стражей, а не копией:
 *  - «Ок» / «Рахмат» после нашей реплики БЕЗ вопроса — только реакция
 *    (ai/ackOnly.ts): на «Ок» бот писал «Саломат бошед! Агар савол бошад, нависед»;
 *  - третья голая пересылка подряд — молчим (ai/bareShareRepeat.ts);
 *  - ещё фото без слов, а «фото получили» уже сказано — молчим (ai/photoAckGuard.ts).
 * Каналы без своей ветки на эти случаи (Telegram, Direct Messages) зовут это ДО
 * хода модели. Реплика клиента к этому моменту уже в переписке, агент её видит.
 */
export function silentTurnReason(input: {
  /** Слова клиента этого хода (склеенная пачка). */
  text: string;
  /** В ходе было вложение (фото, файл, голос) — тогда это не «ок». */
  hasMedia: boolean;
  /** Переписка ДО этого хода. */
  history: ChatMessage[];
}): "ack_only" | "bare_share_repeat" | "photo_ack_repeat" | null {
  const lastBot = [...input.history].reverse().find((m) => m.role === "assistant");
  // Одна дверь «ок / спасибо / пока → реакция» (ai/ackTurnDoor.ts) — та же, что у старого пути Meta и у ядра.
  const botLine = lastBotSpeech(input.history);
  if (ackReactionTurn({ text: input.text, hasMedia: input.hasMedia, lastBotText: botLine?.text, lastBotAt: botLine?.at })) {
    guardFired("ack_only");
    return "ack_only";
  }
  if (!input.hasMedia && shouldStaySilentOnBareShare(input.text, input.history)) {
    guardFired("bare_share_repeat");
    return "bare_share_repeat";
  }
  if (photoAlreadyAcknowledged(input.text, lastBot)) {
    guardFired("photo_ack_repeat");
    return "photo_ack_repeat";
  }
  return null;
}
