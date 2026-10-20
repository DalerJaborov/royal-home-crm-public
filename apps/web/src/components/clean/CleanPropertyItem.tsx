import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PropertyHealthBrief } from "@royal-home/shared";
import type { Property } from "../../types";
import { formatArea, formatMoney, formatPricePerSqm, STAGE_OWNER_LABELS } from "../../lib/format";
import { formatPropertyCode } from "../../lib/clientFormat";
import { statusChipClass, statusChipLabel } from "../../lib/theme2026";
import { PropertyHealthDot } from "../PropertyHealthDot";
import { PropertyStats } from "../PropertyStats";
import { CButton, CChip, cn } from "./ui";
import { CleanPropertyIllustration } from "./CleanPropertyIllustration";

interface Props {
  property: Property;
  health?: PropertyHealthBrief;
  variant?: "row" | "card";
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onTogglePublish?: (id: string, action: "publish" | "unpublish") => void;
  agentName?: string;
  agentTitle: string;
  floors: string;
  awaitingAcceptance: boolean;
  handoff: { text: string; tone: "warn" | "mute" | "crit" | "ok" }[];
  subline?: ReactNode;
  band?: ReactNode;
}

/** The catalog passes permission-filtered callbacks and the existing owner's/status data. */
export function CleanPropertyItem({ property: p, health, variant = "row", selected, onToggleSelect, onTogglePublish, agentName, agentTitle, floors, awaitingAcceptance, handoff, subline, band }: Props) {
  const card = variant === "card";
  const photo = p.photos[0]?.thumbUrl || p.photos[0]?.url;
  const originalPhoto = p.photos[0]?.url;
  return (
    <article data-property-row="" data-list-row data-property-layout={variant} className={cn("relative min-w-0 overflow-hidden rounded-[20px] bg-card", card ? "flex flex-col" : "mb-3 flex items-start gap-5 p-4", band && !card && "flex-wrap", selected && "ring-2 ring-inset ring-blue")}>
      {onToggleSelect && <label className={cn("relative z-10 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[14px] bg-card", card ? "absolute left-2 top-2" : "-ml-2")}><input type="checkbox" checked={!!selected} onChange={() => onToggleSelect(p.id)} aria-label={`Выбрать объект: ${p.title}`} className="size-5 accent-blue" /></label>}
      <div className={cn("clean-property-thumbnail relative flex shrink-0 items-center justify-center overflow-hidden bg-row-alt", card ? "aspect-[16/10] w-full" : "h-28 w-36 rounded-[14px]")}>
        <PropertyThumbnail key={`${photo ?? "empty"}:${originalPhoto ?? ""}`} photo={photo} alternate={originalPhoto} card={card} />
        {p.photos.length > 0 && <span className="absolute top-2 right-2 rounded-full bg-card px-2 py-1 text-[13px] text-ink">Фото: {p.photos.length}</span>}
      </div>
      <div className={cn("min-w-0 flex-1", card && "p-5")}>
        <div className="relative flex min-h-11 flex-wrap items-center gap-2 text-[14px] text-gray-500"><PropertyHealthDot health={health} /><span>{formatPropertyCode(p.shortId)}</span><span className={statusChipClass(p.status, p.pipeline)}>{statusChipLabel(p.status, p.pipeline)}</span>{p.publishedOnSite && <CChip tone="ok">На сайте</CChip>}</div>
        <h2 className="mt-2 break-words text-[18px] font-semibold text-ink">{p.title}</h2>
        <p className="mt-1 break-words text-[14px] text-gray-500">{p.district?.name ?? "Район не указан"}{p.address ? ` · ${p.address}` : ""} · {formatArea(p.areaSqm)} м²{floors}</p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"><strong className="text-[20px] font-semibold text-ink">{formatMoney(p.price, p.currency)}</strong><span className="text-[14px] text-gray-500">{formatPricePerSqm(p.price, p.areaSqm, p.currency)}</span></div>
        <div className="mt-3 flex min-h-11 items-center"><PropertyStats property={p} /></div>
        {subline && <div className="clean-property-subline mt-2 text-[14px] text-gray-500">{subline}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {awaitingAcceptance && <CChip tone="warn">Передан вам · примите</CChip>}
          {handoff.map((item) => <CChip key={item.text} tone={item.tone === "mute" ? "gray" : item.tone}>{item.text}</CChip>)}
        </div>
        {p.pipeline?.overdue && !subline && <p className="mt-3 text-[14px] text-red">{STAGE_OWNER_LABELS[p.pipeline.owner ?? ""] ?? p.pipeline.owner ?? "Этап"} задерживает объект: {p.pipeline.daysInStage} дн. при сроке {p.pipeline.limitDays ?? "не задан"}.</p>}
        <div className="relative z-10 mt-4 flex flex-wrap items-center justify-between gap-3">
          <span title={agentTitle} className="text-[14px] text-gray-500">{agentName || "Без агента"}</span>
          <div className="flex flex-wrap items-center gap-2">
            {onTogglePublish && (p.publishedOnSite || p.status === "AVAILABLE") && <CButton variant="outline" size="sm" onClick={() => onTogglePublish(p.id, p.publishedOnSite ? "unpublish" : "publish")}>{p.publishedOnSite ? "Снять с сайта" : "Опубликовать"}</CButton>}
            <span aria-hidden="true" className="text-blue">Открыть →</span>
          </div>
        </div>
      </div>
      {band && <div className={cn("clean-property-band relative z-10 flex w-full basis-full flex-wrap items-center gap-2", card && "px-5 pb-5")}>{band}</div>}
      <Link to={`/properties/${p.shortId}`} aria-label={`Открыть объект: ${p.title}`} className="absolute inset-0 z-0 rounded-[20px] focus-visible:outline-[3px] focus-visible:outline-blue focus-visible:-outline-offset-4" />
    </article>
  );
}

function PropertyThumbnail({ photo, alternate, card }: { photo?: string; alternate?: string; card: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const candidates = [...new Set([photo, alternate].filter((url): url is string => !!url))];
  const source = candidates[attempt];
  return source
    ? <img src={source} alt="" loading="lazy" decoding="async" onError={() => setAttempt((value) => value + 1)} className="h-full w-full object-cover" />
    : <span className="flex flex-col items-center gap-1 text-gray-500"><CleanPropertyIllustration size={card ? 112 : 64} /><span className="text-[14px]">{photo ? "Фото недоступно" : "Нет фото"}</span></span>;
}
