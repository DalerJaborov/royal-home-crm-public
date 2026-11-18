import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";
import { OBJECT_ICONS, type ObjectIconName } from "./objectIconData";

/**
 * Значок раздела «Объекты» в новом виде: общий набор (RoyalIcon) плюс свои
 * значки пачки (objectIconData.ts) и простые знаки интерфейса, которых нет
 * в наборе макета (карандаш, «ещё», плюс, галочка, стрелка назад). Знаки нарисованы линией
 * той же толщины и не несут смысла сами по себе — рядом всегда подпись.
 */
const UI_GLYPHS = {
  pencil: '<path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m13.5 6.5 4 4" fill="none" stroke="currentColor" stroke-width="2"/>',
  more: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
  back: '<path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
} as const;

export type ObjIconName = RoyalIconName | ObjectIconName | keyof typeof UI_GLYPHS;

export function ObjIcon({ name, size = 24, className }: { name: ObjIconName; size?: number; className?: string }) {
  const own = (OBJECT_ICONS as Record<string, { line: string }>)[name]?.line ?? (UI_GLYPHS as Record<string, string>)[name];
  if (!own) return <RoyalIcon name={name as RoyalIconName} size={size} className={className} />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" focusable="false"
      // Static markup from the bundled icon set, never user data.
      dangerouslySetInnerHTML={{ __html: own }} />
  );
}
