import type { ReactNode } from "react";
import { useCan } from "../../../../lib/permissions";
import { useNavigation } from "../../../../lib/navigation";
import { lazyWithReload } from "../../../../lib/lazyWithReload";
import { mcOk, useMissionControl } from "../../../../hooks/useMissionControl";
import { useTeamLive } from "../../../../hooks/useTeamLive";
import { RhGroup, RhCircle, RhRow, RhSection, RhTile, blockState } from "../../ui";
import { loadView } from "../../../rh2/Rh2ErrorState";
import { tileTone } from "../../tileTone";
import { waitLabel } from "../leader";

/**
 * ГЛАВНАЯ РУКОВОДИТЕЛЯ = ДАШБОРД (21.11.2026): два блока — полоса «Требует внимания сейчас»
 * и сам дашборд (pages/DirectorDashboard.tsx, свой запрос и свои фильтры).
 *
 * В полосе только то, что срочно ПРЯМО СЕЙЧАС и чего нет в дашборде (там цифры за период):
 * клиенты ждут ответа, пропущенные звонки сегодня, заявки ждут принятия. «Без контакта» и
 * «просрочено» дашборд уже показывает в «Скорости ответа» — второй раз их здесь не ставим.
 * Плитка рисуется, только если число больше нуля: нулей на главной нет, при тишине — одна
 * спокойная строка. Данные — снимок пульта и живая сводка команды (общий кэш с прочими блоками).
 */
const DirectorDashboardBlockLazy = lazyWithReload(() => import("../../../../pages/DirectorDashboard").then((m) => ({ default: m.DirectorDashboardBlock })));

export function DashboardHomeBlock() {
  return <DirectorDashboardBlockLazy />;
}

export function AttentionStrip() {
  const can = useCan();
  const canView = can("dashboard.analytics");
  const mc = useMissionControl(canView);
  const live = useTeamLive(canView);
  const { all: navigation } = useNavigation();
  if (!canView) return null;
  const mcView = loadView(mc);
  if (mcView === "loading" || mcView === "offline") return <RhSection title="Требует внимания сейчас">{blockState(mc)}</RhSection>;
  const hasRoute = (path: string) => navigation.some((item) => item.to === path);
  const data = mc.data;
  const hero = data?.hero && mcOk(data.hero) ? data.hero : null;
  const bot = data?.bot && mcOk(data.bot) ? data.bot : null;
  const waiting = bot?.attention?.waitingHuman;
  const oldest = waiting?.items?.length ? Math.max(...waiting.items.map((item) => item.waitingMinutes)) : null;
  const unaccepted = typeof live.data?.unacceptedTotal === "number" ? live.data.unacceptedTotal : 0;
  const late = typeof live.data?.escalatedTotal === "number" ? live.data.escalatedTotal : 0;
  const tiles: ReactNode[] = [];
  if (waiting && waiting.count > 0) tiles.push(
    <RhTile key="waiting" variant={tileTone("urgent", waiting.count)} icon="message-circle" label="Ждут ответа" value={waiting.count}
      note={oldest !== null ? `дольше всех ${waitLabel(oldest)}` : "клиенты в чатах"} to={hasRoute("/messages") ? "/messages" : undefined} />,
  );
  if (hero && hero.missedCallsToday > 0) tiles.push(
    <RhTile key="missed" variant={tileTone("urgent", hero.missedCallsToday)} icon="phone-missed" label="Пропущенные звонки" value={hero.missedCallsToday}
      note="сегодня" to={hasRoute("/calls") ? "/calls" : undefined} />,
  );
  if (unaccepted > 0) tiles.push(
    <RhTile key="unaccepted" variant={tileTone("urgent", unaccepted)} icon="user-plus" label="Ждут принятия" value={unaccepted}
      note={late > 0 ? `время вышло: ${late}` : "заявки у агентов"} to="/clients?slice=pending" />,
  );
  if (tiles.length === 0) {
    // Упавший источник — не «всё спокойно».
    if (loadView(mc) === "error" || loadView(live) === "error") return <RhSection title="Требует внимания сейчас">{blockState(loadView(mc) === "error" ? mc : live, () => { void mc.refetch(); void live.refetch(); })}</RhSection>;
    return (
      <RhSection title="Требует внимания сейчас">
        <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Срочного нет" /></RhGroup>
      </RhSection>
    );
  }
  return (
    <RhSection title="Требует внимания сейчас">
      <div className="ry-strip ry-strip-tiles" data-tiles={tiles.length} data-strip="attention">{tiles}</div>
    </RhSection>
  );
}
