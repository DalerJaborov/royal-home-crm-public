import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";

/**
 * Значок раздела «Сделки» в новом виде: общий набор (RoyalIcon, MingCute Line)
 * плюс простые знаки интерфейса, которых в наборе макета нет (стрелки этапа,
 * плюс, фильтры, документ). Нарисованы линией той же толщины и смысла сами по
 * себе не несут — рядом всегда подпись или aria-label кнопки.
 */
const UI_GLYPHS = {
  "chev-left": '<path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  "chev-right": '<path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v5h5M9 13h6M9 17h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
} as const;

export type DealIconName = RoyalIconName | keyof typeof UI_GLYPHS;

export function DealIcon({ name, size = 24 }: { name: DealIconName; size?: number }) {
  const own = (UI_GLYPHS as Record<string, string>)[name];
  if (!own) return <RoyalIcon name={name as RoyalIconName} size={size} />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"
      // Static markup from the bundled glyphs above, never user data.
      dangerouslySetInnerHTML={{ __html: own }} />
  );
}
