import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";

/**
 * ОБЪЕКТ РАЗГОВОРА ПО ДАННЫМ CRM, А НЕ ПО ДОГАДКЕ («голос рынка», 03.10.2026).
 *
 * Возражения клиентов из `CallAnalysis.objections` ценны по объекту («дорого»,
 * «шумный двор»), но разбор звонка объекта не знал: у самой записи звонка
 * `Interaction.propertyId` обычно пуст, а агрегировалось всё по агенту и компании.
 * Приписать возражение чужой квартире хуже, чем не приписать вовсе — поэтому
 * объект берётся ТОЛЬКО из доказательств, которые CRM уже хранит:
 *
 *   1. `Interaction.propertyId` — объект прямо указан в записи звонка;
 *   2. `Client.matchedPropertyId` — объект, из-за которого этот клиент пришёл
 *      (причина назначения лида, её уже установил код);
 *   3. звонок ПРОДАВЦУ (`Client.kind = SELLER`) и у него РОВНО ОДИН живой объект
 *      (`Property.sellerClientId`): продавец говорит про свою квартиру. Два и больше
 *      объектов — неоднозначно, null.
 *
 * Текст разговора здесь не читается вообще.
 */
export interface CallPropertyFacts {
  interactionPropertyId: string | null;
  matchedPropertyId: string | null;
  clientKind: "BUYER" | "SELLER" | "OTHER" | null;
  /** Живые объекты, заведённые из заявки этого клиента-продавца (достаточно двух: больше — уже неоднозначно). */
  sellerPropertyIds: string[];
}

/** Чистая часть: из фактов — доказанный объект или null. */
export function pickProvenCallProperty(facts: CallPropertyFacts): string | null {
  if (facts.interactionPropertyId) return facts.interactionPropertyId;
  if (facts.matchedPropertyId) return facts.matchedPropertyId;
  if (facts.clientKind === "SELLER" && facts.sellerPropertyIds.length === 1) return facts.sellerPropertyIds[0];
  return null;
}

/**
 * Читает факты по звонку и применяет `pickProvenCallProperty`. Никогда не бросает:
 * вызывается из разбора звонка, и сбой необязательного шага не должен его ронять.
 */
export async function resolveCallPropertyId(interactionId: string): Promise<string | null> {
  try {
    const interaction = await prisma.interaction.findUnique({
      where: { id: interactionId },
      select: {
        propertyId: true,
        client: { select: { id: true, kind: true, matchedPropertyId: true } },
      },
    });
    if (!interaction) return null;
    const client = interaction.client;
    const sellerPropertyIds =
      !interaction.propertyId && !client.matchedPropertyId && client.kind === "SELLER"
        ? (
            await prisma.property.findMany({
              where: { sellerClientId: client.id, deletedAt: null },
              select: { id: true },
              take: 2,
            })
          ).map((p) => p.id)
        : [];
    return pickProvenCallProperty({
      interactionPropertyId: interaction.propertyId,
      matchedPropertyId: client.matchedPropertyId,
      clientKind: client.kind,
      sellerPropertyIds,
    });
  } catch (err) {
    void logSystemError("ai", `Объект звонка не определён: ${describeError(err)}`, {
      dedupKey: "property-voice-call-property",
    });
    return null;
  }
}
