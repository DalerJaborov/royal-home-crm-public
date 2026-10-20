import { lazy, Suspense, useSyncExternalStore } from "react";
import { getDraftReminder, subscribeDraftReminder } from "../lib/draftReminder";
import { isBusy, subscribe } from "../lib/workGuard";

/**
 * ЕДИНЫЙ УКАЗАТЕЛЬ ДОЛГОЙ РАБОТЫ — виден с ЛЮБОГО экрана, в том числе на
 * `/properties/new`, куда AppLayout (а с ним UploadIndicator) не доходит
 * (владелец 07.10.2026: «он видел процесс, а не просто что-то идёт в фоне»).
 *
 * Оболочка крошечная и держится в главном бандле: она слушает реестр работы
 * (lib/workGuard.ts) и флаг «есть незавершённый черновик объекта»
 * (lib/draftReminder.ts). Тело — с очередью мастера, сжатием снимков и пр. —
 * подгружается лениво, ровно когда есть что показать.
 */
const WorkIndicatorBody = lazy(() => import("./WorkIndicatorBody"));

export function WorkIndicator() {
  const busy = useSyncExternalStore(subscribe, isBusy, () => false);
  const hasDraft = useSyncExternalStore(subscribeDraftReminder, getDraftReminder, () => false);
  if (!busy && !hasDraft) return null;
  return (
    <Suspense fallback={null}>
      <WorkIndicatorBody />
    </Suspense>
  );
}
