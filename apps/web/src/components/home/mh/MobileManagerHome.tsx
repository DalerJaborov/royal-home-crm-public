import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Calendar, ChevronRight, Phone, PhoneCall, UsersRound } from "lucide-react";
import { useAuthStore } from "../../../store/auth";
import { useCan } from "../../../lib/permissions";
import { useTeamLive, type TeamLiveAgent, type UnacceptedLead } from "../../../hooks/useTeamLive";
import { useConversations } from "../../../hooks/useConversations";
import { pluralizeRu, relativeTime } from "../../../lib/format";
import { AVATAR_TONES, initials } from "../../../lib/theme2026Person";
import { MhNoData, MhQuick, MhScreen, MhSection, type MhQuickItem } from "./MhScreen";
import { TeamCharts } from "../TeamCharts";

/**
 * ГЛАВНАЯ МЕНЕДЖЕРА-ОПЕРАТОРА НА ТЕЛЕФОНЕ — разметка мобильного артефакта
 * владельца (`renderHomeManager` в
 * docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html): «Входящие сейчас»,
 * «Ждут распределения» с таймерами, «Команда · сейчас», «Сообщения без
 * ответа».
 *
 * Данные и права те же, что у ПК-версии (components/home/ManagerHome.tsx):
 * `useTeamLive` (живые счётчики раз в 30 с) и `useConversations`. Номера
 * клиентов этой роли маскируются сервером, поэтому кнопки звонка в строках
 * нет: `UnacceptedLead` отдаёт только shortId, а CRM-звонок требует
 * настоящий UUID — строка целиком ведёт в карточку, где кнопка настоящая.
 *
 * «ВХОДЯЩИЕ СЕЙЧАС» — ТИХАЯ СТРОКА, А НЕ ВЫДУМАННЫЙ ЗВОНОК. В артефакте это
 * живая очередь дозвона, но такого источника у роли нет: снимок пульта с
 * живыми разговорами (`/dashboard/mission-control`) открыт только
 * руководству, а рабочего места оператора с браузерной трубкой в CRM больше
 * нет (софтфон удалён 18.08.2026). Пустая карточка с придуманным «Звонок с
 * сайта · 0:42» была бы враньём, поэтому здесь сказано прямо, где смотреть.
 */
export function MobileManagerHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const can = useCan();
  const { data: teamLive, isLoading, isError, error } = useTeamLive(true);
  const { data: conversations } = useConversations({});
  const firstName = agent?.fullName?.split(" ")[0] ?? "";

  const unaccepted = teamLive?.unaccepted ?? [];
  const agents = teamLive?.agents ?? [];
  const unread = (conversations?.items ?? []).filter((c) => c.unread);

  // Ряд быстрых кнопок макета — «Звонки, Раздача, Команда, Календарь».
  // «Раздача» без своей плитки: отдельного раздела «раздача лидов» в CRM нет,
  // очередь «Ждут распределения» живёт прямо на этой же главной ниже —
  // отдельной ссылки не требует, а выдумывать несуществующий маршрут нельзя
  // (договор задания, п.3).
  const rawQuickActions: (MhQuickItem | false)[] = [
    (can("calls.transcripts") || can("calls.ownTranscripts")) && {
      label: can("calls.transcripts") ? "Звонки" : "Мои звонки",
      icon: PhoneCall,
      href: "/calls",
      key: "звонки",
      tone: "aqua" as const,
    },
    { key: "команда", label: "Команда", icon: UsersRound, href: "/team", tone: "lav", count: teamLive ? agents.length : undefined },
    { key: "календарь", tone: "lime", label: "Календарь", icon: Calendar, href: "/calendar" },
  ];
  const quickItems = rawQuickActions.filter((x): x is MhQuickItem => Boolean(x));

  return (
    <MhScreen greeting={`Салом${firstName ? `, ${firstName}` : ""}`}>
      <MhQuick items={quickItems} />
      <MhSection title="Входящие сейчас" note="очередь дозвона" first>
        <MhNoData>
          Нет данных: живую очередь звонков CRM этой роли не отдаёт. Пропущенные и записи — в разделе
          «Звонки».
        </MhNoData>
      </MhSection>

      <MhSection
        title="Ждут распределения"
        note={
          teamLive
            ? `${teamLive.unacceptedTotal} · таймеры`
            : undefined
        }
      >
        {isError ? (
          <MhNoData tone="crit">
            {error instanceof Error ? error.message : "Сводка по команде не загрузилась."}
          </MhNoData>
        ) : isLoading && !teamLive ? (
          <MhNoData>Загружаем непринятые заявки…</MhNoData>
        ) : unaccepted.length === 0 ? (
          <MhNoData tone="ok">
            Непринятых заявок нет
            {teamLive && teamLive.queuedTotal > 0
              ? `: ${teamLive.queuedTotal} без агента, ждут раздачи или назначения.`
              : "."}
          </MhNoData>
        ) : (
          <div className="card-s">
            {unaccepted.map((lead, i) => (
              <UnacceptedRow key={lead.shortId} lead={lead} tone={i} />
            ))}
          </div>
        )}
      </MhSection>

      <TeamNow agents={agents} loading={isLoading && !teamLive} />

      <MhSection title="Сообщения без ответа" note={unread.length}>
        {!conversations ? (
          <MhNoData>Загружаем переписки…</MhNoData>
        ) : unread.length === 0 ? (
          <MhNoData tone="ok">Все переписки разобраны.</MhNoData>
        ) : (
          <div className="card-s">
            {unread.slice(0, 5).map((c, i) => (
              <button
                type="button"
                className="row"
                key={c.id}
                onClick={() => navigate(c.clientShortId ? `/clients/${c.clientShortId}` : "/messages")}
              >
                <span className="av" style={AVATAR_TONES[i % AVATAR_TONES.length]} aria-hidden="true">
                  {initials(c.name ?? "?")}
                </span>
                <span className="t" style={{ textAlign: "left" }}>
                  <span className="n">{c.name ?? "Без имени"}</span>
                  <span className="s crit">
                    {c.awaitingHumanSince
                      ? `ждёт ответа ${relativeTime(c.awaitingHumanSince)}`
                      : `последнее сообщение ${relativeTime(c.lastMessageAt)}`}
                  </span>
                </span>
                <ChevronRight className="i" aria-hidden="true" />
              </button>
            ))}
            {unread.length > 5 && (
              <button type="button" className="row morerow" onClick={() => navigate("/messages")}>
                <span className="t">
                  <span className="n">Показать ещё ({unread.length - 5}) в «Сообщениях»</span>
                </span>
              </button>
            )}
          </div>
        )}
      </MhSection>

      {/* Графики по команде (28.09.2026) — тот же компонент, что на ПК-главной
          менеджера и у директора. Деньги менеджеру сервер не отдаёт. */}
      <TeamCharts host="phone" />
    </MhScreen>
  );
}

