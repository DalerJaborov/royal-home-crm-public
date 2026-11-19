import { BlockBoundary, type BlockContent } from "../BlockBoundary";
import { CleanLoadError } from "./CleanLoadError";
import { CButton } from "./ui";

/** Блок пульта прежнего вида за своей границей: упал — «Не загрузилось» и «Повторить», соседи живут. */
export function CleanBlock({ name, title, children }: { name: string; title: string; children: BlockContent }) {
  return (
    <BlockBoundary
      name={name}
      fallback={({ stale, retry, retrying, reload }) => stale ? (
        <section className="rounded-[20px] bg-card p-5" role="status" aria-label={title}>
          <h2 className="text-[18px] font-semibold text-ink">{title}</h2>
          <p className="text-[16px] text-gray-600">Вышла новая версия приложения. Обновите страницу.</p>
          <CButton variant="soft" onClick={reload}>Обновить страницу</CButton>
        </section>
      ) : <CleanLoadError title={title} retry={retry} busy={retrying} />}
    >
      {children}
    </BlockBoundary>
  );
}
