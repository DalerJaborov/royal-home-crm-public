import { ROYAL_BRAND_ICONS, ROYAL_ICONS, type RoyalBrandName, type RoyalIconName } from "./royalIconData";

/**
 * ЗНАЧОК «НОВОГО ВИДА» — одна дверь на все значки облика `royal` (18.11.2026).
 *
 * Тела значков вшиты (royalIconData.ts), сеть не нужна. `filled` — залитый
 * вариант для активного пункта меню. Цвет — `currentColor`, размер — `size`
 * (24 по закону вида; в меню 26). Знаки ✨ (искры) в наборе нет намеренно:
 * это общепринятый знак ИИ, а ИИ в интерфейсе не подчёркиваем.
 */
export function RoyalIcon({ name, filled = false, size = 24, className, label }: {
  name: RoyalIconName; filled?: boolean; size?: number; className?: string; label?: string;
}) {
  const icon = ROYAL_ICONS[name];
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} className={className}
      aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}
      focusable="false"
      // Static markup from the bundled icon set, never user data.
      dangerouslySetInnerHTML={{ __html: filled ? icon.fill : icon.line }}
    />
  );
}

/** Каналы — в родных цветах (цвет задаёт CSS круга: `.rh-brand-<имя>`). */
export function RoyalBrandIcon({ name, size = 24, className }: { name: RoyalBrandName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} fill="currentColor" className={className} aria-hidden="true" focusable="false"
      dangerouslySetInnerHTML={{ __html: ROYAL_BRAND_ICONS[name] }} />
  );
}
