import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { absenceLabel } from "../lib/absenceLabel";
import { useCan } from "../lib/permissions";
import { useTeam, useTeamStages, type TeamMember, type TeamStages, type TeamStagesAgent } from "../hooks/useTeam";
import { HallOfFameBoard, TopAgentsBoard, useHallOfFame, useTopAgents } from "./HallOfFame";
import { PointsJournalModal } from "../components/PointsJournalModal";
import { HandoverModal } from "../components/HandoverModal";
import { FreezeAgentModal } from "../components/FreezeAgentModal";
import { ROLE_LABELS } from "../lib/roles";
import type { Role } from "@royal-home/shared";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { formatMoney, pluralizeRu, relativeTime } from "../lib/format";
import { CLIENT_STATUS_LABELS } from "../lib/clientFormat";
import type { ClientStatus } from "@royal-home/shared";
import { initials, presenceOf } from "../lib/theme2026Person";
import { avatarTone } from "../lib/avatarTone";
import { scrollableRegion } from "../lib/a11y";
import { useSyncFiltersToUrl } from "../hooks/useUrlFilters";
import { loadState } from "../lib/teamLoad";
import { TeamTabs } from "../components/SectionTabs";
import { useCleanShell } from "../hooks/useCleanShell";

/** Статусы, которые показывает мини-разбивка «по этапам» на строке агента
 *  (экран «Команда по этапам», антифрод, мозговой штурм владельца 20-21.08.2026):
 *  только живая нагрузка, LOST/DEAL_CLOSED/ARCHIVED здесь не нужны, это уже не
 *  портфель, за которым нужно следить руководству. */
const STAGE_BADGE_STATUSES: ClientStatus[] = ["NEW", "CONTACTED", "HOT", "COLD", "UNRESPONSIVE"];

/** Достижения месяца: по одному значку на номинацию, только среди активных с ненулевым результатом.
 *  Комиссия приходит null у смотрящего без finance.view (ночная проверка 24.09.2026, №159/М4) —
 *  такие карточки просто не участвуют в номинации, а не считаются нулём. */
function achievementsOf(team: TeamMember[]) {
  const active = team.filter((m) => m.isActive);
  const top = (metric: (m: TeamMember) => number | null) => {
    const scored = active
      .map((m) => ({ id: m.id, value: metric(m) }))
      .filter((x): x is { id: string; value: number } => x.value !== null);
    const best = [...scored].sort((a, b) => b.value - a.value)[0];
    return best && best.value > 0 ? best.id : null;
  };
  return {
    commission: top((m) => m.month.commission),
    deals: top((m) => m.month.dealsCompleted),
    showings: top((m) => m.month.showings),
    speed:
      [...active]
        .filter((m) => m.month.avgAcceptMinutes !== null)
        .sort((a, b) => (a.month.avgAcceptMinutes ?? 1e9) - (b.month.avgAcceptMinutes ?? 1e9))[0]?.id ?? null,
  };
}

/** Ряд чипов. Раньше стоял класс `.wrap` — это КОНТЕЙНЕР страницы в теме
 *  (max-width 1320px и поля 28px, без flex): чипы шли столбиком, а на телефоне
 *  строка агента раздувалась шире экрана. */
const CHIP_ROW: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 };
/** Узкая строка агента: текст на всю ширину, кнопки переносятся под ним. */
const NARROW_ROW: CSSProperties = { cursor: "pointer", flexWrap: "wrap" };

/**
 * Единая страница команды: сверху доска почёта (видна всем), ниже рейтинг
 * Royal Score и вся команда. Руководство видит полные показатели каждого,
 * агент только коллег (имя/фото/онлайн), без чужих коммерческих цифр.
 *
 * ОБЛИК: дословный перенос утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/team.html). Разметка и подписи взяты из
 * прототипа, классы прототипные (`.scr`, `.pg-h`, `.sec`, `.card.tight`,
 * `.seg`, `.tbl`, `.list`/`.row`, `.solve`, `.rank`, `.nom`), а не Tailwind
 * приложения: экран включает эталон обёрткой `<div className="rh2 screens">`, стили
 * приходят из apps/web/src/theme-2026-proto.css.
 */
