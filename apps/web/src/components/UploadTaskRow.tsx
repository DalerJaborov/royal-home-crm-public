import type { CSSProperties } from "react";
import { Clock, Loader2, RotateCcw, X } from "lucide-react";
import { useNow } from "../hooks/useNow";
import { removeTask, retryTask, type UploadTaskView } from "../lib/uploadQueue";
import { formatActiveUploadLine, formatRetryCountdown, formatUploadSize } from "../lib/uploadFormat";

/** Живёт теперь в uploadFormat.ts (чистая функция формата, тестируется без
 *  браузера) — реэкспорт, чтобы StepMedia.tsx/StepReview.tsx не переписывать. */
export { formatUploadSize };

/**
 * Одно задание очереди строкой.
 *
 * Общая и для списка внутри карточки объекта, и для общего указателя в шапке:
 * два разных вида одного и того же состояния рано или поздно разъезжаются, и
 * человек видит в одном месте «идёт», а в другом «не ушло».
 *
 * ОБЛИК — строка `.row` эталона с полосой `.loadbar` (та самая, что показывает
 * загруженность агента в «Команде»). Отказ помечается точкой `.dot.crit`, а не
 * цветом подписи: правило `.rh2 .row .t span` весит больше `.state.err` и всё
 * равно перекрасило бы её в серый.
 *
 * ⚠️ КОНТРАКТ: рисуется ТОЛЬКО внутри области темы `.rh2`. Весь эталонный CSS
 * ограничен этим классом, поэтому строка, вставленная за его пределами, выйдет
 * голым текстом — молча, без единой ошибки сборки или теста. Оба вызывающих
 * места (`UploadQueueList`, `UploadIndicator`) открывают область сами; третьему
 * придётся сделать то же самое.
 */
/** Секунд до следующей попытки, округлённое вверх — «0 с» не должно мелькнуть
 *  за миг до самого повтора (тот же приём, что и в баннере UploadIndicator). */
function secondsUntil(ts: number | undefined): number {
  if (!ts) return 0;
  return Math.max(1, Math.ceil((ts - Date.now()) / 1000));
}

export function UploadTaskRow({
  task,
  active,
  percent,
  loadedBytes,
  note,
  speedBps,
}: {
  task: UploadTaskView;
  /** Это задание отправляется прямо сейчас. */
  active: boolean;
  percent: number;
  /** Отдано байт активного задания — точнее, чем реконструировать из percent
   *  (округлённого до целого процента), для строки «4,2 МБ из 183». */
  loadedBytes?: number;
  /** Приписка под строкой — например, к какому объекту относится файл. */
  note?: string;
  /** Скользящая скорость активного задания (uploadQueue.ts, computeSpeedBps) —
   *  `null`/не передано, пока данных мало (первые доли секунды отправки). */
  speedBps?: number | null;
}) {
  const failed = task.status === "failed";
  /**
   * ПОЧЕМУ ЖДЁМ, А НЕ ПРОСТО «ЖДЁМ». Задание с повторяемым отказом (0, 5xx, 429 —
   * см. uploadQueue.ts) возвращается в состояние "pending", и строка показывала
   * ровно то же, что у ещё не начатого файла: «уйдёт само, приложение можно
   * закрыть». Причину сервера очередь при этом сохраняла в task.error и никому не
   * показывала. Отказ вроде «Хранилище видео не настроено» (503) повторяется
   * вечно и сам не пройдёт — агент час считал, что видео загружается, хотя оно
   * не уходило ни разу. Ошибку показываем, как только попытка была и провалилась.
   */
  const retrying = !failed && !active && task.attempts > 0 && !!task.error;

  /**
   * Живой обратный отсчёт до повтора (23.09.2026) — до этого ожидающее после
   * обрыва задание показывало то же «в очереди», что и файл, который ещё
   * никто не пытался отправить, и агент читал это как «застряло». Тикает
   * только пока реально есть что отсчитывать: `nextAttemptAt` у задания без
   * единой попытки нет вовсе (см. StoredTask.nextAttemptAt).
   */
  useNow(retrying && !!task.nextAttemptAt);

  const activeLine = `${formatActiveUploadLine(task.totalBytes, loadedBytes ?? Math.round((task.totalBytes * percent) / 100), speedBps ?? null)}${note ? ` · ${note}` : ""}`;
  const retryLine =
    retrying && task.nextAttemptAt
      ? formatRetryCountdown(task.error ?? "Связь прервалась", task.nextAttemptAt)
      : retrying
        ? `${task.error}, попытка ${task.attempts}, повторим автоматически`
        : null;

  return (
    <div className="row">
      {failed ? (
        <span className="dot crit" aria-hidden />
      ) : active ? (
        <Loader2 className="i" aria-hidden />
      ) : (
        <Clock className="i" aria-hidden />
      )}
      <div className="t">
        <b>{task.label}</b>
        <span>
          {failed
            ? task.error || "не ушло"
            : active
              ? `${activeLine}`
              : `${formatUploadSize(task.totalBytes)}${note ? ` · ${note}` : ""}${
                  retryLine
                    ? ` · ${retryLine}`
                    : " · можно закрыть — продолжится, когда снова откроете CRM"
                }`}
        </span>
      </div>

      {/* Полоса заполнения — только у того задания, что уходит прямо сейчас:
          у ожидающих показывать нечего, а пустая полоса читается как «застряло». */}
      {active && (
        <span className="loadbar">
          <span className="bar">
            {/* Заполнение задаётся переменной `--v` (масштаб 0..1), а не
                шириной: полоса эталона рисуется через scaleX. */}
            <i style={{ "--v": Math.max(0, Math.min(1, percent / 100)) } as CSSProperties} />
          </span>
          <span className="n">{percent}%</span>
        </span>
      )}
      {!active && (
        <span className="meta">
          {failed ? "не ушло" : retryLine ? `повтор через ${secondsUntil(task.nextAttemptAt)} с` : "в очереди"}
        </span>
      )}

      {/* Кнопки нужны и повторяющемуся заданию: отказ вроде «Хранилище видео не
          настроено» не пройдёт никогда, и без «убрать» агент оставался с вечным
          указателем загрузки, который нечем закрыть. */}
      {(failed || retrying) && (
        <span className="act">
          <button
            type="button"
            onClick={() => void retryTask(task.id)}
            aria-label="Попробовать ещё раз"
            title="Попробовать ещё раз"
            className="call"
          >
            <RotateCcw className="i" />
          </button>
          <button
            type="button"
            onClick={() => void removeTask(task.id)}
            aria-label="Убрать из очереди"
            title="Убрать из очереди"
            className="call"
          >
            <X className="i" />
          </button>
        </span>
      )}
    </div>
  );
}
