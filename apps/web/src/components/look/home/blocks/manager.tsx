import { useCan } from "../../../../lib/permissions";
import { pluralizeRu, relativeTime } from "../../../../lib/format";
import { useDashboardSummary } from "../../../../hooks/useDashboard";
import { useTeamLive, type UnacceptedLead } from "../../../../hooks/useTeamLive";
import { useConversations } from "../../../../hooks/useConversations";
import { channelBrand } from "../time";
import { RhAvatar, RhBlockState, RhCircle, RhGroup, RhRow, RhSection, RhTile } from "../../ui";
import { tileTone } from "../../tileTone";
import { HomeChip, HomeMore, HomeQuick, useExpandable, type HomeQuickItem } from "../parts";

/**
 * БЛОКИ ГЛАВНОЙ МЕНЕДЖЕРА И АКЦИОНЕРА (ядро главной, пачка home, 20.11.2026).
 *
 * Те же запросы, что у прежних ManagerHome (ПК) и MobileManagerHome (телефон):
 * `useTeamLive` (живая сводка команды), `useConversations({})` (непрочитанные —
 * фильтром на клиенте, отдельного счётчика сервер не отдаёт), `useDashboardSummary`
 * (показы за 7 дней). Номера клиентов этой роли сервер маскирует — кнопки звонка
 * в строке нет, строка ведёт в карточку, где кнопка настоящая.
 *
 * Прежняя карточка «Входящие сейчас» не перенесена: данных у неё не было, только
 * фраза «Нет данных»; журнал звонков открывается быстрым переходом «Звонки».
 */
export function ManagerTiles() {
  const team = useTeamLive(true);
  const summary = useDashboardSummary();
  const live = team.data;
  const value = (n: number | undefined) => (live ? n ?? 0 : "—");
  return (
    <div className="ry-strip ry-strip-tiles" data-tiles="4">
      {/* Цвет — по смыслу и значению (components/look/tileTone.ts): ноль серый, срочное красное. */}
      <RhTile variant={tileTone("attention", live?.unacceptedTotal)} icon="user-plus" label="Не приняты" value={value(live?.unacceptedTotal)} to="#ry-home-wait" alert={team.isError} />
      <RhTile variant={tileTone("urgent", live?.escalatedTotal)} icon="flame" label="Никто не принял" value={value(live?.escalatedTotal)} note="время вышло" to="#ry-home-wait" />
      <RhTile variant={tileTone("attention", live?.queuedTotal)} icon="inbox" label="Без агента" value={value(live?.queuedTotal)} to="/clients?slice=pending" />
      <RhTile variant={tileTone("info", summary.data?.kpis.showingsWeek)} icon="calendar-days" label="Показы" value={summary.data ? summary.data.kpis.showingsWeek : "—"} note="за 7 дней" to="/calendar" alert={summary.isError} />
    </div>
  );
}

export function ManagerQuick() {
  const can = useCan();
  const { data: live } = useTeamLive(true);
  const items: HomeQuickItem[] = [
    ...(can("calls.transcripts") || can("calls.ownTranscripts")
      ? [{ key: "calls", label: can("calls.transcripts") ? "Звонки" : "Мои звонки", icon: "phone-call" as const, to: "/calls", tone: "a1" as const }] : []),
    { key: "team", label: "Команда", icon: "users-round", to: "/team", tone: "a4", count: live ? live.agents.length : undefined },
    { key: "calendar", label: "Календарь", icon: "calendar-days", to: "/calendar", tone: "a2" },
  ];
  return <HomeQuick items={items} />;
}

export function ManagerFocus() {
  const team = useTeamLive(true);
  const live = team.data;
  const unaccepted = live?.unaccepted ?? [];
  const agents = live?.agents ?? [];
  const oldest = unaccepted.length ? Math.max(...unaccepted.map((l) => l.waitingMinutes)) : null;
  return (
    <RhSection id="ry-home-wait" title="Горит сейчас" to="/clients?slice=pending" linkLabel="Все заявки" className="ry-col-a">
      {team.isPending ? <RhBlockState kind="loading" />
        // Отказ сводки — не «все приняты»: вся смена оператора состоит из непринятых заявок.
        : team.isError || !live ? <RhBlockState kind="error" onRetry={() => void team.refetch()} />
        : <RhGroup>
          {unaccepted[0] ? <LeadRow lead={unaccepted[0]} focus />
            : <RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Все заявки приняты"
              sub={live.queuedTotal > 0 ? `${live.queuedTotal} без агента, ждут раздачи или назначения` : undefined} />}
          <RhRow to="/clients?slice=pending" lead={<RhCircle icon="inbox" tone="a0" />}
            title={`Не приняты агентами: ${live.unacceptedTotal} ${pluralizeRu(live.unacceptedTotal, ["заявка", "заявки", "заявок"])}`}
            sub={`${oldest !== null ? `самая старая ждёт ${oldest} мин, ` : ""}таймер вышел у ${live.escalatedTotal}, без агента ${live.queuedTotal}`}
            subTone={live.escalatedTotal > 0 ? "crit" : undefined} />
          {agents.length > 0 && (
            <RhRow to="/team" lead={<RhCircle icon="users" tone="a4" />}
              title={`В команде ${agents.length} ${pluralizeRu(agents.length, ["агент", "агента", "агентов"])}`}
              sub={`без заявок, ждущих принятия: ${agents.filter((a) => a.pendingAccept === 0).length}`} />
          )}
        </RhGroup>}
    </RhSection>
  );
}

