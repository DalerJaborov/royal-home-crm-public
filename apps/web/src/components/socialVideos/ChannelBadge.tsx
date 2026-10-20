import { SOCIAL_VIDEO_CHANNEL_LABELS, SOCIAL_VIDEO_CHANNEL_STATE_LABELS } from "@royal-home/shared";
import type { SocialVideoChannel, SocialVideoChannelState } from "@royal-home/shared";
import { ChannelIcon } from "../ChannelIcon";

/**
 * Значок сети для экрана «Ролики в соцсети»: фирменный знак в мягкой плашке,
 * в углу — точка состояния публикации.
 *
 * Точка не единственный носитель смысла: у неё есть текстовый двойник для
 * чтения с экрана и `title` для наведения. Цвета — токены темы (зелёный /
 * красный / янтарный), а не выдуманные оттенки, поэтому ночная тема работает сама.
 */
export interface ChannelBadgeProps {
  channel: SocialVideoChannel;
  state?: SocialVideoChannelState;
  /** Сторона плашки в пикселях. */
  size?: number;
  /** Подпись адреса вместо названия канала («Instagram · Royal Home Info»). */
  label?: string;
}

/** TikTok и Threads по бренду чёрные — на тёмной теме такой знак пропал бы, поэтому он наследует цвет текста. */
const MONO_CHANNELS: ReadonlySet<SocialVideoChannel> = new Set(["TIKTOK", "THREADS"]);

const DOT_CLASS: Record<SocialVideoChannelState, string> = {
  QUEUED: "bg-gray-400",
  PUBLISHING: "bg-amber motion-safe:animate-pulse",
  PUBLISHED: "bg-green",
  FAILED: "bg-red",
  SKIPPED: "bg-gray-300",
  REMOVED: "bg-gray-400",
};

export function ChannelBadge({ channel, state, size = 36, label: addressLabel }: ChannelBadgeProps) {
  const label = addressLabel ?? SOCIAL_VIDEO_CHANNEL_LABELS[channel];
  const dot = Math.max(10, Math.round(size * 0.3));
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center rounded-[11px] bg-ink/5 text-gray-800"
      style={{ width: size, height: size }}
      title={state ? `${label}: ${SOCIAL_VIDEO_CHANNEL_STATE_LABELS[state]}` : label}
    >
      <ChannelIcon channel={channel} size={Math.round(size * 0.52)} tone={MONO_CHANNELS.has(channel) ? "ink" : "brand"} title={label} />
      {state && (
        <>
          <span
            aria-hidden="true"
            className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-card-solid ${DOT_CLASS[state]}`}
            style={{ width: dot, height: dot }}
          />
          <span className="sr-only">{SOCIAL_VIDEO_CHANNEL_STATE_LABELS[state]}</span>
        </>
      )}
    </span>
  );
}
