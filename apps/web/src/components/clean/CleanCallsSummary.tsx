import type { ReactNode } from "react";
import { CleanLoadError } from "./CleanLoadError";

type Slice = "all" | "outgoing" | "incoming" | "missed" | "problems" | "unqualified";
type Props = {
  today?: { incoming: number; outgoing: number; missed: number };
  averageScore?: number | null;
  unreturnedOnPage?: number;
  agreedNextStep?: number;
  onSlice: (slice: Slice) => void;
  activeSlice?: Slice;
  failed?: boolean;
  loading?: boolean;
  retry?: () => unknown;
};

/** The station counters are daily; analysis scores are monthly. Never mix the periods. */
export function CleanCallsSummary({ today, averageScore, agreedNextStep, unreturnedOnPage = 0, onSlice, activeSlice, failed, loading, retry }: Props) {
  if (failed) return <CleanLoadError title="Сводка звонков" retry={retry ?? (() => {})} />;
  if (loading) return <p role="status">Загружаем сводку звонков…</p>;
  const metrics: { label: string; value: number | string; period: string; slice: Slice }[] = [
    { label: "Входящие", value: today?.incoming ?? "—", period: "Сегодня · Душанбе", slice: "incoming" },
    { label: "Исходящие", value: today?.outgoing ?? "—", period: "Сегодня · Душанбе", slice: "outgoing" },
    { label: "Пропущенные", value: today?.missed ?? "—", period: "Сегодня · Душанбе", slice: "missed" },
    { label: "Качество разговоров", value: averageScore ?? "—", period: "Средний балл · 30 дней", slice: "problems" },
  ];
  return <section data-clean-calls-summary aria-label="Сводка звонков" className="rounded-[20px] border border-line-soft bg-card p-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {metrics.map((metric) => <button key={metric.slice} type="button" aria-pressed={activeSlice === metric.slice} onClick={() => onSlice(metric.slice)} className="rounded-[14px] p-3 text-left transition-colors hover:bg-row-alt focus-visible:outline-2 focus-visible:outline-blue">
        <span className="block text-[14px] text-gray-500">{metric.label}</span>
        <span className="my-1 block text-[28px] font-semibold leading-tight tabular-nums text-ink">{metric.value}</span>
        <span className="block text-[14px] text-gray-500">{metric.period}</span>
      </button>)}
    </div>
    {unreturnedOnPage > 0 && <button type="button" onClick={() => onSlice("missed")} className="mt-2 w-full rounded-[14px] bg-row-alt px-3 py-2 text-left text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-blue">Без перезвона на текущей странице входящих: {unreturnedOnPage}. Открыть пропущенные →</button>}
    {agreedNextStep != null && agreedNextStep < 50 && <button type="button" onClick={() => onSlice("problems")} className="mt-2 w-full rounded-[14px] bg-row-alt px-3 py-2 text-left text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-blue">Следующий шаг согласован в {agreedNextStep}% разговоров за 30 дней. Открыть разбор →</button>}
  </section>;
}

export function CallsInsightsDisclosure({ clean, children }: { clean: boolean; children: ReactNode }) {
  if (!clean) return <>{children}</>;
  return <details className="rounded-[20px] border border-line-soft bg-card px-5 py-3">
    <summary className="cursor-pointer text-[16px] font-semibold text-ink focus-visible:outline-2 focus-visible:outline-blue">Разбор ИИ · где теряем клиентов и что улучшить</summary>
    <div className="pt-4">{children}</div>
  </details>;
}
