import type { ReactNode } from "react";

/**
 * Пустой экран с иллюстрацией.
 *
 * «Данных нет» — это тупик: человек видит пустоту и не понимает, сломалось оно
 * или так и должно быть. Здесь всегда три вещи: рисунок, объяснение почему пусто
 * и одно действие, с которого начать. Иллюстрации нарисованы линиями в текущей
 * палитре темы, поэтому переключение темы их не ломает и в сборку не тянется
 * ни одной картинки.
 */

type Illustration = "properties" | "clients" | "deals" | "search" | "calendar" | "keys" | "done";

const stroke = { fill: "none", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Art({ kind }: { kind: Illustration }) {
  const accent = "var(--c-chart-1, rgb(var(--rgb-accent)))";
  const line = "rgb(var(--rgb-g300))";

  switch (kind) {
    case "properties":
      return (
        <svg viewBox="0 0 120 96" className="w-[132px] h-auto" aria-hidden="true">
          <g stroke={line} {...stroke}>
            <path d="M14 84V44l22-16 22 16v40" />
            <path d="M26 84V64h20v20" />
            <path d="M8 46 36 25l28 21" />
          </g>
          <g stroke={accent} {...stroke}>
            <path d="M66 84V52l20-14 20 14v32" />
            <rect x="76" y="58" width="10" height="10" rx="2" />
            <rect x="92" y="58" width="10" height="10" rx="2" />
            <path d="M82 84V72h12v12" />
          </g>
          <path d="M4 84h112" stroke={line} {...stroke} />
        </svg>
      );
    case "clients":
      return (
        <svg viewBox="0 0 120 96" className="w-[132px] h-auto" aria-hidden="true">
          <g stroke={line} {...stroke}>
            <circle cx="32" cy="38" r="11" />
            <path d="M12 76a20 20 0 0 1 40 0" />
            <circle cx="94" cy="42" r="9" />
            <path d="M78 76a16 16 0 0 1 32 0" />
          </g>
          <g stroke={accent} {...stroke}>
            <circle cx="63" cy="32" r="13" />
            <path d="M40 78a23 23 0 0 1 46 0" />
          </g>
        </svg>
      );
    case "deals":
      return (
        <svg viewBox="0 0 120 96" className="w-[132px] h-auto" aria-hidden="true">
          <g stroke={line} {...stroke}>
            <rect x="10" y="26" width="30" height="52" rx="5" />
            <rect x="46" y="26" width="30" height="52" rx="5" />
          </g>
          <g stroke={accent} {...stroke}>
            <rect x="82" y="26" width="30" height="52" rx="5" />
            <path d="m90 50 6 6 12-13" />
          </g>
          <g stroke={line} {...stroke}>
            <path d="M16 38h18M16 46h12M52 38h18M52 46h12" />
          </g>
        </svg>
      );
    case "search":
      return (
        <svg viewBox="0 0 120 96" className="w-[132px] h-auto" aria-hidden="true">
          <g stroke={line} {...stroke}>
            <circle cx="52" cy="42" r="26" />
            <path d="m72 62 22 22" />
          </g>
          <g stroke={accent} {...stroke}>
            <path d="M42 42h20M52 32v20" opacity=".55" />
            <circle cx="52" cy="42" r="26" strokeDasharray="6 10" />
          </g>
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 120 96" className="w-[132px] h-auto" aria-hidden="true">
          <g stroke={line} {...stroke}>
            <rect x="20" y="20" width="80" height="60" rx="7" />
            <path d="M20 38h80M38 14v12M82 14v12" />
          </g>
          <g stroke={accent} {...stroke}>
            <rect x="32" y="48" width="14" height="12" rx="3" />
            <rect x="53" y="48" width="14" height="12" rx="3" opacity=".45" />
            <rect x="74" y="48" width="14" height="12" rx="3" opacity=".45" />
          </g>
        </svg>
      );
    case "keys":
      return (
        <svg viewBox="0 0 120 96" className="w-[132px] h-auto" aria-hidden="true">
          <g stroke={accent} {...stroke}>
            <circle cx="42" cy="40" r="16" />
            <path d="m54 52 26 26M70 68l8-8M78 76l8-8" />
          </g>
          <path d="M14 86h92" stroke={line} {...stroke} />
        </svg>
      );
    case "done":
      return (
        <svg viewBox="0 0 120 96" className="w-[132px] h-auto" aria-hidden="true">
          <circle cx="60" cy="48" r="30" stroke={line} {...stroke} />
          <path d="m46 48 10 11 20-23" stroke={accent} {...stroke} strokeWidth={2.4} />
        </svg>
      );
  }
}

/**
 * Пустой БЛОК внутри карточки — одной строкой, без иллюстрации.
 *
 * Рисунок уместен на пустом ЭКРАНЕ; в списке расходов или задач внутри карточки
 * он был бы шумом. Но и разнобой не нужен: до 13.08.2026 такие строки писались
 * руками в полутора десятках мест тремя разными кеглями (13, 13.5, 14) и с
 * разными отступами — из этого и складывались «двадцать девять размеров текста»
 * в разборе интерфейса. Один компонент — один вид.
 */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-[15px] leading-relaxed text-gray-400">{children}</p>;
}

export function EmptyState({
  illustration = "search",
  title,
  hint,
  action,
  compact = false,
}: {
  illustration?: Illustration;
  /** Что произошло — одной строкой, без «упс» и извинений. */
  title: string;
  /** Почему пусто и что это значит. */
  hint?: string;
  /** Одно действие, с которого начать. */
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center text-center ${compact ? "py-7 px-4 gap-2.5" : "py-12 px-6 gap-3.5"}`}
    >
      <Art kind={illustration} />
      <div className="max-w-[46ch]">
        <p className="text-[15px] font-semibold text-gray-800">{title}</p>
        {hint && <p className="text-[15px] text-gray-500 leading-relaxed mt-1">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
