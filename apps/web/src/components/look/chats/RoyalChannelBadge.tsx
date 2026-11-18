import { channelMeta } from "../../../lib/channelMeta";
import { RoyalBrandIcon } from "../RoyalIcon";
import type { RoyalBrandName } from "../royalIconData";

/** Каналы с родным знаком в наборе нового вида; остальные — значок из channelMeta. */
const BRAND: Record<string, RoyalBrandName> = {
  WHATSAPP: "whatsapp",
  INSTAGRAM: "instagram",
  TELEGRAM: "telegram",
  TELEGRAM_DIRECT: "telegram",
};

/**
 * Метка канала в уголке аватара — в РОДНЫХ цветах площадки (закон вида:
 * соцсети в своих цветах). Канал по-прежнему назван словами в aria-label и
 * title: цвет здесь не единственный носитель смысла.
 */
export function RoyalChannelBadge({ channel }: { channel: string | null | undefined }) {
  const meta = channelMeta(channel);
  const brand = channel ? BRAND[channel] : undefined;
  const Icon = meta.icon;
  return (
    <span className="ry-chat-ch" data-channel={channel ?? "NONE"} role="img" aria-label={`Канал: ${meta.label}`} title={meta.label}>
      {brand ? <RoyalBrandIcon name={brand} size={14} /> : <Icon className="ry-chat-ch-i" aria-hidden="true" />}
    </span>
  );
}
