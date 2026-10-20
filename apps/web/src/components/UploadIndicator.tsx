import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronDown, ChevronUp, UploadCloud, WifiOff } from "lucide-react";
import { useNow } from "../hooks/useNow";
import { useUploadQueue, useUploadSummary } from "../hooks/useUploadQueue";
import { UploadTaskRow } from "./UploadTaskRow";
import { Rh2Inline } from "./rh2/Rh2Scope";

/**
 * Общий указатель загрузки — виден с ЛЮБОГО экрана, пока очередь не пуста.
 *
 * ЗАЧЕМ. Список внутри карточки объекта человек видит, только пока стоит на этой
 * карточке. А загрузка тридцати снимков идёт минутами, и всё это время агент
 * работает дальше: открывает клиента, звонит, заводит показ. Без указателя он не
 * знает ни что файлы ещё идут, ни что часть не ушла, — и решает, что всё
 * пропало. Требование владельца 15.08.2026: «чтобы полосу загрузки, ошибки и
 * весь процесс видеть где-нибудь внизу или наверху».
 *
 * ГДЕ. Липкой полосой сразу под верхней панелью: она не уезжает при прокрутке и
 * не спорит за место с нижним меню, круглой кнопкой ассистента и полосой
 * обновления — там уже тесно, а этот указатель висит не секунды, а минуты.
 * top-14 — высота верхней панели (Topbar, sticky top-0 h-14).
 *
 * Свёрнут — одна строка: сколько файлов идёт и сколько процентов. Развёрнут —
 * те же строки, что и в карточке, с кнопками «повторить» и «убрать».
 */
/** Секунд до следующей попытки — округляем вверх, чтобы «0 с» не мелькало
 *  за миг до самого повтора. */
function secondsUntil(ts: number): number {
  return Math.max(1, Math.ceil((ts - Date.now()) / 1000));
}

export function UploadIndicator() {
  const [open, setOpen] = useState(false);
  const summary = useUploadSummary();
  const { tasks, activeId, activeLoaded, activeTotal, activeSpeedBps, offline, nextAttemptAt, lastError } = useUploadQueue();

  // Обратный отсчёт в тексте бэкоффа обновляется сам — без этого баннер писал
  // бы «повторим через 20 с» неизменно все 20 секунд, до следующего события
  // очереди (найдено при разборе честности баннера, 17.09.2026).
  useNow(nextAttemptAt != null);

  if (!summary.active) return null;

  const hasFailed = summary.failed > 0;
  const backingOff = !hasFailed && !offline && nextAttemptAt != null;

  return (
    <div data-upload-indicator className="sticky top-14 z-20 mx-0 border-b border-line bg-card-solid px-4 py-2 md:px-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-[15px]"
      >
        {hasFailed ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-red" />
        ) : offline ? (
          <WifiOff className="h-4 w-4 shrink-0 text-gray-400" />
        ) : (
          <UploadCloud className="h-4 w-4 shrink-0 text-blue" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {hasFailed ? (
            // Попытки исчерпаны (или отказ не повторяемый) — то же самое «не
            // ушло», что и раньше: тут баннер не врал, трогать нечего.
            <span className="text-red">
              Не ушло: {summary.failed}, нажмите, чтобы повторить
            </span>
          ) : offline ? (
            // Настоящий офлайн — единственный случай для «ждём связи»: раньше
            // эту же фразу показывал и бэкофф после 500 при живом Wi-Fi
            // (баг из отчёта агента, объект №95, 16.09.2026).
            <>
              Загружаем {summary.files} {summary.files === 1 ? "файл" : "файлов"} · ждём связи
            </>
          ) : backingOff ? (
            // Текст ошибки — тот же, что видно в строке задания (UploadTaskRow
            // показывает task.error): один источник правды на оба места.
            <>
              {lastError ?? "Не ушло, повторим ещё раз"} · повторим через {secondsUntil(nextAttemptAt!)} с
            </>
          ) : (
            <>
              Загружаем {summary.files} {summary.files === 1 ? "файл" : "файлов"}
              {summary.uploading ? ` · ${summary.percent}%` : ""}
            </>
          )}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-gray-400" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
        )}
      </button>

      {/* Тонкая полоса под строкой — движение видно и не разворачивая список. */}
      {!hasFailed && summary.uploading && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-blue transition-[width] duration-200"
            style={{ width: `${summary.percent}%` }}
          />
        </div>
      )}

      {open && (
        // Строки очереди перенесены на классы эталона и рисуются только внутри
        // области `.rh2`; сама полоса указателя — часть рамки приложения и
        // остаётся на прежнем оформлении (см. Rh2Scope.tsx).
        <Rh2Inline className="mt-2 max-h-64 overflow-y-auto">
          <div className="list">
          {tasks.map((task) => {
            const active = task.id === activeId && task.status === "uploading";
            return (
              <UploadTaskRow
                key={task.id}
                task={task}
                active={active}
                percent={active && activeTotal > 0 ? Math.round((activeLoaded / activeTotal) * 100) : 0}
                loadedBytes={active ? activeLoaded : undefined}
                speedBps={active ? activeSpeedBps : undefined}
                note={task.propertyShortId ? `объект №${task.propertyShortId}` : undefined}
              />
            );
          })}
          {/* Уйти к объекту, чтобы посмотреть, что уже долетело. Ведём к первому:
              обычно вся очередь — это одна карточка, которую агент только что и заполнял. */}
          {tasks[0]?.propertyShortId && (
            <Link
              to={`/properties/${tasks[0].propertyShortId}`}
              onClick={() => setOpen(false)}
              className="lnk"
            >
              Открыть объект №{tasks[0].propertyShortId}
            </Link>
          )}
          </div>
        </Rh2Inline>
      )}
    </div>
  );
}
