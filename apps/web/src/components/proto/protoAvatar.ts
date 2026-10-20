/**
 * Круглые аватары эталона «Royal Home 2026».
 *
 * В прототипе (`docs/pult/theme-2026/screens/telephony.html`, `calls.html`) цвет
 * кружка задан инлайном парой токенов: `background:var(--aqua);color:var(--aqua-ink)`.
 * Токены живут в `_tokens.css` и уже перенесены в `theme-2026-proto.css` — здесь
 * Сама таблица тонов живёт в lib/avatarTone.ts — одна на всю CRM (11.09.2026):
 * копий было четыре, и они разошлись правилом выбора цвета. Здесь остаётся её
 * порядковый вид (телефония красит ряд звонков по позиции) и раскладка инициалов.
 */
import { AVATAR_TONE_NAMES, avatarToneVars, type AvatarToneVars } from "../../lib/avatarTone";

export const AV_TONES: readonly AvatarToneVars[] = AVATAR_TONE_NAMES.map(avatarToneVars);

/** Две буквы, как в макете («МЮ», «СН»). Пустое имя даёт «?». */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}
