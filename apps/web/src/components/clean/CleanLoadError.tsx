import { CButton } from "./ui";

/** A failed section is not an empty queue or a zero financial result. */
export function CleanLoadError({ title, retry }: { title: string; retry: () => unknown }) {
  return <section className="rounded-[20px] bg-card p-5" role="status" aria-label={title}>
    <h2 className="text-[18px] font-semibold text-ink">{title}</h2>
    <p className="text-[16px] text-gray-600">Не загрузилось. Данные этого раздела не подтверждены.</p>
    <CButton variant="soft" onClick={() => void retry()}>Повторить</CButton>
  </section>;
}
