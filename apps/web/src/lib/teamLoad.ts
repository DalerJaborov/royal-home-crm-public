import type { TeamMember } from "../hooks/useTeam";

/**
 * Состояние загрузки агента по лимиту активных клиентов.
 *
 * Живёт отдельным модулем, а не в `pages/Team.tsx` (14.09.2026): мобильная
 * «Команда» брала её оттуда, а сама страница импортирует мобильный экран —
 * получался круговой импорт, и `audit:deps` честно валил проверку. Функция
 * ничего не знает ни про экран, ни про разметку, поэтому её место здесь.
 */
export function loadState(m: TeamMember): "free" | "near" | "full" | "nolimit" {
  if (m.leadLimit <= 0) return "nolimit";
  if (m.activeLoad >= m.leadLimit) return "full";
  if (m.leadLimit - m.activeLoad <= 1) return "near";
  return "free";
}
