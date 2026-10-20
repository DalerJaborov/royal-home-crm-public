import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { AlertTriangle, FilePenLine, UploadCloud } from "lucide-react";
import { pluralizeRu } from "@royal-home/shared";
import { useDraftMedia, summarizeDraftMedia } from "../hooks/useDraftMedia";
import { useUploadSummary } from "../hooks/useUploadQueue";
import { describeDraftProgress } from "../lib/draftProgressLabel";

/**
 * Тело единого указателя (см. WorkIndicator.tsx).
 *
 *  • ЧЕРНОВИК ОБЪЕКТА. Пока у агента есть незавершённый черновик «Новый объект»
 *    (на сервере или в очереди файлов), постоянная плашка с «Продолжить»:
 *    «Черновик объекта: файлы 3 из 5», а когда всё доехало — «Черновик объекта
 *    ждёт». Агент может закрыть мастер в любой момент до «Сохранить», пойти за
 *    информацией и вернуться; плашка — напоминание, если забыл (владелец
 *    07.10.2026). Не показывается в самом мастере: там те же файлы уже видны
 *    плитками и финальным экраном.
 *  • ОЧЕРЕДЬ КАРТОЧКИ объекта показывается ТОЛЬКО на `/properties/new`: на
 *    остальных экранах её рисует UploadIndicator в AppLayout, и два указателя с
 *    одним текстом — дубль.
 *
 * Фиксированная плашка над нижним меню на телефоне и в углу на компьютере: ни
 * верхняя панель, ни `.wfoot` мастера не заняты. Один компонент на оба размера;
 * подпись ≥13px, `role="status"` и `aria-live="polite"`.
 */
export function WorkIndicatorBody() {
  const { pathname } = useLocation();
  const inWizard = pathname === "/properties/new";
  const items = useDraftMedia();
  const summary = useMemo(() => summarizeDraftMedia(items), [items]);
  const queue = useUploadSummary();

  let label: string | null = null;
  let detail: string | null = null;
  let failed = false;
  let showBar = false;
  let percent = 0;
  let resumeLink = false;

  if (inWizard) {
    if (queue.active) {
      failed = queue.failed > 0;
      label = failed
        ? `Файлы объекта не ушли: ${queue.failed}`
        : `Загружаем ${queue.files} ${queue.files === 1 ? "файл" : "файлов"}${queue.uploading ? ` · ${queue.percent}%` : ""}`;
      showBar = !failed && queue.uploading;
      percent = queue.percent;
    }
  } else if (summary.pending > 0) {
    label = `Черновик объекта: файлы ${summary.ready} из ${items.length}`;
    detail = describeDraftProgress(items);
    showBar = true;
    percent = summary.percent;
    resumeLink = true;
  } else if (summary.failed > 0) {
    failed = true;
    label = `Черновик объекта: не загрузилось ${summary.failed} ${pluralizeRu(summary.failed, ["файл", "файла", "файлов"])}`;
    resumeLink = true;
  } else {
    label = "Черновик объекта ждёт";
    resumeLink = true;
  }

  if (!label) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="work-indicator"
      className="fixed inset-x-3 z-40 rounded-xl border border-line bg-card-solid px-4 py-2.5 shadow-lg md:inset-x-auto md:right-4 md:w-[380px]"
      style={{ bottom: "calc(86px + env(safe-area-inset-bottom, 0px))" }}
    >
      <div className="flex items-center gap-2 text-[15px]">
        {failed ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-red" aria-hidden />
        ) : showBar ? (
          <UploadCloud className="h-4 w-4 shrink-0 text-blue" aria-hidden />
        ) : (
          <FilePenLine className="h-4 w-4 shrink-0 text-blue" aria-hidden />
        )}
        <span className={"min-w-0 flex-1 truncate font-medium" + (failed ? " text-red" : "")}>{label}</span>
        {resumeLink && (
          <Link
            to="/properties/new?draft=continue"
            data-testid="work-indicator-continue"
            className="shrink-0 text-[14px] font-semibold text-blue"
          >
            Продолжить
          </Link>
        )}
      </div>
      {detail && <div className="mt-0.5 truncate text-[13px] text-gray-500">{detail}</div>}
      {showBar && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-blue transition-[width] duration-200" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

export default WorkIndicatorBody;
