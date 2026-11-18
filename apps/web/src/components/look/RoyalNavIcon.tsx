import { RoyalIcon } from "./RoyalIcon";
import { royalIconForPath } from "./royalNavIcons";

/** Значок пункта меню нового вида: линия, у активного — заливка. Грузится отдельным куском. */
export default function RoyalNavIcon({ to, active, size = 26 }: { to: string; active: boolean; size?: number }) {
  return <RoyalIcon name={royalIconForPath(to)} filled={active} size={size} className="ry-nav-icon" />;
}
