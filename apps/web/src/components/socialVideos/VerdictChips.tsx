import { AlertTriangle, Check, X } from "lucide-react";
import { SOCIAL_VIDEO_CHANNEL_LABELS } from "@royal-home/shared";
import type { ChannelVerdict, SocialVideoChannel, SocialVideoVerdictLevel } from "@royal-home/shared";
import { ChannelIcon } from "../ChannelIcon";

/**
 * Чипы «канал + пригодность ролика» — для списка роликов и шагов композитора.
 *
 * Смысл несут ТРИ вещи сразу: цвет плашки, значок (галочка / треугольник /
 * крестик) и текст для экранного диктора. Цвета одного не хватает — часть людей
 * не отличает красный от зелёного, а в списке чипы мелкие.
 */
export interface VerdictChipsProps {
  verdicts: ChannelVerdict[];
  /** Если передан — выбранные каналы подсвечены, остальные приглушены. */
  selected?: SocialVideoChannel[];
}

const LEVEL_TEXT: Record<SocialVideoVerdictLevel, string> = {
  OK: "подходит",
  WARN: "подходит с оговорками",
  BLOCK: "не подходит",
};

const LEVEL_CLASS: Record<SocialVideoVerdictLevel, string> = {
  OK: "bg-green-bg text-green",
  WARN: "bg-amber-bg text-amber",
  BLOCK: "bg-red-bg text-red",
};

function LevelIcon({ level }: { level: SocialVideoVerdictLevel }) {
  if (level === "OK") return <Check size={14} strokeWidth={2.6} aria-hidden="true" />;
  if (level === "WARN") return <AlertTriangle size={14} strokeWidth={2.4} aria-hidden="true" />;
  return <X size={14} strokeWidth={2.6} aria-hidden="true" />;
}

export function VerdictChips({ verdicts, selected }: VerdictChipsProps) {
  if (verdicts.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Пригодность ролика по каналам">
      {verdicts.map((v) => {
        const label = SOCIAL_VIDEO_CHANNEL_LABELS[v.channel];
        const dimmed = selected !== undefined && !selected.includes(v.channel);
        const reasons = [...v.blockers, ...v.warnings];
        return (
          <li
            key={v.channel}
            title={reasons.length > 0 ? reasons.join("\n") : `${label}: ${LEVEL_TEXT[v.level]}, формат «${v.format}»`}
            className={`inline-flex min-h-[30px] items-center gap-1.5 rounded-[14px] px-2.5 py-1 text-[13px] font-semibold ${LEVEL_CLASS[v.level]} ${
              dimmed ? "opacity-55" : ""
            }`}
          >
            <ChannelIcon channel={v.channel} size={14} tone="ink" title={label} />
            <span>{label}</span>
            <LevelIcon level={v.level} />
            <span className="sr-only">
              {LEVEL_TEXT[v.level]}
              {reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
