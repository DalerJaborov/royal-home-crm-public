import { runWhatsappContinuationLink, WHATSAPP_CONTINUATION_LINK_JOB, whatsappContinuationLinkSchema,
  type WhatsappContinuationLink } from "../lib/whatsappContinuation.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import type { JobHandler } from "./registry.js";

/**
 * Клиент пришёл в WhatsApp по ссылке бота из Instagram/Facebook (lib/whatsappContinuation.ts, 25.11.2026): после хода связать
 * обе переписки с одной карточкой. Заявка WhatsApp этого хода ещё оформляется — подождать её. Попытки кончились — тихая
 * запись в журнал: заявку и её тревоги держит сам приём, здесь только связь переписок.
 */
export const whatsappContinuationLinkJob: JobHandler<WhatsappContinuationLink> = {
  type: WHATSAPP_CONTINUATION_LINK_JOB, schema: whatsappContinuationLinkSchema,
  backoff: attempt => Math.min(2 ** attempt, 6) * 5000,
  async run(payload) {
    const result = await runWhatsappContinuationLink(payload);
    if (result.status === "wait") throw new Error(result.reason);
  },
  async onGiveUp(payload) {
    try {
      await runWhatsappContinuationLink(payload, { force: true });
    } catch (err) {
      await logSystemError("background-jobs", `Продолжение из ${payload.sourceChannel === "FACEBOOK" ? "Facebook" : "Instagram"} в WhatsApp: ` +
        `переписки не связаны (диалог ${payload.waConversationId}): ${describeError(err)}`, { dedupKey: `${WHATSAPP_CONTINUATION_LINK_JOB}:${payload.eventKey}` });
    }
  },
};
