import type { ComponentProps } from "react";
import {
  AlertTriangle, Building2, CalendarDays, ClipboardCheck, Clock, Film, Flame, House, Image as ImageIcon,
  Images, LandPlot, MapPin, ShieldCheck, Store, UserRound, type LucideIcon,
} from "lucide-react";
import { ObjIcon, type ObjIconName } from "../objects/ObjIcon";
import { useRoyalSectionName } from "../clients/RoyalSection";

/**
 * ЗНАЧОК МАСТЕРА ОБЪЕКТА В «НОВОМ ВИДЕ» (пачка wizard, 20.11.2026).
 *
 * Мастер и форма объекта рисуют значки набора lucide. В новом виде у тех, для
 * кого в наборе макета (MingCute Line: общий RoyalIcon и значки «Объектов»)
 * есть пара по смыслу, рисуется значок макета; без признака вида — прежний
 * lucide, ни одного пикселя изменений. Пара ищется по самому компоненту, а не
 * по имени: переименование в lucide не сломает её молча.
 *
 * Значков без пары в наборе макета (кровать, линейка, ванна, лифт…) здесь нет
 * сознательно: их форма прежняя, а толщину линии и размер подгоняет слой
 * theme-look-royal-wizard.css. Сводящему пачки: пары можно перенести в общий
 * набор components/look/, когда в него придут недостающие значки.
 */
const PAIRS = new Map<LucideIcon, ObjIconName>([
  [UserRound, "user-plus"],
  [Images, "image"],
  [ImageIcon, "image"],
  [Building2, "building-2"],
  [MapPin, "map-pin"],
  [ClipboardCheck, "list-checks"],
  [House, "house"],
  [Store, "storefront"],
  [LandPlot, "corners"],
  [Film, "clapperboard"],
  [Clock, "clock"],
  [AlertTriangle, "circle-alert"],
  [CalendarDays, "calendar-days"],
  [ShieldCheck, "shield-check"],
  [Flame, "flame"],
]);

type LucideProps = ComponentProps<LucideIcon>;

/** Значок `icon` в обоих видах: в новом — пара из набора макета, иначе сам lucide. */
export function WizIcon({ icon: Icon, ...props }: { icon: LucideIcon } & LucideProps) {
  const royal = useRoyalSectionName() === "wizard";
  const pair = royal ? PAIRS.get(Icon) : undefined;
  if (!pair) return <Icon {...props} />;
  const size = Number(props.size ?? props.width ?? 24);
  return <ObjIcon name={pair} size={size} className={["ry-wiz-ic", props.className].filter(Boolean).join(" ")} />;
}

/** Все пары «lucide → набор макета» (для теста: каждая пара обязана рисоваться). */
export function wizIconPairs(): [LucideIcon, ObjIconName][] {
  return [...PAIRS];
}
