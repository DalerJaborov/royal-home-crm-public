import { customerPropertyFocusSchema, type CustomerPropertyEvidence } from "@royal-home/shared";
import type { ConversationPropertySource } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { describeError } from "./describeError.js";
import { linkConversationProperty } from "./propertyVoice/linkConversation.js";
import { logSystemError } from "./systemError.js";

/**
 * ОБЪЕКТ, УЗНАННЫЙ НОВЫМ БОТОМ, — ХОЗЯИНУ ОБЪЕКТА (27.11.2026, владелец: «бот должен узнать объект и по рекламе,
 * и по переписке, и по скриншотам… чтобы агенты не теряли своих клиентов»).
 *
 * Новый бот (CORE, WhatsApp/Instagram/Facebook) узнаёт объект разговора — номер, ссылку, пересланный пост или ролик,
 * скриншот, рекламу — и складывает его в одно место: `BotConversation.customerPropertyFocus`. До этой правки фокус
 * кормил только ответ клиенту: заявка из переписки шла без объекта (кроме рекламы), а связь «диалог ↔ объект»
 * (lib/propertyVoice/linkConversation.ts), которая будит хозяина объекта, новым ботом не писалась вовсе.
 *
 * Здесь две точки, обе за рубильником `chatObjectToOwnerEnabled` (ВЫКЛ — поведение до 27.11):
 *  • `linkResolvedCustomerFocus` — после записи узнанного фокуса: связь «диалог ↔ объект» и уведомление хозяину;
 *  • `customerFocusPropertyForLead` — при оформлении заявки покупателя: объект фокуса идёт в заявку как «назван явно»
 *    (services/leads/assignment.ts::pickByExplicitProperty — там же проверка «продан/снят» и «хозяин отключён»).
 *
 * Продавцу объект фокуса заявку не направляет: он описывает СВОЁ жильё, и похожий наш объект — чужой агент
 * (то же правило, что у рекламы, lib/adPropertyRule.ts, и у звонка).
 */

/** Чем клиент указал на объект — источник связи «диалог ↔ объект» (первое узнавание не перезаписывается). */
export function focusInterestSource(evidence: readonly Pick<CustomerPropertyEvidence, "kind">[]): ConversationPropertySource {
  const kinds = new Set(evidence.map(item => item.kind));
  if (kinds.has("ad")) return "AD_REFERRAL";
  if (kinds.has("url")) return "LISTING_LINK";
  if (kinds.has("media") || kinds.has("reply")) return "SHARED_MEDIA";
  return "NUMBER_IN_TEXT";
}

/** Никогда не бросает: ответ клиенту уже ушёл, связь — след для хозяина и раздачи. */
export async function linkResolvedCustomerFocus(conversationId: string,
  focus: { status: string; propertyId: string | null; evidence: readonly Pick<CustomerPropertyEvidence, "kind">[] }): Promise<void> {
  try {
    if (focus.status !== "resolved" || !focus.propertyId) return;
    if (!await automationSwitchOn("chatObjectToOwnerEnabled")) return;
    await linkConversationProperty({ conversationId, propertyId: focus.propertyId, source: focusInterestSource(focus.evidence) });
  } catch (err) {
    void logSystemError("api", `Объект, узнанный ботом, не связан с перепиской: ${describeError(err)}`, { dedupKey: "customer-focus-owner-link" });
  }
}

/**
 * Объект текущего фокуса переписки для заявки ПОКУПАТЕЛЯ, или null. Фокус берётся той же переписки и той же области
 * (scopeKey), что и заявка; только «узнан» (resolved) — «похожих несколько» и «не найден» заявку не направляют.
 */
export async function customerFocusPropertyForLead(nativeId: string | null | undefined, scopeKey: string): Promise<string | null> {
  if (!nativeId) return null;
  try {
    if (!await automationSwitchOn("chatObjectToOwnerEnabled")) return null;
    const row = await prisma.botConversation.findUnique({ where: { id: nativeId }, select: { customerPropertyFocus: true } });
    const parsed = customerPropertyFocusSchema.safeParse(row?.customerPropertyFocus);
    if (!parsed.success || parsed.data.scopeKey !== scopeKey || parsed.data.status !== "resolved") return null;
    return parsed.data.propertyId;
  } catch (err) {
    // Не прочитали фокус — заявка всё равно создаётся (обычной раздачей), но молча терять нельзя.
    void logSystemError("api", `Объект переписки для заявки не прочитан, заявка уйдёт обычной раздачей: ${describeError(err)}`,
      { dedupKey: "customer-focus-owner-lead" });
    return null;
  }
}
