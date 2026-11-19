import { BlockBoundary, type BlockContent } from "../BlockBoundary";
import { RhButton } from "./ui";

/** Ширина блока в сетке «Сегодня» на ПК: колонка А, колонка Б или вся строка. */
export type RoyalBlockSpan = "a" | "b" | "wide";

/**
 * Блок главной нового вида за своей границей: упал — «Не загрузилось» и
 * «Повторить», соседи живут. Заглушка встаёт в ту же клетку сетки, что и
 * блок, который она заменяет (`data-span`, правило в theme-look-royal.css).
 */
export function RoyalBlock({ name, span, children }: { name: string; span: RoyalBlockSpan; children: BlockContent }) {
  return (
    <BlockBoundary
      name={name}
      fallback={({ stale, retry, retrying, reload }) => (
        <div className={`ry-block-failed${span === "a" ? " ry-col-a" : span === "b" ? " ry-col-b" : ""}`} data-span={span} data-block={name}>
          <div className="ry-state" role="alert">
            <span>{stale ? "Вышла новая версия" : "Не загрузилось"}</span>
            {stale
              ? <RhButton variant="gray" onClick={reload}>Обновить страницу</RhButton>
              : <RhButton variant="gray" onClick={retry} disabled={retrying} aria-busy={retrying}>Повторить</RhButton>}
          </div>
        </div>
      )}
    >
      {children}
    </BlockBoundary>
  );
}
