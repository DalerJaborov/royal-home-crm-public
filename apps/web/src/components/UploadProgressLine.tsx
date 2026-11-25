import { useEffect, useRef, type CSSProperties } from "react";
import { useNow } from "../hooks/useNow";
import { createSpeedMeter, formatUploadLive, livePercent, type UploadLive } from "../lib/upload/progressText";
import { KEEP_SCREEN_ON_HINT } from "../lib/upload/wakeLock";

/**
 * ОДНА СТРОКА ПРОГРЕССА ЗАГРУЗКИ НА ВСЕ ЭКРАНЫ (25.11.2026, находка 12).
 *
 * Владелец: «человек ВСЕГДА видит сколько МБ из скольки, скорость, оставшееся время, что
 * случилось и ПОЧЕМУ, и есть „Повторить“». Раньше это умела только строка очереди карточки
 * (UploadTaskRow); короткий ролик, монтажёр, чат и соцсети показывали голые «N %».
 *
 * Скорость считает сама строка по движению байт (скользящее окно ~5 с) — вызывающему
 * достаточно отдавать `loaded/total` и фазу. Текст — чистой функцией formatUploadLive
 * (lib/upload/progressText.ts), там же тесты.
 *
 * Стили — инлайном на токенах темы с запасными значениями: строка живёт и в эталонных
 * карточках `.rh2`, и в пузыре чата, и в разделе соцсетей, у каждого свой набор классов.
 */
/**
 * Скорость по движению байт и «сейчас» для отсчёта. Отдельным хуком — им пользуются и
 * строки, у которых своя разметка (плитка ролика в мастере, StepMedia.tsx).
 */
export function useUploadSpeed(loaded: number, active: boolean, tick = false): { speed: number | null; now: number } {
  const meter = useRef(createSpeedMeter());
  useEffect(() => {
    if (active) meter.current.push(loaded);
    else meter.current.reset();
  }, [loaded, active]);
  // Секундный тик — только пока есть что считать: скорость и отсчёт до повтора.
  const now = useNow(active || tick);
  return { speed: active ? meter.current.speed(now) : null, now };
}

export function UploadProgressLine({
  live,
  onRetry,
  onCancel,
  keepAwakeHint = false,
  bar = true,
  style,
}: {
  /** false — у экрана своя полоса, нужна только строка. */
  bar?: boolean;
  live: UploadLive;
  /** Показать «Повторить» (только у остановленной загрузки). */
  onRetry?: () => void;
  /** Показать «Отменить» (пока загрузка идёт или ждёт). */
  onCancel?: () => void;
  /** Подсказка «Не блокируйте экран…» — для роликов, пока байты идут. */
  keepAwakeHint?: boolean;
  style?: CSSProperties;
}) {
  const { speed, now } = useUploadSpeed(live.loaded, live.phase === "uploading", live.phase === "waiting-retry");
  const percent = livePercent(live);
  const failed = live.phase === "failed";
  const text = formatUploadLive(live, speed, now);
  const showBar = bar && live.phase !== "failed" && live.phase !== "done";

  return (
    <div role="status" aria-live="polite" style={{ display: "grid", gap: 6, minWidth: 0, ...style }}>
      {showBar && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Загрузка файла"
          style={{ height: 6, borderRadius: 999, background: "var(--track, rgba(127,127,127,.25))", overflow: "hidden" }}
        >
          <i
            style={{
              display: "block",
              height: "100%",
              width: `${percent}%`,
              borderRadius: 999,
              background: live.phase === "waiting-online" || live.phase === "waiting-retry" ? "var(--warn-dot, #d99a00)" : "var(--accent, currentColor)",
              transition: "width .3s ease",
            }}
          />
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px", fontSize: 13, lineHeight: 1.4 }}>
        <span
          style={{
            flex: "1 1 12em",
            minWidth: 0,
            fontVariantNumeric: "tabular-nums",
            color: failed ? "var(--crit, #c0392b)" : "inherit",
            overflowWrap: "anywhere",
          }}
        >
          {showBar && live.phase !== "processing" ? `${percent}% · ` : ""}
          {text}
        </span>
        {onRetry && (
          <button type="button" className="lnk" onClick={onRetry} style={{ fontSize: 13, minHeight: 32 }}>
            Повторить
          </button>
        )}
        {onCancel && (
          <button type="button" className="lnk" onClick={onCancel} style={{ fontSize: 13, minHeight: 32 }}>
            Отменить
          </button>
        )}
      </div>
      {keepAwakeHint && (live.phase === "uploading" || live.phase === "preparing") && (
        <span style={{ fontSize: 13, opacity: 0.8 }}>{KEEP_SCREEN_ON_HINT}</span>
      )}
    </div>
  );
}