export function Team() {
  // 22.09.2026: отдельный мобильный экран (components/mobile/MobileTeam.tsx)
  // удалён — он нёс только упрощённое повторение разметки (фильтр из трёх
  // чипов, строка «аватар/имя/статус») и молча терял всю управленческую часть
  // ниже: «Нагрузка», «Решить сейчас», месячные показатели, разбивку портфеля,
  // действия и матрицу «по стадиям» — директор с телефона их не видел (см.
  // CLAUDE.md, «Desktop и mobile ship together»). Узкую раскладку теперь делают
  // сами медиазапросы темы (`.only-wide`/`.only-narrow`, theme-2026-proto.css),
  // как и на Profile/Finance/Reports/Sources/Archive/Oversight/Activity.
  return <TeamDesktop />;
}

/** Шторка «Фильтры» (макет `#sh-team-filters`): роль и состояние сотрудника. */
type TeamState = "all" | "online" | "frozen" | "limit";

/** Роли в порядке сегмента макета; показываются только те, что есть в команде. */
const SHEET_ROLES: Role[] = ["AGENT", "MANAGER", "MARKETING", "EDITOR", "SECURITY"];

/**
 * Нагрузка агента относительно лимита из Настроек (тот же счётчик, что
 * останавливает раздачу, см. lib/leadLimits.ts на сервере). «Близко» = остался
 * один слот: в макете 5 из 6 подсвечено жёлтым, 6 из 6 красным.
 */


/** Активные агенты, которым раздача может дать лид (замороженный не получает ничего). */
function takingAgents(team: TeamMember[]): TeamMember[] {
  return team.filter((m) => m.role === "AGENT" && m.isActive && !m.frozen);
}

/** Полоса «5 из 6» (макет `.loadbar[.near|.full]`). Без лимита — только число. */
function LoadBar({ member, compact = false }: { member: TeamMember; compact?: boolean }) {
  const state = loadState(member);
  if (state === "nolimit") {
    return compact ? null : (
      <span className="loadbar">
        <span className="n">{member.activeLoad}, без лимита</span>
      </span>
    );
  }
  const v = Math.min(1, member.activeLoad / member.leadLimit);
  return (
    <span
      className={`loadbar${state === "near" ? " near" : state === "full" ? " full" : ""}`}
      style={compact ? { maxWidth: 96, minWidth: 72 } : undefined}
      // aria-label на span допустим только с ролью (axe aria-prohibited-attr).
      role="img"
      aria-label={`Нагрузка ${member.activeLoad} из ${member.leadLimit}`}
    >
      <span className="bar">
        <i style={{ "--v": v } as CSSProperties} />
      </span>
      {!compact && (
        <span className="n">
          {member.activeLoad} из {member.leadLimit}
        </span>
      )}
    </span>
  );
}

type TeamFilter = "all" | "agents" | "managers" | "frozen";

