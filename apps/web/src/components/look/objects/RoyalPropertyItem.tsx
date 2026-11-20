import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PropertyHealthBrief } from "@royal-home/shared";
import type { Property } from "../../../types";
import { formatArea, formatMoney, formatPricePerSqm, STAGE_OWNER_LABELS } from "../../../lib/format";
import { formatPropertyCode } from "../../../lib/clientFormat";

import { useAuthStore } from "../../../store/auth";
import { PropertyHealthDot } from "../../PropertyHealthDot";
import { PropertyPhoto } from "../../property/PropertyPhoto";
import { PropertyStats } from "../../PropertyStats";
import { RhAvatar } from "../ui";
import { ObjIcon } from "./ObjIcon";
import { propertyStagePill, TONE_ICON, type ObjTone } from "./objectTone";

/**
 * КАРТОЧКА ОБЪЕКТА В СПИСКЕ — «Новый вид» (облик royal, 18.11.2026).
 *
 * Тот же набор данных и действий, что у CleanPropertyItem (одна строка
 * каталога): галочка выбора, «Опубликовать / Снять с сайта», чипы монтажа,
 * «Передан вам», просрочка этапа, полоса экрана-хозяина, растянутая ссылка на
 * карточку. Меняется только раскладка по макету: фото — главное, на фото
 * пилюля состояния, ниже цена крупно, название, адрес, кто ведёт.
 * Плитка или строка — решает CSS по ширине списка и `data-layout`.
 */
export interface RoyalPropertyItemProps {
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

export function ObjStatusPill({ tone, label, testId }: { tone: ObjTone; label: string; testId?: string }) {
  const icon = TONE_ICON[tone];
  return (
    <span className="ry-obj-pill" data-tone={tone} data-testid={testId}>
      {icon && <ObjIcon name={icon} size={16} />}
      {label}
    </span>
  );
}

export function RoyalPropertyItem({ property: p, health, variant = "card", selected, onToggleSelect, onTogglePublish, agentName, agentTitle, floors, awaitingAcceptance, handoff, subline, band }: RoyalPropertyItemProps) {
  const role = useAuthStore((s) => s.agent?.role);
  // Один тон и один текст плашки на список и карточку (propertyStagePill).
  const { tone, label: stageLabel } = propertyStagePill(p, role);
  const overdue = p.pipeline?.overdue && !subline;
  const canTogglePublish = !!onTogglePublish && (p.publishedOnSite || p.status === "AVAILABLE");
  return (
    <article data-property-row="" data-list-row data-property-layout={variant} className="ry-obj-card" data-selected={selected ? "true" : undefined}>
      <div className="ry-obj-photo">
        <ObjThumb key={`${p.photos[0]?.thumbUrl ?? "empty"}:${p.photos[0]?.url ?? ""}`} photo={p.photos[0]?.thumbUrl || p.photos[0]?.url} alternate={p.photos[0]?.url} />
        <ObjStatusPill tone={tone} label={stageLabel} />
        {p.photos.length > 0 && <span className="ry-obj-count"><ObjIcon name="image" size={16} />{p.photos.length}</span>}
      </div>
      <div className="ry-obj-body">
        <p className="ry-obj-price ry-num">
          {formatMoney(p.price, p.currency)}
          <small>{formatPricePerSqm(p.price, p.areaSqm, p.currency)}</small>
        </p>
        <h2 className="ry-obj-name">{p.title}</h2>
        <p className="ry-obj-addr">{p.district?.name ?? "Район не указан"}{p.address ? ` · ${p.address}` : ""} · {formatArea(p.areaSqm)} м²{floors}</p>
        <p className="ry-obj-meta">
          <PropertyHealthDot health={health} />
          <span title={`Номер для поиска: ${formatPropertyCode(p.shortId)}`}>№{p.shortId}</span>
          <span className="ry-obj-state" data-tone={tone}>{stageLabel}</span>
          {p.publishedOnSite && <span className="ry-obj-tag" data-tone="ok"><ObjIcon name="globe" size={16} />На сайте</span>}
        </p>
        <div className="ry-obj-stats"><PropertyStats property={p} /></div>
        {subline && <div className="ry-obj-subline">{subline}</div>}
        {(awaitingAcceptance || handoff.length > 0) && <div className="ry-obj-tags">
          {awaitingAcceptance && <span className="ry-obj-tag" data-tone="warn"><ObjIcon name="circle-alert" size={16} />Передан вам · примите</span>}
          {handoff.map((item) => (
            <span key={item.text} className="ry-obj-tag" data-tone={item.tone === "mute" ? "neutral" : item.tone}>
              {item.tone === "crit" && <ObjIcon name="flame" size={16} />}
              {item.tone === "warn" && <ObjIcon name="circle-alert" size={16} />}
              {item.text}
            </span>
          ))}
        </div>}
        {overdue && <p className="ry-obj-overdue" data-tone={tone === "crit" ? "crit" : "warn"}>{STAGE_OWNER_LABELS[p.pipeline!.owner ?? ""] ?? p.pipeline!.owner ?? "Этап"} задерживает объект: {p.pipeline!.daysInStage} дн. при сроке {p.pipeline!.limitDays ?? "не задан"}.</p>}
        <div className="ry-obj-foot">
          <span className="ry-obj-agent" title={agentTitle}>
            {agentName ? <RhAvatar name={agentName} size={44} /> : null}
            <span>{agentName ? agentName.split(" ")[0] : "Без агента"}</span>
          </span>
          {canTogglePublish && (
            <button type="button" className="ry-btn ry-obj-publish" data-variant="gray" onClick={() => onTogglePublish!(p.id, p.publishedOnSite ? "unpublish" : "publish")}>
              {p.publishedOnSite ? "Снять с сайта" : "Опубликовать"}
            </button>
          )}
        </div>
      </div>
      {band && <div className="ry-obj-band">{band}</div>}
      {onToggleSelect && (
        <label className="ry-obj-pick">
          <input type="checkbox" checked={!!selected} onChange={() => onToggleSelect(p.id)} aria-label={`Выбрать объект: ${p.title}`} />
        </label>
      )}
      <Link to={`/properties/${p.shortId}`} aria-label={`Открыть объект: ${p.title}`} className="ry-obj-link" />
    </article>
  );
}

function ObjThumb({ photo, alternate }: { photo?: string; alternate?: string }) {
  // Одна заглушка на все экраны (PropertyPhoto): «Фото недоступно» / «Нет фото».
  return <PropertyPhoto fill sources={[photo, alternate]} />;
}
