import { Children, type ReactNode } from "react";
import { Plus, SlidersHorizontal } from "lucide-react";
import { formatMoney } from "../../lib/format";
import { CButton, CCard } from "./ui";

export function CleanDealsHeader({ teamWide, filterName, onCreate, onFilter }: {
  teamWide: boolean; filterName?: string; onCreate: (() => void) | null; onFilter: (() => void) | null;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4" style={{ width: "100%" }}>
      <div className="min-w-0"><h1 style={{ fontSize: 28, margin: 0, lineHeight: 1.25 }}>Сделки</h1><p style={{ fontSize: 14, margin: "8px 0 0", color: "rgb(var(--rgb-g500))" }}>{filterName ? `Агент: ${filterName}` : teamWide ? "Сделки всей команды" : "Ваши сделки"} · этапы, согласование и документы</p></div>
      <div className="flex flex-wrap items-center gap-2">
        {onFilter && <CButton size="lg" variant="soft" onClick={onFilter}><SlidersHorizontal size={20} aria-hidden />Фильтры</CButton>}
        {onCreate && <CButton size="lg" onClick={onCreate}><Plus size={20} aria-hidden />Новая сделка</CButton>}
      </div>
    </header>
  );
}

export function CleanDealsSummary({ ready, activeCount, approvalCount, closedCount, commissionTjs, seesMoney }: {
  ready: boolean; activeCount: number; approvalCount: number; closedCount: number; commissionTjs: number; seesMoney: boolean;
}) {
  const values = [
    { label: "В работе", value: activeCount },
    { label: "На согласовании", value: approvalCount },
    { label: "Закрыто за месяц", value: closedCount },
    ...(seesMoney ? [{ label: "Комиссия за месяц", value: formatMoney(commissionTjs, "TJS") }] : []),
  ];
  return (
    <CCard className="border-0" role="region" aria-label="Сводка сделок">
      <div className={`grid grid-cols-2 gap-5 ${seesMoney ? "min-[1180px]:grid-cols-4" : "min-[1180px]:grid-cols-3"}`}>
        {values.map(({ label, value }) => <div key={label} className="min-w-0"><p style={{ margin: 0, fontSize: 14, color: "rgb(var(--rgb-g500))" }}>{label}</p><p style={{ margin: "8px 0 0", fontSize: 28, fontWeight: 600, lineHeight: 1.25, overflowWrap: "anywhere" }}>{ready ? value : "—"}</p></div>)}
      </div>
      <p style={{ margin: "14px 0 0", fontSize: 14, color: "rgb(var(--rgb-g500))" }}>{ready ? "По загруженным сделкам текущего фильтра. Месяц — по времени Душанбе." : "Сводка появится после загрузки сделок."}</p>
    </CCard>
  );
}

/** Keep all real approval actions mounted; only additional rows start collapsed. */
export function CleanDealsApprovalRows({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  const rows = Children.toArray(children);
  return <div>{rows.slice(0, 3)}{rows.length > 3 && <details><summary className="min-h-11 cursor-pointer py-3 text-[16px] font-semibold text-blue focus-visible:outline-2 focus-visible:outline-blue">Ещё {rows.length - 3} на согласовании</summary>{rows.slice(3)}</details>}</div>;
}

export function CleanDealsGuide({ canMove }: { canMove: boolean }) {
  return <details className="rounded-[18px] bg-row-alt px-5 py-2"><summary className="min-h-11 cursor-pointer py-3 text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-blue">Как работать с доской</summary><p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.6 }}>Карточка открывает клиента. {canMove && "Перетащите её в соседний этап или используйте стрелки. "}Документы доступны внутри карточки.{canMove && " Там же можно отправить сделку на закрытие."} Этап сделки и статус клиента меняются независимо.</p></details>;
}
