import { useCan } from "../lib/permissions";
import { ScreenTabs, type ScreenTab } from "./ScreenTabs";

/**
 * ВТОРАЯ ЛЕНТА РАЗДЕЛА КЛИЕНТОВ.
 *
 * С 16.11.2026 (владелец: «удалить все папки и статусы, ничего лишнего»)
 * состояний «Неактивные», «Отложенные», «Потерянные» и «Воронки» больше нет —
 * список клиентов один. Лента осталась только ради «Не на виду» (бывшая «Все
 * мои», 18.09.2026, Р-2/Р-7 docs/audit/lead-ownership-17-09.md): единственное
 * место, где держатель без `archive.view`/`clients.assign` находит свою
 * карточку, уехавшую в Корзину или в «Прочие». Руководству вкладка ничего не
 * добавляет — у него ленты нет вовсе (одна вкладка — не выбор).
 */
export type ClientsSection = "SELLER" | "BUYER";

export function ClientsSectionLane({ section }: { section: ClientsSection }) {
  const can = useCan();
  if (can("clients.viewAll")) return null;
  const inWork = section === "SELLER" ? "/sellers" : "/clients";
  const tabs: ScreenTab[] = [
    { to: inWork, label: "В работе", end: section === "BUYER" },
    { to: "/clients/all-mine", label: "Не на виду" },
  ];
  return <ScreenTabs tabs={tabs} />;
}
