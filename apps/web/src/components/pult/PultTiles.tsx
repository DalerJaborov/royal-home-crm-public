import type { PultArea } from "@royal-home/shared";
import { AREA_ICON } from "./pultTheme";
import { TrafficTile } from "./TrafficTile";

/**
 * Светофор разделов — сетка `.tiles` прототипа темы «Royal Home 2026»
 * (`docs/pult/theme-2026/screens/home-admin.html`, `_components.css`):
 * четыре плитки в ряд на десктопе, две на телефоне. Раньше здесь стояла своя
 * сетка `.rh-pult-tiles` в девять колонок, из-за которой на 1440 подписи
 * плиток переносились в две строки.
 *
 * Состав и порядок плиток приходят готовыми из `buildPultView` (права и
 * «Настроить пульт», `pultModules`) — здесь ни сортировки, ни фильтра нет.
 */
export function PultTiles({ areas }: { areas: PultArea[] }) {
  // role="group", не "list": дети — ссылки `<a class="tile">`, а не listitem;
  // axe (aria-required-children, critical) валил e2e на «/» 10.09.2026.
  return (
    <div className="tiles" role="group" aria-label="Разделы компании">
      {areas.map((area) => (
        <TrafficTile
          key={area.id}
          icon={AREA_ICON[area.id].icon}
          label={area.label}
          big={area.big}
          line={area.line}
          tone={area.tone}
          href={area.href}
        />
      ))}
    </div>
  );
}