export function ManagerWaiting() {
  const { data: live } = useTeamLive(true);
  const rest = (live?.unaccepted ?? []).slice(1);
  const list = useExpandable(rest, rest.length);
  if (!rest.length) return null;
  return (
    <RhSection title="Ждут распределения" className="ry-col-a">
      <RhGroup>
        {list.visible.map((lead) => <LeadRow key={lead.shortId} lead={lead} />)}
        <HomeMore rest={list.rest} onClick={list.more} />
      </RhGroup>
    </RhSection>
  );
}

export function ManagerTeam() {
  const team = useTeamLive(true);
  const agents = team.data?.agents ?? [];
  const list = useExpandable(agents, agents.length);
  return (
    <RhSection title="Кто сейчас свободен" to="/team" className="ry-col-b">
      {team.isPending ? <RhBlockState kind="loading" />
        : team.isError ? <RhBlockState kind="error" onRetry={() => void team.refetch()} />
        : agents.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="users" tone="a0" />} title="Список агентов пуст" /></RhGroup>
        : <RhGroup>
          {list.visible.map((a) => (
            <RhRow key={a.id} to="/team" lead={<RhAvatar name={a.fullName} src={a.avatarUrl} />}
              title={a.fullName}
              sub={`в работе ${a.activeLoad}, ждут ответа ${a.pendingAccept}, принял сегодня ${a.acceptedToday}`}
              subTone={a.pendingAccept > 0 ? "warn" : undefined}
              right={a.escalated > 0 ? <HomeChip tone="crit">{a.escalated} просрочено</HomeChip>
                // Решение владельца: «чем занят» не подписываем — честное «свободен/занят» по загрузке.
                : <HomeChip tone={a.activeLoad > 0 ? "warn" : "ok"}>{a.activeLoad > 0 ? "занят" : "свободен"}</HomeChip>} />
          ))}
          <HomeMore rest={list.rest} onClick={list.more} />
        </RhGroup>}
    </RhSection>
  );
}

export function ManagerUnread() {
  const conversations = useConversations({});
  const unread = (conversations.data?.items ?? []).filter((c) => c.unread);
  const list = useExpandable(unread, unread.length);
  return (
    <RhSection title="Сообщения без ответа" to="/messages" className="ry-col-a">
      {conversations.isPending ? <RhBlockState kind="loading" />
        : conversations.isError ? <RhBlockState kind="error" onRetry={() => void conversations.refetch()} />
        : unread.length === 0 ? <RhGroup><RhRow lead={<RhCircle icon="list-checks" tone="ok" />} title="Все переписки разобраны" /></RhGroup>
        : <RhGroup>
          {list.visible.map((c) => {
            const brand = channelBrand(c.channel ?? "");
            return (
              <RhRow key={c.id} to={`/messages?open=${c.id}`}
                lead={brand ? <RhCircle brand={brand} /> : <RhAvatar name={c.name ?? "?"} />}
                title={c.name ?? "Без имени"}
                sub={c.lastMessage?.content?.trim() || "новое сообщение"}
                right={<span className="ry-row-time" data-tone={c.awaitingHumanSince ? "crit" : undefined}>
                  {relativeTime(c.awaitingHumanSince ?? c.lastMessageAt)}
                </span>} />
            );
          })}
          <HomeMore rest={list.rest} onClick={list.more} />
        </RhGroup>}
    </RhSection>
  );
}

/** Непринятая заявка: сколько ждёт, кому назначена; потерянная и «никто не принял» — смыслом. */
function LeadRow({ lead, focus = false }: { lead: UnacceptedLead; focus?: boolean }) {
  const transfers = `${lead.reassignCount} ${pluralizeRu(lead.reassignCount, ["передача", "передачи", "передач"])}`;
  const sub = lead.lost
    ? "предел передач исчерпан, клиент потерян"
    : `${lead.agentName}, ждёт ${lead.waitingMinutes} мин${lead.reassignCount > 0 ? `, ${transfers}` : focus ? ", дальше клиент решит, что про него забыли" : ""}`;
  return (
    <RhRow to={`/clients/${lead.shortId}`} label={`${lead.fullName}: ${sub}`}
      lead={<RhCircle icon={lead.lost ? "x-circle" : lead.escalated ? "flame" : "hourglass"} tone={lead.lost ? "a0" : lead.escalated ? "crit" : "warn"} filled={lead.escalated && !lead.lost} />}
      title={lead.fullName}
      sub={sub}
      subTone={lead.lost ? undefined : lead.escalated ? "crit" : "warn"}
      right={lead.lost ? <HomeChip tone="muted">потерянный, вручную</HomeChip>
        : lead.escalated ? <HomeChip tone="crit">никто не принял</HomeChip> : undefined} />
  );
}