function TeamDesktop() {
  const clean = useCleanShell();
  const can = useCan();
  const isSupervisor = can("team.viewFull");
  const { data: team, isLoading: teamLoading, isError: teamError, refetch: refetchTeam } = useTeam(isSupervisor);
  const { data: stages } = useTeamStages(isSupervisor);
  const stagesById = new Map((stages?.agents ?? []).map((a) => [a.id, a]));
  const { data: fame, isLoading: fameLoading, isError: fameError, refetch: refetchFame } = useHallOfFame();
  const { data: top } = useTopAgents();
  const canManageAgents = can("agents.manage");
  // Комиссия — отдельное право (ночная проверка 24.09.2026, №159/М4): экран
  // открыт team.viewFull, у менеджера оно есть, деньги — нет.
  const seesMoney = can("finance.view");
  const [pointsFor, setPointsFor] = useState<TeamMember | null>(null);
  const [handoverFor, setHandoverFor] = useState<TeamMember | null>(null);
  const [freezeFor, setFreezeFor] = useState<TeamMember | null>(null);
  const [filter, setFilter] = useState<TeamFilter>("all");
  const [showFilters, setShowFilters] = useState(false);
  // Плитки-источники («монтажёра в работе» и т.п.) ведут сюда с ?role=<роль>,
  // чтобы открыть список сразу отфильтрованным (один клик от красного числа до
  // сотрудника). Неизвестное значение — как без параметра, экран не ломаем.
  const [roleFilterUrlParams] = useSearchParams();
  const [roleFilter, setRoleFilter] = useState<Role | null>(() => {
    const fromUrl = roleFilterUrlParams.get("role");
    return fromUrl && fromUrl in ROLE_LABELS ? (fromUrl as Role) : null;
  });
  const [stateFilter, setStateFilter] = useState<TeamState>("all");
  const [showStages, setShowStages] = useState(false);
  const sheetFilters = (roleFilter ? 1 : 0) + (stateFilter !== "all" ? 1 : 0);
  // Карточка сотрудника — отдельный экран `/team/:id` (не шторка, 20.09.2026:
  // шторка AgentOverviewModal и мобильный экран разъехались содержимым, см.
  // docs/archive/employee-card-brief-20-09.md, «Почему шторка удаляется»). Открывается
  // одинаково на ПК и на телефоне.
  const navigate = useNavigate();
  const openAgent = useCallback((agentId: string) => navigate(`/team/${agentId}`), [navigate]);

  /**
   * ?agent=<id> — старые ссылки на карточку (например, с главной, «Владелец
   * 10.08.2026: чтобы всегда переходить к проблемам»). Переадресуем на
   * `/team/<id>`, а не открываем шторку, которой больше нет: старые адреса
   * обязаны продолжать работать.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const requested = searchParams.get("agent");
    if (!requested || !isSupervisor) return;
    navigate(`/team/${requested}`, { replace: true });
  }, [searchParams, isSupervisor, navigate]);

  useSyncFiltersToUrl(searchParams, setSearchParams, { role: roleFilter ?? undefined });

  const achievements = team ? achievementsOf(team) : null;
  // Счёт и место: из того же /hall-of-fame/top-agents, что и рейтинг выше.
  // В /team счёта Royal Score нет, выдумывать его нельзя.
  const rankById = new Map((top?.agents ?? []).map((a) => [a.id, a]));

  const counts = useMemo(() => {
    const list = team ?? [];
    return {
      all: list.length,
      agents: list.filter((m) => m.role === "AGENT").length,
      managers: list.filter((m) => m.role === "MANAGER").length,
      frozen: list.filter((m) => m.frozen).length,
    };
  }, [team]);

  const visible = useMemo(() => {
    let list = team ?? [];
    if (filter === "agents") list = list.filter((m) => m.role === "AGENT");
    else if (filter === "managers") list = list.filter((m) => m.role === "MANAGER");
    else if (filter === "frozen") list = list.filter((m) => m.frozen);
    if (roleFilter) list = list.filter((m) => m.role === roleFilter);
    if (stateFilter === "online") list = list.filter((m) => m.online);
    else if (stateFilter === "frozen") list = list.filter((m) => m.frozen);
    else if (stateFilter === "limit") list = list.filter((m) => loadState(m) === "full");
    return list;
  }, [team, filter, roleFilter, stateFilter]);
  const online = (team ?? []).filter((m) => m.online).length;
  const frozenMembers = (team ?? []).filter((m) => m.frozen);
  const rolesPresent = SHEET_ROLES.filter((r) => (team ?? []).some((m) => m.role === r));
  /**
   * Карточка «Нагрузка» (макет): сколько агентов берут работу, сколько у
   * последнего слота, сколько упёрлись в лимит. Считаются только активные и
   * не замороженные агенты: замороженный лиды не получает независимо от
   * портфеля, он в «Решить сейчас».
   */
  const load = useMemo(() => {
    const agents = takingAgents(team ?? []);
    const limit = agents[0]?.leadLimit ?? 0;
    const free = agents.filter((m) => loadState(m) === "free").length;
    const near = agents.filter((m) => loadState(m) === "near").length;
    const full = agents.filter((m) => loadState(m) === "full").length;
    const total = agents.reduce((n, m) => n + m.activeLoad, 0);
    return { agents: agents.length, limit, free, near, full, total };
  }, [team]);

  if (!isSupervisor) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Команда</h1>
              <p className="sub">
                Показатели за текущий месяц. Их видит только руководство: агент видит свои цифры и своё место,
                чужие только по номинациям.
              </p>
            </div>
          </div>

          <TeamTabs />

          <HallOfFameBoard />
          <TopAgentsBoard />

          <div className="sec">
            <div className="sec-h">
              <h2>Вся команда</h2>
              <span className="note">
                {fame ? `${fame.team.length} ${pluralizeRu(fame.team.length, ["человек", "человека", "человек"])}` : "коллеги"}
              </span>
            </div>
            <div className="card tight">
              <p className="state">Ваши коллеги. Показатели каждого видит только руководство.</p>
              {fameLoading ? (
                <div className="state">
                  <span className="sk av" />
                  <span className="sk w28" />
                  <span className="sk w22" /> Загружаем команду
                </div>
              ) : fameError ? (
                <div className="state err">
                  <span className="dot crit" /> Список коллег не загрузился. Это сбой связи, а не пустая команда.{" "}
                  <button
                    className="lk"
                    type="button"
                    style={{ color: "inherit", textDecoration: "underline" }}
                    onClick={() => refetchFame()}
                  >
                    Повторить
                  </button>
                </div>
              ) : !fame?.team.length ? (
                <div className="empty">
                  <span className="ic">
                    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 21a8 8 0 0 1 16 0" />
                    </svg>
                  </span>
                  <p>В команде пока никого нет. Заведите первого сотрудника в настройках агентства.</p>
                </div>
              ) : (
                <div className="list">
                  {fame.team.map((m) => (
                    <div className="row" key={m.id}>
                      <span className={m.online ? "av ring" : "av ring off"} style={avatarTone(m.fullName)}>
                        {m.avatarUrl ? (
                          <img src={m.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                        ) : (
                          initials(m.fullName)
                        )}
                        <span className={m.online ? "pres on" : "pres"} />
                      </span>
                      <div className="t">
                        <b title={m.fullName}>{m.fullName}</b>
                        <span>{m.online ? "в сети" : "не в сети"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Команда</h1>
            <p className="sub">
              Показатели за текущий месяц. Их видит только руководство: агент видит свои цифры и своё место,
              чужие только по номинациям.
            </p>
          </div>
          <div className="acts">
            <button className="pill ghost" type="button" onClick={() => setShowFilters(true)}>
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M7 12h10M10 18h4" />
              </svg>
              Фильтры{sheetFilters > 0 ? ` ${sheetFilters}` : ""}
            </button>
            <button
              className="pill ghost"
              type="button"
              aria-pressed={showStages}
              onClick={() => setShowStages((v) => !v)}
            >
              По стадиям клиентов
            </button>
          </div>
        </div>

        <TeamTabs />

        {/* Нагрузка по лимиту лидов (макет `.prog.split`). Без лимита в Настройках
            полосу строить не из чего: честная строка вместо выдуманной шкалы. */}
        {(team?.length ?? 0) > 0 && (
          <div className="card tight">
            <div className="sec-h">
              <h2>Нагрузка</h2>
              <span className="note">
                {load.limit > 0 ? `Лимит ${load.limit} активных клиентов на агента` : "Лимит лидов выключен в настройках"}
              </span>
            </div>
            {load.limit > 0 && load.agents > 0 ? (
              <>
                <div className="prog split" aria-hidden="true">
                  {load.free > 0 && <i style={{ "--v": load.free, background: "var(--ok)" } as CSSProperties} />}
                  {load.near > 0 && <i style={{ "--v": load.near, background: "var(--warn-dot)" } as CSSProperties} />}
                  {load.full > 0 && <i style={{ "--v": load.full, background: "var(--crit)" } as CSSProperties} />}
                </div>
                <div className="prog-legend">
                  <span>
                    <b>{load.free}</b>берут работу
                  </span>
                  <span>
                    <b>{load.near}</b>близко к лимиту
                  </span>
                  <span>
                    <b>{load.full}</b>у лимита, лиды не идут
                  </span>
                </div>
              </>
            ) : (
              <p className="state">
                {load.agents === 0
                  ? "Активных агентов нет, раздавать лиды некому."
                  : `Раздача идёт без предела: у ${load.agents} ${pluralizeRu(load.agents, ["агента", "агентов", "агентов"])} в работе ${load.total} ${pluralizeRu(load.total, ["клиент", "клиента", "клиентов"])}.`}
              </p>
            )}
          </div>
        )}

        {/* Решения одной кнопкой. Строка появляется, только если есть кого размораживать. */}
        {canManageAgents && frozenMembers.length > 0 && (
          <div className="card tight">
            <div className="sec-h">
              <h2>Решить сейчас</h2>
              <span className="note">
                {frozenMembers.length} {pluralizeRu(frozenMembers.length, ["строка", "строки", "строк"])}
              </span>
            </div>
            {frozenMembers.map((m) => (
              <div className="solve" key={m.id}>
                <span className="t">
                  <button className="lk" type="button" onClick={() => openAgent(m.id)}>
                    {m.fullName}
                  </button>{" "}
                  {/* Вид и срок вместо общего «заморожен» (владелец 09.09.2026):
                      руководителю нужно «в отпуске до 20 сентября», а не факт
                      заморозки — от вида зависит и судьба вернувшегося клиента. */}
                  {absenceLabel(m)}
                  {m.frozenAt ? `, с ${relativeTime(m.frozenAt)}` : ""}.
                  {m.frozenReason ? ` Причина: ${m.frozenReason}.` : ""} Новые лиды ему не приходят.
                </span>
                <span className="acts">
                  <button className="pill sm" type="button" onClick={() => setFreezeFor(m)}>
                    Вернуть в строй
                  </button>
                  <button className="lnk" type="button" onClick={() => openAgent(m.id)}>
                    Открыть
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Доска почёта и топ агентов — в одном ряду на широком экране
            (`.cols2`, theme-royal-home-2026.css): обе невысокие и независимые,
            порознь занимали два ряда из трёх экранных. Таблица «Вся команда»
            ниже остаётся однорядной: девять колонок. Ниже 1280 px порядок
            прежний. */}
        {clean ? (
          <details className="clean-team-recognition card tight">
            <summary>Достижения и рейтинг команды</summary>
            <div className="cols2"><HallOfFameBoard /><TopAgentsBoard /></div>
          </details>
        ) : (
          <div className="cols2"><HallOfFameBoard /><TopAgentsBoard /></div>
        )}

        <div className="sec">
          <div className="sec-h">
            <h2>Вся команда</h2>
            <span className="note">
              {counts.all} {pluralizeRu(counts.all, ["человек", "человека", "человек"])}, {online} в сети
            </span>
          </div>

          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Кого показывать">
              {(
                [
                  ["all", "Все", counts.all],
                  ["agents", "Агенты", counts.agents],
                  ["managers", "Менеджеры", counts.managers],
                  ["frozen", "Заморожены", counts.frozen],
                ] as const
              ).map(([key, label, n]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {label} <span className="n">{n}</span>
                </button>
              ))}
            </div>
          </div>

          {showStages && <StagesMatrix team={team ?? []} stages={stages} onOpen={openAgent} />}

          {teamLoading ? (
            <div className="card tight" style={{ marginTop: 12 }}>
              <div className="state">
                <span className="sk av" />
                <span className="sk w28" />
                <span className="sk w22" /> Загружаем команду
              </div>
            </div>
          ) : teamError ? (
            <div className="card tight" style={{ marginTop: 12 }}>
              <div className="state err">
                <span className="dot crit" /> Команда не загрузилась. Это сбой связи, а не пустой штат.{" "}
                <button
                  className="lk"
                  type="button"
                  style={{ color: "inherit", textDecoration: "underline" }}
                  onClick={() => refetchTeam()}
                >
                  Повторить
                </button>
              </div>
            </div>
          ) : !team?.length ? (
            <div className="card tight" style={{ marginTop: 12 }}>
              <div className="empty">
                <span className="ic">
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21a8 8 0 0 1 16 0" />
                  </svg>
                </span>
                <p>В команде пока никого нет. Заведите первого сотрудника в настройках агентства.</p>
              </div>
            </div>
          ) : (
            <>
              {/* Широкий экран: таблица прототипа. */}
              <div className="card tight only-wide" style={{ marginTop: 12 }}>
                <div className="tbl-wrap" {...scrollableRegion("Команда")}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">Сотрудник</th>
                        <th scope="col">Нагрузка</th>
                        <th scope="col">Лиды</th>
                        <th scope="col">Показы</th>
                        <th scope="col">Сделки</th>
                        {seesMoney && <th scope="col" className="num">Комиссия</th>}
                        <th scope="col" className="num">Счёт</th>
                        <th scope="col">Место</th>
                        <th scope="col"><span className="vh">Действия</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((m) => {
                        const rank = rankById.get(m.id);
                        const pres = presenceOf(m);
                        return (
                          /* Вся строка ведёт в карточку сотрудника — как строка клиента
                             (Clients.tsx) и строка объекта (PropertyRow.tsx), и как та же
                             строка на узком экране (`.only-narrow` ниже). До 21.09.2026 на ПК
                             открывало только имя: по остальной строке человек кликал и
                             ничего не происходило, что читалось как «не работает».
                             Кнопки внутри строки гасят всплытие — иначе «Передать дела»
                             заодно уводило бы с экрана. */
                          <tr
                            key={m.id}
                            onClick={() => openAgent(m.id)}
                            style={{ cursor: "pointer" }}
                          >
                            <td>
                              <span className="wrap">
                                <span className={pres.avClass} style={avatarTone(m.fullName)}>
                                  {m.avatarUrl ? (
                                    <img src={m.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                                  ) : (
                                    initials(m.fullName)
                                  )}
                                  <span className={pres.dotClass} />
                                </span>
                                <span>
                                  {/* Имя остаётся кнопкой ради клавиатуры и чтецов экрана
                                      (по строке `<tr>` с клавиатуры не пройти), но гасит
                                      всплытие, чтобы обработчик строки не сработал вторым. */}
                                  <button
                                    className="lk"
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); openAgent(m.id); }}
                                  >
                                    {m.fullName}
                                  </button>
                                  <span
                                    style={{ display: "block", fontSize: "var(--fs-12)", color: m.frozen ? "var(--crit)" : "var(--faint)" }}
                                  >
                                    {ROLE_LABELS[m.role]}
                                    {m.frozen
                                      ? `, ${absenceLabel(m)}`
                                      : !m.isActive
                                        ? ", деактивирован"
                                        : m.online
                                          ? ", в сети"
                                          : m.lastSeenAt
                                            ? `, был(а) ${relativeTime(m.lastSeenAt)}`
                                            : ""}
                                  </span>
                                  {/* Достижения месяца и разбивка портфеля по этапам: в макете
                                      этих данных нет, поэтому они одеты в прототипные `.chip`,
                                      а не в свою вёрстку. */}
                                  <TeamChips
                                    member={m}
                                    achievements={achievements}
                                    stages={stagesById.get(m.id)}
                                  />
                                </span>
                              </span>
                            </td>
                            <td>
                              {m.role === "AGENT" ? <LoadBar member={m} /> : <span className="faint">нет</span>}
                            </td>
                            <td>{m.month.leads}</td>
                            <td>{m.month.showings}</td>
                            <td>{m.month.dealsCompleted}</td>
                            {seesMoney && (
                              <td className="num">
                                <span className="money">{formatMoney(m.month.commission ?? 0, "TJS")}</span>
                              </td>
                            )}
                            <td className="num">
                              <b>{rank?.score ?? "нет"}</b>
                            </td>
                            <td>{rank ? `${rank.place} из ${top?.agents.length ?? 0}` : "нет"}</td>
                            <td>
                              <span className="wrap">
                                {canManageAgents && (
                                  <>
                                    <button
                                      className="pill ghost sm"
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setFreezeFor(m); }}
                                    >
                                      {m.frozen ? "Вернуть в строй" : "Отпуск / больничный"}
                                    </button>
                                    <button
                                      className="pill ghost sm"
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setHandoverFor(m); }}
                                    >
                                      Передать дела
                                    </button>
                                  </>
                                )}
                                {/* Это НЕ Royal Score: архивный журнал ручных начислений до
                                    запрета Fair Play. Подпись отделяет их друг от друга,
                                    иначе ноль здесь рядом с рейтингом читается как баг. */}
                                <button
                                  className="lnk"
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setPointsFor(m); }}
                                >
                                  {m.points} бонусных {pluralizeRu(m.points, ["балл", "балла", "баллов"])} (архив)
                                </button>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="state">
                  Показаны {visible.length} из {counts.all}. Счёт и место берутся из рейтинга Royal Score.
                </p>
              </div>

              {/* Узкий экран: те же люди строками. */}
              <div className="card tight only-narrow" style={{ marginTop: 12 }}>
                <div className="list">
                  {visible.map((m) => {
                    const rank = rankById.get(m.id);
                    const pres = presenceOf(m);
                    return (
                      <div className="row" key={m.id} onClick={() => openAgent(m.id)} style={NARROW_ROW}>
                        <span className={pres.avClass} style={avatarTone(m.fullName)}>
                          {m.avatarUrl ? (
                            <img src={m.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                          ) : (
                            initials(m.fullName)
                          )}
                          <span className={pres.dotClass} />
                        </span>
                        <div className="t" style={{ flex: "1 1 0", minWidth: 0 }}>
                          <b>
                            <button className="lk" type="button" onClick={(e) => { e.stopPropagation(); openAgent(m.id); }}>
                              {m.fullName}
                            </button>
                          </b>
                          <span>
                            {ROLE_LABELS[m.role]}
                            {m.frozen
                              ? `, ${absenceLabel(m)}`
                              : !m.isActive
                                ? ", деактивирован"
                                : m.online
                                  ? ", в сети"
                                  : m.lastSeenAt
                                    ? `, был(а) ${relativeTime(m.lastSeenAt)}`
                                    : ""}
                            {m.role === "AGENT" && m.leadLimit > 0
                              ? `, портфель ${m.activeLoad} из ${m.leadLimit}${loadState(m) === "full" ? ", лиды не идут" : ""}`
                              : ""}
                          </span>
                          {/* Месячные показатели (макет `.tbl` не знает узкого экрана):
                              те же цифры, что в колонках десктопной таблицы, чипами. */}
                          <span style={CHIP_ROW}>
                            <span className="chip mute">Лиды: {m.month.leads}</span>
                            <span className="chip mute">Показы: {m.month.showings}</span>
                            <span className="chip mute">Сделки: {m.month.dealsCompleted}</span>
                            {seesMoney && <span className="chip mute">Комиссия: {formatMoney(m.month.commission ?? 0, "TJS")}</span>}
                            <span className="chip mute">Счёт: {rank?.score ?? "нет"}</span>
                            <span className="chip mute">
                              Место: {rank ? `${rank.place} из ${top?.agents.length ?? 0}` : "нет"}
                            </span>
                          </span>
                          <TeamChips member={m} achievements={achievements} stages={stagesById.get(m.id)} />
                        </div>
                        {m.role === "AGENT" && (
                          <div style={{ flexBasis: "100%" }}>
                            <LoadBar member={m} compact />
                          </div>
                        )}
                        {canManageAgents && (
                          <div className="act" style={{ flexBasis: "100%", flexWrap: "wrap", justifyContent: "flex-start" }}>
                            <button className="pill ghost sm" type="button" onClick={(e) => { e.stopPropagation(); setFreezeFor(m); }}>
                              {m.frozen ? "Вернуть в строй" : "Отпуск / больничный"}
                            </button>
                            <button className="pill ghost sm" type="button" onClick={(e) => { e.stopPropagation(); setHandoverFor(m); }}>
                              Передать дела
                            </button>
                            <button className="lnk" type="button" onClick={(e) => { e.stopPropagation(); setPointsFor(m); }}>
                              {m.points} бонусных {pluralizeRu(m.points, ["балл", "балла", "баллов"])} (архив)
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="state">
                  Показаны {visible.length} из {counts.all}. Счёт и место берутся из рейтинга Royal Score.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {showFilters && (
        <Rh2Sheet
          title="Фильтры"
          onClose={() => setShowFilters(false)}
          ariaLabel="Фильтры команды"
          footer={
            <>
              <button
                className="pill ghost"
                type="button"
                onClick={() => {
                  setRoleFilter(null);
                  setStateFilter("all");
                }}
              >
                Сбросить
              </button>
              <button className="pill" type="button" onClick={() => setShowFilters(false)}>
                Показать {visible.length}
              </button>
            </>
          }
        >
          <div className="sec-t" style={{ marginTop: 0 }}>
            Роль
          </div>
          <div className="seg" role="group" aria-label="Роль">
            <button type="button" aria-selected={roleFilter === null} onClick={() => setRoleFilter(null)}>
              Любая
            </button>
            {rolesPresent.map((r) => (
              <button key={r} type="button" aria-selected={roleFilter === r} onClick={() => setRoleFilter(r)}>
                {ROLE_LABELS[r]}
              </button>
            ))}
          </div>
          <div className="sec-t">Состояние</div>
          <div className="seg" role="group" aria-label="Состояние">
            {(
              [
                ["all", "Все"],
                ["online", "В сети"],
                ["frozen", "Заморожены"],
                ["limit", "У лимита"],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" aria-selected={stateFilter === key} onClick={() => setStateFilter(key)}>
                {label}
              </button>
            ))}
          </div>
        </Rh2Sheet>
      )}
      {handoverFor && <HandoverModal agent={handoverFor} onClose={() => setHandoverFor(null)} />}
      {freezeFor && <FreezeAgentModal agent={freezeFor} onClose={() => setFreezeFor(null)} />}
      {pointsFor && (
        <PointsJournalModal agentId={pointsFor.id} agentName={pointsFor.fullName} onClose={() => setPointsFor(null)} />
      )}
    </div>
  );
}

/**
 * «По стадиям клиентов» (кнопка шапки, макет: `GET /team/stages`): у кого сколько
 * клиентов на каком статусе, показов назначено и сделок в работе. Антифрод-
 * экран из штурма владельца 20-21.08.2026, раньше жил только значками на строке.
 */
function StagesMatrix({
  team,
  stages,
  onOpen,
}: {
  team: TeamMember[];
  stages: TeamStages | undefined;
  onOpen: (id: string) => void;
}) {
  const byId = new Map((stages?.agents ?? []).map((a) => [a.id, a]));
  const agents = team.filter((m) => m.role === "AGENT");
  const statuses = stages?.statuses ?? [];
  return (
    <div className="card tight" style={{ marginTop: 12 }}>
      <div className="sec-h">
        <h2>По стадиям клиентов</h2>
        <span className="note">Портфель каждого агента прямо сейчас, не за месяц</span>
      </div>
      {!stages ? (
        <p className="state">Считаем портфели по стадиям</p>
      ) : agents.length === 0 ? (
        <p className="state">Агентов в команде нет, раскладывать по стадиям некого.</p>
      ) : (
        <div className="tbl-wrap" {...scrollableRegion("Агенты по стадиям")}>
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">Агент</th>
                {statuses.map((s) => (
                  <th scope="col" className="num" key={s}>
                    {CLIENT_STATUS_LABELS[s]}
                  </th>
                ))}
                <th scope="col" className="num">Показы</th>
                <th scope="col" className="num">Сделки</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((m) => {
                const row = byId.get(m.id);
                return (
                  <tr key={m.id}>
                    <td>
                      <button className="lk" type="button" onClick={() => onOpen(m.id)}>
                        {m.fullName}
                      </button>
                    </td>
                    {statuses.map((s) => (
                      <td className="num" key={s}>
                        {row?.byStatus[s] ?? 0}
                      </td>
                    ))}
                    <td className="num">{row?.showingsScheduled ?? 0}</td>
                    <td className="num">{row?.dealsInProgress ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Значки, которых в макете команды нет, но которые экран умеет и терять их
 * нельзя: достижения месяца и разбивка портфеля по этапам (антифрод, штурм
 * владельца 20-21.08.2026). Одеты в прототипные `.chip`, чтобы не отличаться
 * от остальных пометок темы.
 */
function TeamChips({
  member,
  achievements,
  stages,
}: {
  member: TeamMember;
  achievements: ReturnType<typeof achievementsOf> | null;
  stages: TeamStagesAgent | undefined;
}) {
  const statusChips = stages ? STAGE_BADGE_STATUSES.filter((s) => (stages.byStatus[s] ?? 0) > 0) : [];
  const hasAchievement =
    achievements !== null &&
    (achievements.commission === member.id ||
      achievements.deals === member.id ||
      achievements.showings === member.id ||
      achievements.speed === member.id);
  const hasStages =
    statusChips.length > 0 || (stages?.showingsScheduled ?? 0) > 0 || (stages?.dealsInProgress ?? 0) > 0;
  if (!hasAchievement && !hasStages) return null;

  return (
    <span style={CHIP_ROW}>
      {achievements?.commission === member.id && <span className="chip warn">Лучшая комиссия</span>}
      {achievements?.deals === member.id && <span className="chip ok">Больше всех сделок</span>}
      {achievements?.showings === member.id && <span className="chip ok">Больше всех показов</span>}
      {achievements?.speed === member.id && <span className="chip">Быстрее всех берёт лиды</span>}
      {statusChips.map((s) => (
        <span className="chip mute" key={s}>
          {CLIENT_STATUS_LABELS[s]}: {stages?.byStatus[s]}
        </span>
      ))}
      {(stages?.showingsScheduled ?? 0) > 0 && (
        <span className="chip mute">Показов назначено: {stages?.showingsScheduled}</span>
      )}
      {(stages?.dealsInProgress ?? 0) > 0 && <span className="chip mute">Сделок в работе: {stages?.dealsInProgress}</span>}
    </span>
  );
}
