import { todayLabel, pluralizeRu, relativeTime } from "../../lib/format";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Calendar, TriangleAlert, Users } from "lucide-react";
import { useAuthStore } from "../../store/auth";
import { useDashboardSummary } from "../../hooks/useDashboard";
import { useTeamLive, type UnacceptedLead } from "../../hooks/useTeamLive";
import { useConversations } from "../../hooks/useConversations";
import { HomeAppHeader, HomePageHead } from "./HomeHead";
import { HomeAsk } from "./HomeAsk";
import { TeamCharts } from "./TeamCharts";

/**
 * Мобильная Главная — оператор/диспетчер (роль Role.MANAGER: звонки и приём
 * лидов, номера клиентов всегда маскируются — ROLE_PRESETS.MANAGER в
 * permissions.ts, у неё нет clients.viewPhone/calls.transcripts/finance.*).
 *
 * Разметка перенесена дословно из прототипа темы «Royal Home 2026»
 * (`docs/pult/theme-2026/screens/home-manager.html`): `section.card.aib` с
 * «Горит сейчас» → карточки `.card.tight` с `.sec-h` и списками `.list`/`.row`
 * → `.sec-t` «Сегодня по команде» + `.tiles`.
 *
 * Данные и права не менялись: `useTeamLive` (те же 30-секундные живые счётчики,
 * что и десктопный виджет «Непринятые заявки») и `useDashboardSummary`.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ КНОПКИ ЗВОНКА. `UnacceptedLead` отдаёт только shortId, не
 * Client.id, а CRM-звонок (POST /clients/:id/call) требует настоящий UUID.
 * Поэтому строка целиком ведёт в /clients/:shortId, где кнопка звонка настоящая.
 *
 * Шапка `MobileHomeHeader` остаётся выше области `.rh2` — это рамка приложения
 * (договор §4), поэтому `.pg-h` эталона здесь не повторяется.
 */
