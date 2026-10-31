// Журнал показов объектов клиенту (PropertyExposure). Вынесено из
// messengers/propertyShowcase.ts (31.10.2026) без смены поведения: пользуются
// ручная отправка подборки и первый контакт в WhatsApp, а не только старый чат-движок.
import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { customerTransportInput, resolveCustomerEndpoint, type CustomerTransportHint } from "./customerConversationScope.js";
import { linkConversationPropertiesByChannel } from "./propertyVoice/linkConversation.js";

/**
 * ТО ЖЕ САМОЕ, НО НА ПАЧКУ ОБЪЕКТОВ ОДНИМ ЗАПРОСОМ (22.09.2026, сведение N+1) —
 * `routes/clients/matching.ts::send-properties` зовёт recordExposure по разу
 * на каждый выбранный объект (пусть и через `Promise.all` — всё равно N вставок
 * на одну отправку подборки). Используется ТОЛЬКО там, где отказ записи по
 * одному объекту равнозначен отказу по всей пачке (единая ручная отправка), —
 * recordExposure выше (по одному, каждый со своим try/catch) остаётся для
 * бота, который показывает объекты не разом.
 */
export async function recordExposures(
  channel: string,
  recipientId: string,
  items: { propertyId: string; shortId: number; kind: "PHOTO" | "LINK" }[],
  clientId?: string,
  transport?: CustomerTransportHint
): Promise<void> {
  if (items.length === 0) return;
  try {
    const endpoint = await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport));
    await prisma.propertyExposure.createMany({
      data: items.map((it) => ({
        channel,
        recipientId,
        propertyId: it.propertyId,
        shortId: it.shortId,
        kind: it.kind,
        clientId,
        endpointScopeId: endpoint.endpointScopeId,
      })),
    });
    void linkConversationPropertiesByChannel({
      channel,
      recipientId,
      transport: endpoint,
      propertyIds: items.map((it) => it.propertyId),
      source: "EXPOSURE",
    });
  } catch (err) {
    void logSystemError(
      "meta",
      `Показы объектов (${items.map((it) => it.shortId).join(", ")}) не записаны в журнал: ${describeError(err)}`
    );
  }
}
