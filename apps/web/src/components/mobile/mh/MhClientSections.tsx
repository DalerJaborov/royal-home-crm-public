import { useNavigate } from "react-router-dom";
import { useCan } from "../../../lib/permissions";
import type { MhLaneChip } from "./MhList";

/**
 * ЛЕНТА ВНУТРИ РАЗДЕЛА КЛИЕНТОВ НА ТЕЛЕФОНЕ — зеркало
 * components/ClientsSectionLane.tsx, чтобы телефон и компьютер не разошлись.
 *
 * С 16.11.2026 (владелец: «удалить все папки и статусы, ничего лишнего»)
 * «Неактивных», «Отложенных», «Потерянных» и «Воронки» нет — список один.
 * Осталась только «Не на виду» (бывшая «Все мои», 18.09.2026, Р-2/Р-7
 * docs/audit/lead-ownership-17-09.md): место, где держатель без
 * `archive.view`/`clients.assign` находит свою карточку в Корзине или в
 * «Прочих». У руководства ленты нет вовсе: одна вкладка — не выбор.
 */
export type MhClientSection = "buyers" | "sellers" | "allMine";

export function useClientSectionChips(current: MhClientSection): MhLaneChip[] {
  const navigate = useNavigate();
  const can = useCan();
  if (can("clients.viewAll")) return [];
  const inWork = current === "sellers" ? "/sellers" : "/clients";
  return [
    { key: "inWork", label: "В работе", count: null, active: current !== "allMine", onSelect: () => navigate(inWork) },
    { key: "allMine", label: "Не на виду", count: null, active: current === "allMine", onSelect: () => navigate("/clients/all-mine") },
  ];
}