export function ManagerHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const { data, isLoading: dashboardLoading } = useDashboardSummary();
  const {
    data: teamLive,
    isLoading: teamLoading,
    isError: teamError,
    error: teamErrorObj,
    refetch: refetchTeam,
  } = useTeamLive(true);
  /** «Сообщения без ответа» (артефакт c99db05f, renderHomeManager): право
   *  messages.view у роли уже есть (ROLE_PRESETS.MANAGER). Сервер не отдаёт
   *  отдельный счётчик непрочитанных диалогов — фильтруем честно на клиенте,
   *  тем же приёмом, что и «Ждут вашего принятия» на главной агента
   *  (PendingLeadsRows, AgentHome.tsx): один запрос первой страницы, флаг
   *  `unread` у элемента уже есть в ответе списка. */
  const { data: conversations, isLoading: conversationsLoading } = useConversations({});
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const listRef = useRef<HTMLDivElement>(null);
  const [restExpanded, setRestExpanded] = useState(false);
  const [teamExpanded, setTeamExpanded] = useState(false);
  const [unreadExpanded, setUnreadExpanded] = useState(false);

  const unreadConversations = (conversations?.items ?? []).filter((c) => c.unread);
  const visibleUnread = unreadExpanded ? unreadConversations : unreadConversations.slice(0, 5);

  const unaccepted = teamLive?.unaccepted ?? [];
  const [focus, ...rest] = unaccepted;
  const isLoading = dashboardLoading || teamLoading;
  const visibleRest = restExpanded ? rest : rest.slice(0, 5);
  const agents = teamLive?.agents ?? [];
  const visibleAgents = teamExpanded ? agents : agents.slice(0, 5);

  const scrollToList = () => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <HomeAppHeader firstName={firstName} />
      <div className="rh2 screens">
        <div className="scr" data-stagger ref={listRef}>
          <HomePageHead title="Главная" sub={`${agent?.fullName ?? ""}, менеджер. ${todayLabel()}. ${teamLive?.unacceptedTotal ?? 0} ${pluralizeRu(teamLive?.unacceptedTotal ?? 0, ["заявка ждёт", "заявки ждут", "заявок ждут"])} принятия.`} />
          <section className="card aib" aria-labelledby="aib-hi">
            <div className="aib-now">
              <i aria-hidden="true" />
              <span className="tx">слежу за непринятыми заявками и загрузкой команды</span>
            </div>
            <div className="aib-hd">
              <h2 className="aib-hi" id="aib-hi">
                Салом{firstName ? `, ${firstName}` : ""}. Сначала это:
              </h2>
            </div>

            <div className="aib-fire">
              <div className="aib-fh">
                <h3>Горит сейчас</h3>
                <span className="note">заявка ждёт дольше всех</span>
              </div>
              {isLoading ? (
                <div className="state">
                  <span className="sk w40" /> Загружаем непринятые заявки
                </div>
              ) : teamError ? (
                /* Отказ /dashboard/team-live НЕЛЬЗЯ показывать как «все лиды приняты»:
                   пустой массив при сбое связи — это не отчёт о работе, а её отсутствие
                   на экране, а вся смена оператора состоит из непринятых заявок. */
                <div className="state err">
                  <span className="dot crit" />
                  {teamErrorObj instanceof Error ? teamErrorObj.message : "Список не загрузился, проверьте соединение."}
                  <button type="button" className="lnk" onClick={() => refetchTeam()}>
                    Повторить
                  </button>
                </div>
              ) : focus ? (
                <div className="list">
                  <div className="row wrapt">
                    <span
                      className="av"
                      style={
                        focus.escalated && !focus.lost
                          ? { background: "var(--pink)", color: "var(--pink-ink)" }
                          : { background: "var(--sky)", color: "var(--sky-ink)" }
                      }
                      aria-hidden="true"
                    >
                      {focus.fullName?.[0]?.toUpperCase() ?? "?"}
                    </span>
                    <div className="t">
                      <b>
                        {focus.fullName}, ждёт {focus.waitingMinutes} мин без ответа
                      </b>
                      <span>
                        назначен {focus.agentName}
                        {focus.reassignCount > 0
                          ? `, уже ${focus.reassignCount} переназначений`
                          : ", дальше клиент решит, что про него забыли"}
                      </span>
                    </div>
                    {focus.lost ? (
                      <span className="chip mute">потерянный, вручную</span>
                    ) : (
                      focus.escalated && <span className="chip crit">никто не принял</span>
                    )}
                    <div className="act">
                      <button
                        className="pill sm"
                        type="button"
                        data-endpoint="GET /api/v1/clients"
                        onClick={() => navigate(`/clients/${focus.shortId}`)}
                      >
                        Открыть
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="quiet">
                  <span className="dot ok" />
                  <span className="txt">Все лиды приняты. Новые заявки появятся здесь сами.</span>
                </p>
              )}
            </div>

            {/* Доклад одной фразой — только из живой сводки команды. */}
            {teamLive && (
              <p className="aib-rep">
                Не приняты агентами сейчас{" "}
                <button className="lk" type="button" onClick={() => navigate("/clients?slice=pending")}>
                  {teamLive.unacceptedTotal} {pluralizeRu(teamLive.unacceptedTotal, ["заявка", "заявки", "заявок"])}
                </button>
                {unaccepted.length > 0
                  ? `, самая старая ждёт ${Math.max(...unaccepted.map((l) => l.waitingMinutes))} мин`
                  : ""}
                . С вышедшим таймером принятия <b>{teamLive.escalatedTotal}</b>, без агента{" "}
                <b>{teamLive.queuedTotal}</b>. В команде {teamLive.agents.length}{" "}
                {pluralizeRu(teamLive.agents.length, ["агент", "агента", "агентов"])}, свободных от заявок{" "}
                <b>{teamLive.agents.filter((a) => a.pendingAccept === 0).length}</b>.
              </p>
            )}
            <HomeAsk
              ariaLabel="Вопрос про работу команды"
              placeholder="Спросить: кто сейчас свободен для заявки?"
              suggestions={["Кто сейчас свободен для заявки?", "Почему заявки висят дольше обычного?"]}
            />
          </section>

          {/* «Входящие сейчас» артефакта показывает звонок, который идёт прямо
              сейчас (кто дозванивается, кто из операторов снял трубку). CRM
              хранит журнал звонков (useIncomingCalls) и свой активный разговор
              агента (useActiveCall), но не живой статус ВСЕХ линий команды —
              выдумывать «идёт звонок» из истории было бы неправдой, поэтому
              честная тихая строка вместо факта, которого нет. */}
          <div className="card tight">
            <div className="sec-h">
              <h2>Входящие сейчас</h2>
            </div>
            <p className="quiet">
              <span className="dot" />
              <span className="txt">
                Нет данных: CRM не хранит, кто из операторов сейчас на линии — только уже завершённые звонки
                («Звонки») и свой разговор в окне вызова.
              </span>
            </p>
          </div>

          {rest.length > 0 && (
            <div className="card tight">
              <div className="sec-h">
                <h2>Ждут распределения</h2>
                <span className="note">{rest.length} заявок, время идёт</span>
              </div>
              <div className="list">
                {visibleRest.map((lead) => (
                  <LeadRow key={lead.shortId} lead={lead} onOpen={() => navigate(`/clients/${lead.shortId}`)} />
                ))}
              </div>
              {!restExpanded && rest.length > visibleRest.length && (
                <button type="button" className="lnk" onClick={() => setRestExpanded(true)}>
                  Показать ещё ({rest.length - visibleRest.length})
                </button>
              )}
            </div>
          )}

          {/* «Кто сейчас свободен» эталона: разбивка по агентам, тот же useTeamLive,
              тот же 30-секундный тик. Без неё диспетчер видел только сумму. */}
          {agents.length > 0 && (
            <div className="card tight">
              <div className="sec-h">
                <h2>Кто сейчас свободен</h2>
                <span className="note">{agents.length} в команде</span>
              </div>
              <div className="list">
                {visibleAgents.map((a) => (
                  <div key={a.id} className="row wrapt">
                    <span className="av" aria-hidden="true">
                      {initials(a.fullName)}
                    </span>
                    <div className="t">
                      <b>{a.fullName}</b>
                      <span>
                        в работе {a.activeLoad}, ждут ответа {a.pendingAccept}, принял сегодня {a.acceptedToday}
                      </span>
                    </div>
                    {a.escalated > 0 ? (
                      <span className="chip crit">{a.escalated} просрочено</span>
                    ) : (
                      // Решение владельца (roles-check.md §4): у менеджера нет подписи
                      // «чем занят» — честное «свободен/занят» по загрузке, без запроса.
                      <span className={a.activeLoad > 0 ? "chip warn" : "chip ok"}>
                        {a.activeLoad > 0 ? "занят" : "свободен"}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {!teamExpanded && agents.length > visibleAgents.length && (
                <button type="button" className="lnk" onClick={() => setTeamExpanded(true)}>
                  Показать ещё ({agents.length - visibleAgents.length})
                </button>
              )}
            </div>
          )}

          {conversationsLoading ? (
            <div className="card tight">
              <div className="sec-h">
                <h2>Сообщения без ответа</h2>
              </div>
              <div className="state">
                <span className="sk w40" /> Загружаем переписки
              </div>
            </div>
          ) : (
            unreadConversations.length > 0 && (
              <div className="card tight">
                <div className="sec-h">
                  <h2>Сообщения без ответа</h2>
                  <span className="note">{unreadConversations.length}</span>
                </div>
                <div className="list">
                  {visibleUnread.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="row"
                      onClick={() => navigate(`/messages?open=${c.id}`)}
                    >
                      <span className="av" aria-hidden="true">
                        {(c.name ?? "?")[0]?.toUpperCase() ?? "?"}
                      </span>
                      <div className="t">
                        <b>{c.name ?? "Без имени"}</b>
                        <span>{c.lastMessage?.content?.trim() || "новое сообщение"}</span>
                      </div>
                      <span className="meta">{relativeTime(c.lastMessageAt)}</span>
                    </button>
                  ))}
                </div>
                {!unreadExpanded && unreadConversations.length > visibleUnread.length && (
                  <button type="button" className="lnk" onClick={() => setUnreadExpanded(true)}>
                    Показать ещё ({unreadConversations.length - visibleUnread.length})
                  </button>
                )}
              </div>
            )
          )}

          {data && teamLive && (
            <>
              <div className="sec-t">Сегодня по команде</div>
              <div className="tiles">
                <button type="button" className="tile" onClick={scrollToList}>
                  <div className="hd">
                    <span className="ic" aria-hidden="true">
                      <Users className="i" strokeWidth={1.5} />
                    </span>
                    Не приняты
                    <span className={teamLive.unacceptedTotal > 0 ? "dot" : "dot ok"} aria-hidden="true" />
                  </div>
                  <b>{teamLive.unacceptedTotal}</b>
                  <small>заявки без агента</small>
                </button>
                <button type="button" className="tile" onClick={scrollToList}>
                  <div className="hd">
                    <span className="ic" aria-hidden="true">
                      <TriangleAlert className="i" strokeWidth={1.5} />
                    </span>
                    Эскалации
                    <span className={teamLive.escalatedTotal > 0 ? "dot crit" : "dot ok"} aria-hidden="true" />
                  </div>
                  <b>{teamLive.escalatedTotal}</b>
                  <small className={teamLive.escalatedTotal > 0 ? "crit" : undefined}>таймер принятия вышел</small>
                </button>
                <button type="button" className="tile" onClick={() => navigate("/calendar")}>
                  <div className="hd">
                    <span className="ic" aria-hidden="true">
                      <Calendar className="i" strokeWidth={1.5} />
                    </span>
                    Показы, 7 дней
                    <span className="dot ok" aria-hidden="true" />
                  </div>
                  <b>{data.kpis.showingsWeek}</b>
                  <small>по всей команде</small>
                </button>
              </div>
            </>
          )}

          {/* Графики по команде (28.09.2026) — тот же компонент, что на пульте
              директора и на телефоне. Деньги менеджеру сервер не отдаёт. */}
          <TeamCharts host="screen" />
        </div>
      </div>
    </>
  );
}

function initials(fullName: string): string {
  return (
    fullName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "•"
  );
}

function LeadRow({ lead, onOpen }: { lead: UnacceptedLead; onOpen: () => void }) {
  return (
    <button type="button" className="row" onClick={onOpen}>
      <span className={lead.lost ? "dot ok" : lead.escalated ? "dot crit" : "dot"} aria-hidden="true" />
      <div className="t">
        <b>{lead.fullName}</b>
        <span>
          {lead.agentName}, ждёт {lead.waitingMinutes} мин
          {lead.reassignCount > 0 ? `, ${lead.reassignCount} переназначений` : ""}
        </span>
      </div>
      {lead.lost ? (
        <span className="chip mute">потерянный</span>
      ) : (
        lead.escalated && <span className="chip crit">просрочено</span>
      )}
    </button>
  );
}
