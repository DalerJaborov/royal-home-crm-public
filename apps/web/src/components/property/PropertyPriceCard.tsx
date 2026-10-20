import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { formatMoney, formatPricePerSqm } from "../../lib/format";
import { propertyParamChips } from "../../lib/propertyParams";
import { propertyStageChip } from "../../lib/propertyStageChip";
import type { Property } from "../../types";
import { Button } from "../rh2/Button";
import { Card } from "../rh2/Card";
import { Chip } from "../rh2/Chip";

/**
 * ЦЕНА, ЗАГОЛОВОК, ПАРАМЕТРЫ И ДЕЙСТВИЯ — одна карточка, как в объявлении
 * (контракт 06.10.2026, раздел 6). Без логики: всё приходит пропсами.
 *
 *  · цена 28, под ней «$793 за м² · Сино», заголовок 18;
 *  · один чип ЭТАПА (`propertyStageChip`), «на сайте» и «принят …» ушли во
 *    вкладку «Коротко»;
 *  · параметры чипами ОДИН раз (раньше их показывали и в подписи, и плитками);
 *  · главное действие одно: «Назначить показ», у кого его нет (маркетинг,
 *    монтажёр, СБ не ведут клиентов), главным становится «Изменить»;
 *  · «Ещё» на компьютере кнопка рядом, на телефоне она в шапке оболочки.
 */
export function PropertyPriceCard({
  property,
  onSchedule,
  onEdit,
  onMore,
  children,
}: {
  property: Property;
  /** Нет права или нечего назначать (объект в архиве, продан): кнопка не рисуется. */
  onSchedule: (() => void) | null;
  /** Нет права править: кнопка не рисуется. */
  onEdit: (() => void) | null;
  onMore: () => void;
  /** Строка под действиями (например, «Ждут N покупателей · Предложить»). */
  children?: ReactNode;
}) {
  const stage = propertyStageChip(property);
  const chips = propertyParamChips(property);
  const hasArea = Number(property.areaSqm) > 0;
  const sub = [hasArea ? formatPricePerSqm(property.price, property.areaSqm, property.currency) : null, property.district?.name]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card data-testid="property-price">
      <div className="rh-price-head">
        <div>
          <p className="rh-price">{formatMoney(property.price, property.currency)}</p>
          {sub && <p className="rh-price-sub">{sub}</p>}
        </div>
        <Chip tone={stage.tone} data-testid="property-stage">
          {stage.label}
        </Chip>
      </div>
      <h2 className="rh-price-title">{property.title}</h2>
      {chips.length > 0 && (
        <div className="rh-params" data-testid="property-params">
          {chips.map((c) => (
            <Chip key={c}>{c}</Chip>
          ))}
        </div>
      )}
      <div className="rh-price-acts">
        {onSchedule && <Button onClick={onSchedule}>Назначить показ</Button>}
        {onEdit && (
          <Button variant={onSchedule ? "soft" : "primary"} onClick={onEdit}>
            Изменить
          </Button>
        )}
        <span className="only-wide">
          <Button variant="icon" aria-label="Ещё" onClick={onMore}>
            <MoreHorizontal className="i" aria-hidden />
          </Button>
        </span>
      </div>
      {children}
    </Card>
  );
}
