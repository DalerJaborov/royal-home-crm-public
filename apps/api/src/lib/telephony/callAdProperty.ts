import { prisma } from "../../db.js";
import { adPropertyForLead } from "../adPropertyRule.js";
import { automationSwitchOn } from "../automationSwitches.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";

/** Сколько дней реклама, с которой клиент пришёл в переписку, ещё говорит о его звонке. */
export const CALL_AD_WINDOW_DAYS = 30;

/**
 * ЗВОНОК КЛИЕНТА С РЕКЛАМЫ ОБЪЕКТА — ХОЗЯИНУ ОБЪЕКТА (27.11.2026, рубильник callAdObjectToOwnerEnabled).
 *
 * Покупатель увидел рекламу квартиры, написал в WhatsApp/Instagram, а потом позвонил в офис и сказал только
 * «я по объявлению». Расшифровка объекта не называет, и заявка уходила снявшему трубку или в очередь. Прежний
 * узнаватель сравнивал внешний id объявления Meta с внутренним `Ad.id` и не находил ничего (убран в #470).
 *
 * Берётся объект, который уже записан в переписку этого клиента при переходе с рекламы
 * (`BotConversation.adPropertyId`: lib/adAttribution.ts, объявление ровно про один объект), если переписка началась
 * не раньше чем за CALL_AD_WINDOW_DAYS дней. Правило «только покупатель, только реклама объекта» — общее
 * (lib/adPropertyRule.ts). Самая свежая такая переписка побеждает. Не бросает: подсказка, а не условие звонка.
 */
export async function recentCallerAdPropertyId(clientId: string, kind: string | null | undefined): Promise<string | null> {
  if (kind !== "BUYER") return null;
  try {
    if (!await automationSwitchOn("callAdObjectToOwnerEnabled")) return null;
    const since = new Date(Date.now() - CALL_AD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const conversation = await prisma.botConversation.findFirst({
      where: { clientId, adPropertyId: { not: null }, createdAt: { gte: since } },
      select: { adPropertyId: true, adTopic: true },
      orderBy: { createdAt: "desc" },
    });
    return conversation ? adPropertyForLead({ kind, adPropertyId: conversation.adPropertyId, adTopic: conversation.adTopic }) : null;
  } catch (err) {
    void logSystemError("api", `Объект рекламы для звонка не прочитан, звонок раздаётся как обычно: ${describeError(err)}`,
      { dedupKey: "call-ad-property" });
    return null;
  }
}
