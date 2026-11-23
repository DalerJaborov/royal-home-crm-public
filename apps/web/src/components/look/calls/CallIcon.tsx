import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";
import { CALL_ICONS, type CallIconName } from "./callIconData";

/**
 * Значок раздела «Звонки» в новом виде: общий набор (RoyalIcon) плюс свои значки
 * пачки (callIconData.ts) и простые знаки интерфейса, которых нет в наборе макета
 * (клавиатура набора, стрелки листания). Знаки нарисованы линией той же толщины
 * и не несут смысла сами по себе — рядом всегда подпись или aria-label.
 */
const UI_GLYPHS = {
  keypad:
    '<g fill="currentColor"><circle cx="6" cy="5" r="1.6"/><circle cx="12" cy="5" r="1.6"/><circle cx="18" cy="5" r="1.6"/><circle cx="6" cy="11" r="1.6"/><circle cx="12" cy="11" r="1.6"/><circle cx="18" cy="11" r="1.6"/><circle cx="6" cy="17" r="1.6"/><circle cx="12" cy="17" r="1.6"/><circle cx="18" cy="17" r="1.6"/><circle cx="12" cy="22" r="1.4"/></g>',
  "chevron-left": '<path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  "chevron-right": '<path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
} as const;

export type CallGlyphName = RoyalIconName | CallIconName | keyof typeof UI_GLYPHS;

export function CallIcon({ name, size = 24, className }: { name: CallGlyphName; size?: number; className?: string }) {
  const own = (CALL_ICONS as Record<string, { line: string }>)[name]?.line ?? (UI_GLYPHS as Record<string, string>)[name];
  if (!own) return <RoyalIcon name={name as RoyalIconName} size={size} className={className} />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" focusable="false"
      // Static markup from the bundled icon set, never user data.
      dangerouslySetInnerHTML={{ __html: own }} />
  );
}
