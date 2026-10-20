import { Link } from "react-router-dom";
import type { PropertyDuplicateMatch } from "@royal-home/shared";

/**
 * Баннер «Этот адрес уже заведён» — общий для шага «Где» и сводки «Проверка»
 * (владелец 15.09.2026), чтобы разметка не разъезжалась между двумя местами
 * показа. Формулировка — факт, а не оценка похожести (уточнение владельца:
 * «пусть механизм ничего не выдумывает» — сервер уже отфильтровал точным
 * совпадением, здесь только показ). Предупреждение НЕ блокирует сохранение —
 * оно не мешает продолжать мастер, просто ведёт в карточку найденного объекта.
 *
 * Стиль — `.quiet warn`, тот же, что у соседнего предупреждения о несовпадении
 * района на этом же шаге (StepPlace.tsx): готовая тема мастера (`.dup` в
 * theme-2026-wizard.css) рассчитана на обёртку `.rh2 .wiz`, которой текущий
 * экран мастера ещё не использует (см. WizardShell.tsx, `.rh2 screens`/`.scr`) —
 * добавлять новую обёртку ради одного баннера означало бы менять оболочку
 * всего мастера мимо этой задачи.
 */
const FIELD_LABEL: Record<PropertyDuplicateMatch["checks"][number]["field"], string> = {
  areaSqm: "площадь",
  rooms: "комнаты",
  floor: "этаж",
  totalFloors: "этажность",
  type: "тип",
  marketType: "рынок",
  windowCount: "окна",
  landAreaSotka: "участок",
};

/** «совпало: площадь, комнаты, этаж 5; дом в 12 м» — только факты сверки сервера. */
function describeMatch(m: PropertyDuplicateMatch): string {
  const parts = m.checks.map((c) =>
    c.field === "floor" || c.field === "totalFloors" || c.field === "rooms"
      ? `${FIELD_LABEL[c.field]} ${c.theirs}`
      : FIELD_LABEL[c.field],
  );
  const dist = m.distanceM !== null && m.matchedBy !== "address" ? `; дом в ${m.distanceM} м` : "";
  return `совпало: ${parts.join(", ")}${dist}`;
}

export function DuplicateAddressWarning({ matches }: { matches: PropertyDuplicateMatch[] }) {
  if (matches.length === 0) return null;
  const first = matches[0];
  return (
    <div className="fld wide">
      <div className="quiet warn" role="status" data-testid="wizard-duplicate-address">
        <span className="dot warn" aria-hidden />
        <span className="txt">
          Этот объект уже заведён: №{first.shortId}, {first.address}, {first.areaSqm} м² ({describeMatch(first)})
          {matches.length > 1 ? ` и ещё ${matches.length - 1}` : ""}.
        </span>
        <Link className="lnk" to={`/properties/${first.shortId}`} target="_blank" rel="noreferrer">
          Открыть карточку
        </Link>
      </div>
    </div>
  );
}
