import { useCan } from "../../../lib/permissions";
import { mcOk, useMissionControl } from "../../../hooks/useMissionControl";
import { useTeamLive } from "../../../hooks/useTeamLive";
import { useAuthStore } from "../../../store/auth";
import { attentionCount, attentionSources } from "../../../lib/attentionCount";

/**
 * Метка «Сегодня» в меню «Нового вида» (макет 27.11.2026): сколько пунктов «Требует внимания сейчас»
 * ждут руководителя — те же пункты и те же числа, что плитки и строки «Ещё срочно» на его главной
 * (общее правило lib/attentionCount.ts). Данные — тот же общий кэш, что у главной (снимок пульта и
 * живая сводка команды), по тому же праву `dashboard.analytics`. У кого права нет (агент) — метки нет:
 * своего источника «решений» у агента нет, а придумывать число нельзя. Источник не загрузился —
 * метки нет (не «0»).
 */
export function useTodayBadge(active: boolean): number | undefined {
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  const enabled = active && can("dashboard.analytics");
  const mc = useMissionControl(enabled);
  const live = useTeamLive(enabled);
  if (!enabled || !mc.data) return undefined;
  const count = attentionCount(attentionSources({
    hero: mcOk(mc.data.hero) ? mc.data.hero : null,
    bot: mc.data.bot && mcOk(mc.data.bot) ? mc.data.bot : null,
    firstLine: mc.data.firstLine && mcOk(mc.data.firstLine) ? mc.data.firstLine : null,
    team: mc.data.team && mcOk(mc.data.team) ? mc.data.team : null,
    live: live.data,
    role,
  }));
  return count || undefined;
}
