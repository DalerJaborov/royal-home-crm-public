import { Rh2Screen } from "./Rh2Screen";
import { Card } from "./Card";
import { cx } from "./cx";

/**
 * ЗАГЛУШКА ЗАГРУЗКИ: ОДИН компонент вместо трёх (`components/Skeleton.tsx`,
 * `components/ui/Skeleton.tsx` с `SkeletonBox`, плюс `.sk` из темы).
 *
 * Зачем заглушка в форме будущего содержимого (владелец 20.08.2026): серая
 * строчка «Загрузка…» на пустом экране читалась как «ничего нет» или «сломалось»,
 * а заглушка отвечает сразу на два вопроса, что грузится и сколько там будет, и
 * убирает скачок вёрстки, когда приходят данные.
 *
 * ДВИЖЕНИЯ НЕТ. Контракт 06.10: бесконечных анимаций в интерфейсе нет, поэтому
 * прежнее `animate-pulse` убрано, а `prefers-reduced-motion` соблюдается само
 * собой. Блок статичный и остаётся на месте, пока не придут данные.
 *
 * `className` нужен только для РАЗМЕРА (Tailwind: `h-7 w-48`): габариты вида
 * заданы через `:where()` с нулевым весом и всегда уступают классу снаружи.
 * `width` это процент или px строкой для линии, единственное динамическое
 * значение, поэтому оно идёт через `style`.
 */
export type SkeletonKind = "line" | "avatar" | "tile" | "row";

export function Skeleton({
  kind = "line",
  width,
  className,
}: {
  kind?: SkeletonKind;
  width?: string;
  className?: string;
}) {
  if (kind === "row") {
    return (
      <div aria-hidden className={cx("rh-sk-row", className)}>
        <Skeleton kind="avatar" />
        <div className="rh-sk-lines">
          <Skeleton width="60%" />
          <Skeleton width="40%" className="rh-sk-thin" />
        </div>
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className={cx("rh-sk", kind !== "line" && `rh-sk-${kind}`, className)}
      style={width ? { width } : undefined}
    />
  );
}

/**
 * Заглушка карточки клиента: шапка с кружком и именем, чипы, главная кнопка,
 * два действия, блок текста. Повторяет РАСКЛАДКУ настоящей карточки, иначе
 * появление данных всё равно дёргает экран.
 */
export function ClientCardSkeleton() {
  return (
    <Rh2Screen>
      <div role="status" aria-label="Карточка загружается" className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Skeleton kind="avatar" className="h-14 w-14 flex-none" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="mt-2 h-3 w-28 max-w-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
        <Skeleton kind="tile" className="h-14" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton kind="tile" className="h-11" />
          <Skeleton kind="tile" className="h-11" />
        </div>
        <Card tight>
          <Skeleton className="w-24" />
          <Skeleton className="mt-3 w-full" />
          <Skeleton className="mt-2 w-4/5" />
        </Card>
      </div>
    </Rh2Screen>
  );
}

/**
 * Заглушка карточки объекта: сверху галерея, под ней заголовок с ценой и
 * блоки полей. Форма другая, чем у клиента, потому что и карточка другая:
 * одна заглушка на оба экрана давала бы скачок вёрстки на каждом.
 */
export function PropertyCardSkeleton() {
  return (
    <Rh2Screen>
      <div role="status" aria-label="Карточка объекта загружается" className="flex flex-col gap-4">
        <Skeleton kind="tile" className="aspect-4/3 h-auto w-full sm:aspect-video" />
        <div>
          <Skeleton className="h-5 w-56 max-w-full" />
          <Skeleton className="mt-2 h-4 w-32 max-w-full" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Skeleton kind="tile" className="h-11" />
          <Skeleton kind="tile" className="h-11" />
        </div>
        <Card tight>
          <Skeleton className="w-24" />
          <Skeleton className="mt-3 w-full" />
          <Skeleton className="mt-2 w-3/4" />
        </Card>
      </div>
    </Rh2Screen>
  );
}
