import { prisma } from "../db.js";
import { runQualifyTurn, type QualifyTurnOptions } from "../ai/leadQualifier.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { EMPTY_TOPIC_STATE } from "../ai/topicLock.js";
import { aiDailyBudgetOf, spendAiTurns } from "../lib/aiDailyBudget.js";
import { refreshCustomerQualifierProjection, type ScopedCustomerQualifierLane } from "../lib/customerQualifierContext.js";
import { recordScopedCustomerInput, appendScopedCustomerReply } from "../lib/customerQualifierLedger.js";
import { repeatBlockedTexts } from "../lib/outboundShield.js";
import { finalizeBotReply, inClientLanguage } from "./replyChain.js";
import type { MessengerTurnInput, MessengerTurnResult } from "./turnTypes.js";

const HELD: MessengerTurnResult = { reply: "", ready: false, accepted: false, shouldReply: false, silenced: "held" };
const NO_EFFECT = { ru: "Запрос пока не оформлен.", tg: "Дархост ҳоло сабт нашудааст." };

/** Temporary read-only invocation adapter for the existing qualifier/reply
 * chain. It has no legacy intake, profile memory, media send or action executor.
 * P14 replaces this seam; compat continues through the original controller. */
export async function processScopedCustomerQualifierTurn(input: MessengerTurnInput, initial: ScopedCustomerQualifierLane): Promise<MessengerTurnResult> {
  try { return await invokeScopedCustomerQualifier(input, initial); }
  catch (error) {
    console.error("[customer-qualifier] read invocation unavailable:", error instanceof Error ? error.name : "UnknownError");
    return { ...HELD };
  }
}
async function invokeScopedCustomerQualifier(input: MessengerTurnInput, initial: ScopedCustomerQualifierLane): Promise<MessengerTurnResult> {
  if (!await recordScopedCustomerInput(input, initial.authenticatedInput, initial.ticket)) return { ...HELD };
  if (input.silent || input.fromStaff) return { ...HELD };
  const pinned = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey: initial.ticket.eventKey },
    select: { intakeAgentRevisionId: true } });
  // The durable worker owns this original turn. Returning no inline reply
  // prevents a second legacy model/send path while that worker is running.
  if (pinned?.intakeAgentRevisionId) return { ...HELD };
  let lane = initial;
  const refresh = async (): Promise<boolean> => {
    const current = await refreshCustomerQualifierProjection(lane);
    if (current.status !== "current") return false;
    lane = { ...lane, context: current.context };
    return true;
  };
  if (!await refresh()) return { ...HELD };
  const text = lane.context.history[0]?.content ?? "";
  // This initial adapter consumes authenticated text only. Media/ASR adapters
  // must bind their interpretation explicitly before they can enter P14.
  if (!text.trim()) return { ...HELD };
  const budgetRow = await prisma.botConversation.findUnique({ where: { id: lane.ticket.conversationId }, select: {
    id: true, aiBudgetDate: true, aiTurnsToday: true, aiVoiceToday: true, aiPhotoToday: true,
    aiVideoToday: true, aiDocToday: true, aiLimitNoticeAt: true,
  } });
  if (!budgetRow || !await refresh()) return { ...HELD };
  const budget = aiDailyBudgetOf({ ...budgetRow, clientId: null });
  if (budget.turnsLeft <= 0) return { ...HELD };
  const options = (): QualifyTurnOptions => ({
    customerContext: lane.context, contactProfile: null, phoneKnown: lane.context.knownPhoneSource !== "none",
    accountId: lane.principal.scope.accountId, channel: input.channel, conversationId: lane.ticket.conversationId,
    abilities: { showings: false, callback: false, askOwner: false, vacancies: false,
      links: true, cautious: true, promptEconomy: true },
    topic: { settings: { enabled: false, driftTurns: 1 }, state: { ...EMPTY_TOPIC_STATE } },
  });
  if (!input.retryOfPaidTurn) await spendAiTurns(lane.ticket.conversationId, budget.dayKey);
  if (!await refresh()) return { ...HELD };
  const result = await runQualifyTurn([...lane.context.history], { ...lane.context.draft }, options());
  if (!await refresh()) return { ...HELD };
  if (!result) return { ...HELD, aiUnavailable: true };
  const blockedAction = !!(result.askOwner || result.callbackRequest || result.jobApplication ||
    result.showPropertyNumber || result.sendGuide || result.showing);
  const filtered = await finalizeBotReply({
    reply: blockedAction ? [inClientLanguage(NO_EFFECT, text)] : result.reply,
    conversationId: lane.ticket.conversationId, channelLabel: input.channel, openUrl: `/messages?open=${lane.ticket.conversationId}`,
    botSpokeBefore: false, botSaidBefore: [], clientSaidTrusted: stripUntrusted(text, ["document", "video"]),
    clientTurnText: text, previousBotText: "", language: detectClientLanguage(text),
    draft: { stage: "chatting" }, jobConversation: false, phoneAsksSent: 0,
    phoneKnown: lane.context.knownPhoneSource !== "none", topicState: { ...EMPTY_TOPIC_STATE },
    fallbackLanguageWords: [text],
  }, {
    // A regeneration is the same read-only call, with the same original proof.
    regenerate: blockedAction ? undefined : async retryDirective => {
      if (!await refresh()) return null;
      const retry = await runQualifyTurn([...lane.context.history], { ...lane.context.draft }, { ...options(), retryDirective });
      if (!await refresh() || !retry) return null;
      return retry.askOwner || retry.callbackRequest || retry.jobApplication || retry.showPropertyNumber || retry.sendGuide || retry.showing
        ? [inClientLanguage(NO_EFFECT, text)] : retry.reply;
    },
    shieldBlocked: bubbles => repeatBlockedTexts(input.channel, input.subscriberId, bubbles, undefined, input.customerTransport),
  });
  if (!await refresh() || !filtered.bubbles.length) return { ...HELD };
  const [reply, reply2] = filtered.bubbles;
  if (!await appendScopedCustomerReply(lane, [reply, reply2].filter(Boolean).join("\n"), input.messageId)) return { ...HELD };
  const response: MessengerTurnResult = { reply, ...(reply2 ? { reply2 } : {}), ready: false, accepted: false };
  Object.defineProperty(response, "customerReplyPrincipal", { value: lane.principal, enumerable: false, writable: false, configurable: false });
  return response;
}
