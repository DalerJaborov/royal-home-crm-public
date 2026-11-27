import { prisma } from "../../db.js";
import { adPropertyForLead } from "../adPropertyRule.js";
import { automationSwitchOn } from "../automationSwitches.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";

/** Сколько дней реклама, с которой клиент пришёл в переписку, ещё говорит о его звонке. */
export const CALL_AD_WINDOW_DAYS = 14;

/**
 * ЗВОНОК КЛИЕНТА С РЕКЛАМЫ ОБЪЕКТА — ХОЗЯИНУ ОБЪЕКТА (27.11.2026, рубильник callAdObjectToOwnerEnabled).
 *
 * Покупатель увидел рекламу квартиры, написал в WhatsApp/Instagram, а потом позвонил в офис и сказал только
 * «я по объявлению». Расшифровка объекта не называет, и заявка уходила снявшему трубку или в очередь. Прежний
 * узнаватель сравнивал внешний id объявления Meta с внутренним `Ad.id` и не находил ничего (убран в #470).
 *
 * Берётся объект, который уже записан в переписку этого клиента при переходе с рекламы
 * (`BotConversation.adPropertyId`: lib/adAttribution.ts, объявление ровно про один объект), если переписка началась
 * в которой клиент писал не раньше чем за CALL_AD_WINDOW_DAYS дней. Снявшего трубку реклама перебивает, только если
 * клиент в звонке сам сказал «по объявлению / по рекламе» (qualifyIncoming.ts): иначе это лишь догадка. Правило «только покупатель, только реклама объекта» — общее
 * (lib/adPropertyRule.ts). Самая свежая такая переписка побеждает. Не бросает: подсказка, а не условие звонка.
 */
export async function recentCallerAdPropertyId(clientId: string, kind: string | null | undefined): Promise<string | null> {
  if (kind !== "BUYER") return null;
  try {
    if (!await automationSwitchOn("callAdObjectToOwnerEnabled")) return null;
    const since = new Date(Date.now() - CALL_AD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // Свежесть — по последнему сообщению переписки (ревью 27.11): объект рекламы может лечь и в старую переписку
    // (lib/adAttribution.ts пишет его, пока поле пустое), так что createdAt — не время перехода с рекламы.
    const conversation = await prisma.botConversation.findFirst({
      where: { clientId, adPropertyId: { not: null },
        OR: [{ lastMessageAt: { gte: since } }, { lastMessageAt: null, createdAt: { gte: since } }] },
      select: { adPropertyId: true, adTopic: true },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    });
    return conversation ? adPropertyForLead({ kind, adPropertyId: conversation.adPropertyId, adTopic: conversation.adTopic }) : null;
  } catch (err) {
    void logSystemError("api", `Объект рекламы для звонка не прочитан, звонок раздаётся как обычно: ${describeError(err)}`,
      { dedupKey: "call-ad-property" });
    return null;
  }
}
