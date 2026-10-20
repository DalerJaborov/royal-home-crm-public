import type { ReactNode } from "react";
import { ArrowLeft, CalendarClock, MoreHorizontal, Pencil } from "lucide-react";
import { Link } from "react-router-dom";
import type { Property } from "../../types";
import { formatMoney, formatPricePerSqm } from "../../lib/format";
import { propertyParamChips } from "../../lib/propertyParams";
import { propertyStageChip } from "../../lib/propertyStageChip";
import { Chip } from "../rh2/Chip";
import { CButton, CCard } from "./ui";
import { cleanClientDetailScale } from "./CleanClientDetailLayout";

export const cleanPropertyDetailScale = cleanClientDetailScale;

export function CleanPropertyDetailHeader({ code, place }: { code: string; place: string }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 py-1">
      <Link to="/properties" className="inline-flex min-h-11 items-center gap-2 rounded-full text-[16px] font-semibold focus-visible:outline-2 focus-visible:outline-blue"><ArrowLeft size={20} aria-hidden />Объекты</Link>
      <div className="min-w-0 text-right text-[14px] text-gray-500"><span className="font-semibold text-ink">{code}</span>{place && <p className="mt-1 break-words">{place}</p>}</div>
    </header>
  );
}

/** One controller and gallery; Clean layouts adapt on both phone and desktop. */
export function CleanPropertyDetailLayout({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <div className="rh-pcard" data-testid="property-card">{children}</div>;
  return <div className="clean-property-detail grid grid-cols-1 gap-5 min-[1180px]:grid-cols-[minmax(0,1.2fr)_minmax(320px,.8fr)]" style={cleanClientDetailScale} data-testid="property-card">{children}</div>;
}

export function CleanPropertySlot({ enabled, area, children }: { enabled: boolean; area: "gallery" | "description" | "people" | "work"; children: ReactNode }) {
  if (!children) return null;
  if (!enabled) return <>{children}</>;
  const placement = area === "gallery" ? "[&_.rh-gallery-track]:max-h-[420px] min-[1180px]:col-start-1 min-[1180px]:row-start-1" : area === "description" ? "min-[1180px]:col-start-1 min-[1180px]:row-start-2" : area === "people" ? "min-[1180px]:col-start-2 min-[1180px]:row-start-2" : "min-[1180px]:col-span-2";
  return <div className={`clean-property-slot min-w-0 ${placement}`} data-record-area={area}>{children}</div>;
}

export function CleanPropertySummary({ property, onSchedule, onEdit, onMore, children }: {
  property: Property; onSchedule: (() => void) | null; onEdit: (() => void) | null; onMore: () => void; children?: ReactNode;
}) {
  const stage = propertyStageChip(property);
  const chips = propertyParamChips(property);
  const sub = [Number(property.areaSqm) > 0 ? formatPricePerSqm(property.price, property.areaSqm, property.currency) : null, property.district?.name].filter(Boolean).join(" · ");
  return (
    <CCard className="clean-property-summary border-0 min-[1180px]:col-start-2 min-[1180px]:row-start-1" data-testid="property-price">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><span className="text-[14px] text-gray-500">Стоимость объекта</span><Chip tone={stage.tone} data-testid="property-stage">{stage.label}</Chip></div>
      <p className="font-semibold tracking-[-.03em] text-ink" style={{ margin: 0, fontSize: 34, lineHeight: 1.2 }}>{formatMoney(property.price, property.currency)}</p>
      {sub && <p className="text-gray-500" style={{ margin: "8px 0 0", fontSize: 14 }}>{sub}</p>}
      <h1 className="break-words font-semibold text-ink" style={{ margin: "20px 0 0", fontSize: 26, lineHeight: 1.25 }}>{property.title}</h1>
      {chips.length > 0 && <div className="mt-4 flex flex-wrap gap-2" data-testid="property-params">{chips.map((chip) => <Chip key={chip}>{chip}</Chip>)}</div>}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {onSchedule && <CButton size="lg" onClick={onSchedule}><CalendarClock size={20} aria-hidden />Назначить показ</CButton>}
        {onEdit && <CButton size="lg" variant={onSchedule ? "soft" : "primary"} onClick={onEdit}><Pencil size={20} aria-hidden />Изменить</CButton>}
        <CButton size="lg" variant="soft" onClick={onMore}><MoreHorizontal size={20} aria-hidden />Ещё</CButton>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </CCard>
  );
}

export function CleanPropertyDetailSkeleton() {
  return <div className="grid gap-5 min-[1180px]:grid-cols-[1.2fr_.8fr]" role="status" aria-busy="true" aria-label="Загружаем карточку объекта"><div className="aspect-[4/3] max-h-[420px] rounded-[20px] bg-row-alt" /><CCard className="border-0"><div className="h-8 w-2/3 rounded-lg bg-row-alt" /><div className="mt-5 h-7 w-3/4 rounded-lg bg-row-alt" /><div className="mt-6 h-12 w-48 rounded-full bg-row-alt" /></CCard></div>;
}
