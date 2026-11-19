import { BlockBoundary, type BlockContent } from "../BlockBoundary";
import { CleanLoadError } from "./CleanLoadError";

/** Блок пульта прежнего вида за своей границей: упал — «Не загрузилось» и «Повторить», соседи живут. */
export function CleanBlock({ name, title, children }: { name: string; title: string; children: BlockContent }) {
  return (
    <BlockBoundary name={name} fallback={(retry) => <CleanLoadError title={title} retry={retry} />}>
      {children}
    </BlockBoundary>
  );
}
