import { PultActions } from "../../components/pult/PultActions";
import { Toaster } from "../../components/ui/Toaster";

/**
 * Дев-стенд задачи L2-T6 (только `import.meta.env.DEV`, маршрут внутри
 * ProtectedRoute — нужна настоящая сессия директора и реальный API, в
 * отличие от `PultTilesPlayground`/`EventFeedPlayground`, у которых фикстуры
 * без сети). Показывает `PultActions` как есть, поверх реального
 * `/dashboard/mission-control` — здесь проверяется вживую «клик → мутация →
 * useUndoToast» из отчёта `docs/pult/theme-2026/reports/L2-T6.md`.
 *
 * `<Toaster/>` монтируется здесь локально: примитив (`components/ui/Toaster.tsx`,
 * задача 1) существует, но нигде в `App.tsx`/`AppLayout` не смонтирован ни для
 * одной темы — сама строка-действие и так меняет состояние на «Одобрено ·
 * отменить 10 с» и без этого (стор `useUndoToastStore` не зависит от
 * подписчика), но всплывающий тост с видимой кнопкой «Отменить» без монтажа
 * не появляется нигде в приложении. Общий монтаж — за задачей 8 (сведение),
 * не за этой; см. отчёт L2-T6, раздел «Расхождения».
 */
export function PultActionsPlayground() {
  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Дев-стенд: строки-действия пульта (L2-T6)</h1>
      <PultActions />
      <Toaster />
    </div>
  );
}
