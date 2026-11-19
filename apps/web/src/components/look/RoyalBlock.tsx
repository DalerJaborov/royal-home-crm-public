import { BlockBoundary, type BlockContent } from "../BlockBoundary";
import { RhBlockState } from "./ui";

/** Блок главной нового вида за своей границей: упал — «Не загрузилось» и «Повторить», соседи живут. */
export function RoyalBlock({ name, children }: { name: string; children: BlockContent }) {
  return (
    <BlockBoundary name={name} fallback={(retry) => <div className="ry-block-failed" data-block={name}><RhBlockState kind="error" onRetry={retry} /></div>}>
      {children}
    </BlockBoundary>
  );
}
