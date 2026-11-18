import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Property } from "../../../types";
import { formatMoney, formatPricePerSqm } from "../../../lib/format";
import { propertyParams } from "../../../lib/propertyParams";
import { propertyStageChip } from "../../../lib/propertyStageChip";
import { ObjIcon, type ObjIconName } from "./ObjIcon";
import { ObjStatusPill } from "./RoyalPropertyItem";
import { toneFromChipTone } from "./objectTone";

/**
 * ГЛАВНЫЙ БЛОК КАРТОЧКИ ОБЪЕКТА — «Новый вид» (18.11.2026).
 *
 * Те же данные и те же три кнопки, что у CleanPropertySummary: «Назначить
 * показ», «Изменить», «Ещё» (обработчики и права приходят от карточки). По
 * макету: цена крупно, название, адрес, факты строками со значками.
 * Факты — те же, что чипы прежнего вида (`propertyParams`): «Район» стоит в
 * строке под ценой, незаполненное («не указано») не показывается.
 */
const FACT_ICON: Record<string, ObjIconName> = {
  "Площадь": "corners",
  "Участок": "map-pin",
  "Комнаты": "house",
  "Этаж": "stack",
  "Этажность": "stack",
  "Тип": "building-2",
  "Состояние": "brush",
};

export function royalPropertyFacts(property: Parameters<typeof propertyParams>[0]): { label: string; value: string; icon: ObjIconName }[] {
  return propertyParams(property)
    .filter(({ label, value }) => label !== "Район" && !/^не указан/i.test(value))
    .map(({ label, value }) => ({ label, value, icon: FACT_ICON[label] ?? "building-2" }));
}

export function RoyalPropertySummary({ property, place, onSchedule, onEdit, onMore, children }: {
  property: Property; place?: string; onSchedule: (() => void) | null; onEdit: (() => void) | null; onMore: () => void; children?: ReactNode;
}) {
  const stage = propertyStageChip(property);
  const facts = royalPropertyFacts(property);
  const sub = [Number(property.areaSqm) > 0 ? formatPricePerSqm(property.price, property.areaSqm, property.currency) : null, property.district?.name].filter(Boolean).join(" · ");
  return (
    <section className="ry-obj-summary" data-testid="property-price" aria-label="Цена и главное об объекте">
      <ObjStatusPill tone={toneFromChipTone(stage.tone)} label={stage.label} testId="property-stage" />
      <p className="ry-obj-bigprice ry-num">{formatMoney(property.price, property.currency)}</p>
      {sub && <p className="ry-obj-sum-sub">{sub}</p>}
      <h1 className="ry-obj-title">{property.title}</h1>
      {place && <p className="ry-obj-place">{place}</p>}
      {facts.length > 0 && (
        <ul className="ry-obj-facts" data-testid="property-params" aria-label="Параметры объекта">
          {facts.map((fact) => (
            <li key={fact.label}>
              <span className="ry-circle" data-tone="a0" data-size="44" aria-hidden="true"><ObjIcon name={fact.icon} /></span>
              <span className="ry-obj-fact-text"><b>{fact.value}</b><span>{fact.label}</span></span>
            </li>
          ))}
        </ul>
      )}
      <div className="ry-obj-actions">
        {onSchedule && <button type="button" className="ry-btn" data-variant="primary" onClick={onSchedule}><ObjIcon name="calendar-plus" />Назначить показ</button>}
        {onEdit && <button type="button" className="ry-btn" data-variant={onSchedule ? "gray" : "primary"} onClick={onEdit}><ObjIcon name="pencil" />Изменить</button>}
        <button type="button" className="ry-btn" data-variant="gray" onClick={onMore}><ObjIcon name="more" />Ещё</button>
      </div>
      {children && <div className="ry-obj-sum-extra">{children}</div>}
    </section>
  );
}

/** Шапка карточки на ПК: «‹ Объекты» таблеткой (та же ссылка, что у прежнего вида) и номер справа. */
export function RoyalObjectBack({ code }: { code: string }) {
  return (
    <header className="ry-obj-head">
      <Link to="/properties" className="ry-obj-back"><ObjIcon name="back" />Объекты</Link>
      <b className="ry-obj-head-code">{code}</b>
    </header>
  );
}
