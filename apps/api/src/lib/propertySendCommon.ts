/**
 * Общая часть отправки объектов собеседнику (26.11.2026): из карточки клиента
 * (routes/clients/matching.ts::send-properties) и прямо из переписки
 * (lib/conversationPropertySend.ts). Вынесено из matching.ts без смены поведения:
 * канал, куда уходит сообщение, мост к журналу показов, запрет проданных и пуш
 * хозяину объекта должны быть одинаковыми в обоих путях, а две копии разошлись бы молча.
 */
import type { DeliveryTarget } from "./conversationDelivery.js";
import { asMetaChannel, isMetaChannelEnabled } from "../messengers/meta.js";
import { isTelegramEnabled } from "../telegram/api.js";
import { loadMatchPolicy } from "./matchPolicy.js";
import { propertyOwnerAgentId, type PropertyOwnerFields } from "./propertyOwner.js";
import { sendPushToAgent } from "../push.js";

/** channel+recipientId для PropertyExposure из адресата доставки — тот же мост
 *  (канал, собеседник), что использует бот в messengers/propertyShowcase.ts.
 *  Telegram — отдельная ветка DeliveryTarget без поля channel, поэтому канал фиксирован строкой. */
export function exposureChannel(target: DeliveryTarget): { channel: string; recipientId: string } {
  return target.kind === "telegram"
    ? { channel: "TELEGRAM", recipientId: target.subscriberId }
    : { channel: target.channel, recipientId: target.subscriberId };
}

export function targetChannel(target: DeliveryTarget): string {
  return target.kind === "telegram" ? "TELEGRAM" : target.channel;
}

export const CHANNEL_WORD: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  TELEGRAM: "Telegram",
  WEBSITE: "чат на сайте",
};

/** Каналы, в которые CRM умеет писать; прочее (старые платформы) — «не поддерживается». */
export const SENDABLE_CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM", "WEBSITE"]);

export async function channelEnabled(target: DeliveryTarget): Promise<boolean> {
  if (target.kind === "telegram") return isTelegramEnabled();
  if (target.channel === "WEBSITE") return true;
  const meta = asMetaChannel(target.channel);
  return meta !== null && (await isMetaChannelEnabled(meta));
}

/** Проданный или снятый с продажи объект клиенту не шлём: ссылка обещала бы то, чего нет. */
export const NOT_OFFERABLE_STATUSES = new Set(["SOLD", "WITHDRAWN"]);

/**
 * ПУШ ХОЗЯИНУ ОБЪЕКТА (17.09.2026): «агент Б не узнаёт, что его объект предложили
 * клиенту агента А». Тот же канал, что у автоподбора; отключается в Настройках
 * (matchNotifyPropertyOwner); ошибка пуша не валит уже успешную отправку.
 */
export async function notifyPropertyOwners(
  properties: (PropertyOwnerFields & { shortId: number; title: string })[],
  senderAgentId: string,
  /** Готовое окончание: «агент Иван предложил его своему клиенту №12» или «… собеседнику в переписке». */
  tail: string
): Promise<void> {
  const policy = await loadMatchPolicy();
  if (!policy.notifyPropertyOwner) return;
  for (const p of properties) {
    const ownerId = propertyOwnerAgentId(p);
    if (!ownerId || ownerId === senderAgentId) continue;
    void sendPushToAgent(ownerId, {
      title: "🏠 Ваш объект предложен клиенту",
      body: `Объект №${p.shortId} — ${p.title}: ${tail}`,
      url: `/properties/${p.shortId}`,
      kind: "look",
    }).catch((err) => console.error("[push] объект предложен чужим агентом:", err));
  }
}
