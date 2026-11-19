import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";
import type { TileIcon } from "../../ui/StatTile";

/**
 * Значок плитки (StatTile) из набора нового вида. Плитка рисует значок как
 * компонент с классом — здесь тот же контракт, но тело из MingCute (RoyalIcon).
 * Компоненты кэшируются: новый тип на каждом рендере заставил бы React
 * пересоздавать значок.
 */
const tileIcons = new Map<RoyalIconName, TileIcon>();
export function controlTileIcon(name: RoyalIconName): TileIcon {
  let icon = tileIcons.get(name);
  if (!icon) {
    const Icon: TileIcon = ({ className }) => <RoyalIcon name={name} className={className} />;
    Icon.displayName = `ControlTileIcon(${name})`;
    tileIcons.set(name, Icon);
    icon = Icon;
  }
  return icon;
}

/**
 * Плитка по смыслу: срочная (та же `critical`, что красит подпись у StatTile) получает
 * пламя и класс `ry-tile-crit` — в слое это сплошной красный круг с белым значком;
 * спокойная — свой значок на пастели. Срочное отличается и яркостью, и значком.
 * Возвращает пропсы StatTile: `<StatTile {...(royal ? controlTile("clock", n > 0) : { icon: Old })} …/>`.
 */
export function controlTile(name: RoyalIconName, critical = false): { icon: TileIcon; className?: string } {
  return critical ? { icon: controlTileIcon("flame"), className: "ry-tile-crit" } : { icon: controlTileIcon(name) };
}