/** Строка непринятой заявки: сколько уже ждёт и кому она назначена. */
function UnacceptedRow({ lead, tone }: { lead: UnacceptedLead; tone: number }) {
  const navigate = useNavigate();
  const critical = lead.lost || lead.escalated;
  return (
    <button type="button" className="row" onClick={() => navigate(`/clients/${lead.shortId}`)}>
      <span className="av" style={AVATAR_TONES[tone % AVATAR_TONES.length]} aria-hidden="true">
        {initials(lead.fullName)}
      </span>
      <span className="t" style={{ textAlign: "left" }}>
        <span className="n">{lead.fullName}</span>
        <span className={critical ? "s crit" : "s warn"}>
          {lead.lost
            ? "предел передач исчерпан, клиент потерян"
            : lead.escalated
              ? `никто не принял, ${lead.reassignCount} ${pluralizeRu(lead.reassignCount, ["передача", "передачи", "передач"])}`
              : `${lead.agentName} · ждёт ${lead.waitingMinutes} ${pluralizeRu(lead.waitingMinutes, ["минуту", "минуты", "минут"])}`}
        </span>
      </span>
      <ChevronRight className="i" aria-hidden="true" />
    </button>
  );
}

/** «Команда · сейчас» — загрузка агентов из той же живой сводки. */
function TeamNow({ agents, loading }: { agents: TeamLiveAgent[]; loading: boolean }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? agents : agents.slice(0, 3);
  const rest = agents.length - shown.length;
  return (
    <MhSection title="Команда · сейчас" note={agents.length || undefined}>
      {loading ? (
        <MhNoData>Загружаем команду…</MhNoData>
      ) : agents.length === 0 ? (
        <MhNoData>Нет данных: список агентов пуст.</MhNoData>
      ) : (
        <div className="card-s">
          {shown.map((a, i) => (
            <button type="button" className="row" key={a.id} onClick={() => navigate("/team")}>
              <span className="av" style={AVATAR_TONES[i % AVATAR_TONES.length]} aria-hidden="true">
                {initials(a.fullName)}
              </span>
              <span className="t" style={{ textAlign: "left" }}>
                <span className="n">{a.fullName}</span>
                <span className={a.pendingAccept > 0 ? "s crit" : "s ok"}>
                  {a.pendingAccept > 0
                    ? `${a.pendingAccept} ${pluralizeRu(a.pendingAccept, ["заявка ждёт", "заявки ждут", "заявок ждут"])}`
                    : `${a.activeLoad} в работе, принято сегодня ${a.acceptedToday}`}
                </span>
              </span>
              <Phone className="i" aria-hidden="true" />
            </button>
          ))}
          {rest > 0 && (
            <button type="button" className="row morerow" onClick={() => setExpanded(true)}>
              <span className="t">
                <span className="n">Показать ещё ({rest})</span>
              </span>
            </button>
          )}
        </div>
      )}
    </MhSection>
  );
}
