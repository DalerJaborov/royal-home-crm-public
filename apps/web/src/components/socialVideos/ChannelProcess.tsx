import { AlertCircle, CheckCircle2, Clock, ExternalLink, Hourglass, Loader2, MinusCircle, RotateCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { SOCIAL_VIDEO_CHANNEL_STATE_LABELS, destinationKeyOf } from "@royal-home/shared";
import type {
  SocialVideoChannelInfo,
  SocialVideoChannelResult,
  SocialVideoChannelState,
  SocialVideoDestination,
  SocialVideoItem,
} from "@royal-home/shared";
import { exactDateTime } from "../../lib/format";
import { INTERRUPTED_RETRY_WARNING, destinationLabel, isInterruptedResult, resultOfDestination } from "../../lib/socialVideoDestinations";
import { ChannelBadge } from "./ChannelBadge";
import { socialVideoErrorHint } from "../../lib/socialVideoErrorHint";

/**
 * «Процесс» публикации: вертикальная лента по каналам.
 *
 * Для каждой сети видно, на каком она шаге, а при ошибке — ТЕКСТ ошибки крупно
 * и что с ней делать. Два вида отказа различаются намеренно: `retriable` —
 * площадка просит подождать (это не поломка, красный цвет тут соврал бы), всё
 * остальное — ошибка, которую надо прочитать.
 *
 * Строка — один АДРЕС («Instagram · Royal Home Info»), результат ищется по ключу
 * адреса; у старых роликов ключ без суффикса. Повторить можно упавший и
 * пропущенный адрес.
 *
 * Компонент управляемый: сам ничего не запрашивает, повтор отдаёт наружу.
 */
export interface ChannelProcessProps {
  destinations: SocialVideoDestination[];
  /** Справочник каналов — названия аккаунтов для подписей. */
  infos: SocialVideoChannelInfo[];
  results: SocialVideoItem["results"];
  onRetryDestination?(d: SocialVideoDestination): void;
  compact?: boolean;
}

const STATE_CHIP: Record<SocialVideoChannelState, string> = {
  QUEUED: "bg-ink/5 text-gray-600",
  PUBLISHING: "bg-amber-bg text-amber",
  PUBLISHED: "bg-green-bg text-green",
  FAILED: "bg-red-bg text-red",
  SKIPPED: "bg-ink/5 text-gray-600",
  REMOVED: "bg-ink/5 text-gray-600",
};

function StateIcon({ state, retriable }: { state: SocialVideoChannelState; retriable: boolean }) {
  switch (state) {
    case "QUEUED":
      return <Clock size={14} aria-hidden="true" />;
    case "PUBLISHING":
      return <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />;
    case "PUBLISHED":
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case "FAILED":
      return retriable ? <Hourglass size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />;
    case "SKIPPED":
      return <MinusCircle size={14} aria-hidden="true" />;
    case "REMOVED":
      return <Trash2 size={14} aria-hidden="true" />;
  }
}

function timeOf(r: SocialVideoChannelResult): string | null {
  const at = r.finishedAt ?? r.startedAt;
  return at ? exactDateTime(at) : null;
}

function Step({
  destination,
  label,
  result,
  onRetry,
  compact,
  isLast,
}: {
  destination: SocialVideoDestination;
  label: string;
  result: SocialVideoChannelResult | undefined;
  onRetry?: () => void;
  compact: boolean;
  isLast: boolean;
}) {
  const channel = destination.channel;
  const state: SocialVideoChannelState = result?.state ?? "QUEUED";
  const retriable = Boolean(result?.retriable) && state === "FAILED";
  const chipClass = retriable ? "bg-amber-bg text-amber" : STATE_CHIP[state];
  const stateText = retriable ? "Нужно подождать" : result ? SOCIAL_VIDEO_CHANNEL_STATE_LABELS[state] : "Ждёт запуска";
  const time = result ? timeOf(result) : null;

  let body: ReactNode = null;
  if (result?.state === "FAILED") {
    body = (
      <div
        role={retriable ? "status" : "alert"}
        className={`mt-2 rounded-lg px-3 py-2.5 ${retriable ? "bg-amber-bg text-amber" : "bg-red-bg text-red"}`}
      >
        {result.error && <p className={`m-0 font-semibold leading-snug ${compact ? "text-[14px]" : "text-[15px]"}`}>{result.error}</p>}
        {!compact && <p className="m-0 mt-1 text-[13px] leading-snug opacity-90">{socialVideoErrorHint(retriable, result?.error)}</p>}
        {isInterruptedResult(result) && <p className="m-0 mt-1 text-[13px] font-semibold leading-snug">{INTERRUPTED_RETRY_WARNING}</p>}
      </div>
    );
  } else if (result?.state === "SKIPPED" && result.error) {
    body = <p className="m-0 mt-1 text-[14px] leading-snug text-gray-600">{result.error}</p>;
  } else if (result?.state === "PUBLISHED" && result.url) {
    body = (
      <a
        href={result.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-blue/10 px-3 text-[14px] font-semibold text-blue no-underline hover:bg-blue/20"
      >
        <ExternalLink size={14} aria-hidden="true" />
        Открыть пост: {label}
      </a>
    );
  }

  return (
    <li className={`relative flex gap-3 ${isLast ? "" : "pb-4"}`}>
      {/* Соединительная линия между шагами; у последнего её нет. */}
      {!isLast && <span aria-hidden="true" className="absolute bottom-0 top-10 w-px bg-line" style={{ left: compact ? 15.5 : 17.5 }} />}
      <ChannelBadge channel={channel} state={state} size={compact ? 32 : 36} label={label} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className={`min-w-0 break-words font-semibold text-gray-800 ${compact ? "text-[14px]" : "text-[15px]"}`}>{label}</span>
          <span className={`inline-flex items-center gap-1.5 rounded-[14px] px-2.5 py-0.5 text-[13px] font-semibold ${chipClass}`}>
            <StateIcon state={state} retriable={retriable} />
            {stateText}
          </span>
          {time && <span className="text-[13px] text-gray-500">{time}</span>}
          {result && result.attempts > 1 && <span className="text-[13px] text-gray-500">попыток: {result.attempts}</span>}
        </div>
        {result?.note && <p className="m-0 mt-1 text-[13px] leading-snug text-gray-500">{result.note}</p>}
        {body}
        {(result?.state === "FAILED" || result?.state === "SKIPPED") && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2! inline-flex! min-h-[38px]! items-center! gap-1.5! rounded-lg! border! border-line! bg-card-solid! px-3! text-[14px]! font-semibold! text-gray-800! hover:bg-hover-tint!"
          >
            <RotateCw size={14} aria-hidden="true" />
            Повторить: {label}
          </button>
        )}
      </div>
    </li>
  );
}

export function ChannelProcess({ destinations, infos, results, onRetryDestination, compact = false }: ChannelProcessProps) {
  if (destinations.length === 0) {
    return <p className="m-0 text-[14px] text-gray-500">Каналы не выбраны.</p>;
  }
  return (
    <ol className="m-0 list-none p-0" aria-label="Ход публикации по адресам">
      {destinations.map((d, i) => (
        <Step
          key={destinationKeyOf(d)}
          destination={d}
          label={destinationLabel(d, infos)}
          result={resultOfDestination(results, d)}
          compact={compact}
          isLast={i === destinations.length - 1}
          onRetry={onRetryDestination ? () => onRetryDestination(d) : undefined}
        />
      ))}
    </ol>
  );
}
