import { RoyalRoleHome } from "../components/look/home/registry";

/**
 * «СЕГОДНЯ» В НОВОМ ВИДЕ — директор и админ, РОП, агент (облик royal).
 *
 * С правки home-core (20.11.2026) — тонкая обёртка над ЯДРОМ ГЛАВНОЙ
 * (`components/look/home/`): блоки ролей лежат в `blocks/director.tsx`, `rop.tsx`,
 * `agent.tsx`, состав и порядок по умолчанию — в `registry.tsx`, личные выключатели
 * и порядок — Профиль → Оформление. Рисуется только при `data-ui-look="royal"` —
 * решает Dashboard.tsx; у остальных сотрудников главная не меняется.
 */
export function TodayRoyal() {
  return <RoyalRoleHome />;
}
