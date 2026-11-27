import { useCan } from "../../../lib/permissions";
import { mcOk, useMissionControl } from "../../../hooks/useMissionControl";
import { useTeamLive } from "../../../hooks/useTeamLive";
import { attentionCount } from "../../../lib/attentionCount";

/**
 * Метка «Сегодня» в меню «Нового вида» (макет 27.11.2026): сколько пунктов «Требует внимания сейчас»
 * ждут руководителя. Данные — тот же общий кэш, что у главной руководителя (снимок пульта и живая
 * сводка команды), по тому же праву `dashboard.analytics`. У кого права нет (агент) — метки нет:
 * своего источника «решений» у агента нет, а придумывать число нельзя. Источник не загрузился —
 * метки нет (не «0»).
 */
export function useTodayBadge(active: boolean): number | undefined {
  const can = useCan();
  const enabled = active && can("dashboard.analytics");
  const mc = useMissionControl(enabled);
  const live = useTeamLive(enabled);
  if (!enabled || !mc.data) return undefined;
  const hero = mcOk(mc.data.hero) ? mc.data.hero : null;
  const bot = mc.data.bot && mcOk(mc.data.bot) ? mc.data.bot : null;
  const count = attentionCount({
    waitingHuman: bot?.attention?.waitingHuman?.count,
    missedCallsToday: hero?.missedCallsToday,
    unaccepted: live.data?.unacceptedTotal,
  });
  return count || undefined;
}
