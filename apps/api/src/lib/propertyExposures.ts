// Журнал показов объектов клиенту (PropertyExposure). Вынесено из
// messengers/propertyShowcase.ts (31.10.2026) без смены поведения: пользуются
// ручная отправка подборки и первый контакт в WhatsApp, а не только старый чат-движок.
import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { customerTransportInput, resolveCustomerEndpoint, type CustomerTransportHint } from "./customerConversationScope.js";
import { linkConversationPropertiesByChannel } from "./propertyVoice/linkConversation.js";

export type ExposureSource = "MANUAL_NO_CARD";

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
  transport?: CustomerTransportHint,
  /** Откуда показ. MANUAL_NO_CARD — агент отправил объект вручную собеседнику без карточки: правило «свой объект показан» (services/leads/assignment.ts) его не учитывает, пока карточка не привязана. */
  source?: ExposureSource
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
        ...(source ? { source } : {}),
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

/**
 * Привязывает показы этой переписки к появившейся карточке клиента.
 *
 * Вызывается один раз — в момент, когда из разговора родился лид. До этого
 * записи журнала висят на паре (канал, собеседник): бот показывает объекты
 * раньше, чем узнаёт телефон, и именно те, ранние, показы и есть самые ценные —
 * клиент выбирал по ним.
 *
 * Отказ не роняет приём заявки: карточка клиента важнее журнала. Но записать
 * отказ обязательно — без привязки правило «свой объект» промахнётся молча.
 */
export async function linkExposuresToClient(
  channel: string,
  recipientId: string,
  clientId: string,
  transport?: CustomerTransportHint
): Promise<void> {
  try {
    const endpoint = await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport));
    await prisma.propertyExposure.updateMany({
      where: { channel, recipientId, endpointScopeId: endpoint.endpointScopeId, clientId: null },
      data: { clientId },
    });
  } catch (err) {
    void logSystemError("meta", `Показы объектов не привязаны к клиенту: ${describeError(err)}`);
  }
}
