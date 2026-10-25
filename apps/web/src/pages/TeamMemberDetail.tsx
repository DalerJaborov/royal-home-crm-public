import { ShellOwnHeader } from "../components/rh2/ShellOwnHeader";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useGoBack } from "../hooks/useGoBack";
import { ChevronLeft, ChevronRight, Headphones, Mail, Phone } from "lucide-react";
import { CLIENT_STATUS_LABELS, daysOffSentenceRu, formatClientCode, type ClientStatus } from "@royal-home/shared";
import { dealStageText } from "../lib/dealStageText";
import { useAgentLive, useAgentOverview, type AgentLive, type AgentOverview } from "../hooks/useAgentOverview";
import {
  useAgentHandovers,
  useCallAgent,
  useRevertHandover,
  type AgentHandoverBatch,
  type HandoverRevertResult,
} from "../hooks/useAgents";
import { useTeam, type TeamMember } from "../hooks/useTeam";
import { useMobileUx } from "../hooks/useMobileUx";
import { useCan, useCanViewInvestigations } from "../lib/permissions";
import { ApiError } from "../lib/apiError";
import { INTERACTION_TYPE_LABELS } from "../lib/clientFormat";
import { ROLE_LABELS } from "../lib/roles";
import { rh2AvatarTone } from "../lib/rh2Avatar";
import { absenceLabel } from "../lib/absenceLabel";
import { formatMoney, PROPERTY_STATUS_CHIP, PROPERTY_STATUS_LABELS, relativeTime } from "../lib/format";
import { dushanbeDate, dushanbeDateTime, dushanbeDayKey, dushanbeTime, dushanbeTodayKey } from "../lib/date";
import { formatCallDuration } from "../components/CallDetails";
import { CallColleagueButton } from "../components/CallColleagueButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FreezeAgentModal } from "../components/FreezeAgentModal";
import { LeadPauseAgentModal } from "../components/LeadPauseAgentModal";
import { HandoverModal } from "../components/HandoverModal";

/**
 * КАРТОЧКА СОТРУДНИКА — один экран для директора/админа/менеджера, ПК и
 * телефон в одном файле (задание docs/archive/employee-card-brief-20-09.md).
 *
 * Раньше это были ДВА разных облика в разных местах: на ПК шторка
 * `components/AgentOverviewModal.tsx` (удалена), на телефоне — этот же файл.
 * Они разъехались содержимым (кадры 20.09: на ПК были «KPI», «Сделки» и
 * «клиент ждёт ответа», которых не было на телефоне, и наоборот) — тот же
 * класс поломки, что уже случался с `Oversight.tsx`/`MobileOversight.tsx`
 * (см. CLAUDE.md). Поэтому теперь ветвление ТОЛЬКО по устройству
 * (`useMobileUx`), порядок и состав блоков одинаковы, различается только
 * оформление: `TeamMemberDetailDesktop`/`TeamMemberDetailMobile` ниже читают
 * ОДНИ И ТЕ ЖЕ данные и текстовые подписи (общие функции выше в файле) —
 * расхождению в содержимом неоткуда взяться, расходиться может только вёрстка.
 *
 * Два хука с двумя разными полосами загрузки (2.1 задания): `useAgentOverview`
 * (как раньше — портфель, KPI, проблемы, объекты/клиенты/сделки) и новый
 * `useAgentLive` («сейчас», лиды, переписка, звонки за неделю). Второй может
 * не успеть или отказать — блоки, которые он кормит, рисуют собственное
 * «загружаем»/«не удалось загрузить» и не держат остальной экран.
 */

function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

// Те же значения, что MH_HOST в components/home/mh/MhScreen.tsx и
// components/mobile/mh/MhList.tsx — оболочка (AppLayout) даёт содержимому
// поля `px-5 pt-4` и запас снизу под нижнюю панель, а сам мобильный
// артефакт держит поля сам (16 px внутри `.body`, 12/16 px в шапке).
const MH_HOST: CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};

/** Сумма всех красных флагов карточки одним числом (владелец 16.09.2026:
 *  «по-крупному, чтобы не искать что где когда») — одна версия вместо двух
 *  разошедшихся (была в удалённом AgentOverviewModal.tsx и здесь). */
function totalProblems(data: AgentOverview | undefined): number {
  if (!data) return 0;
  const p = data.problems;
  return (
    data.violations.flaggedShowingCalls +
    p.overdueTasks.total +
    p.stalledClients.total +
    p.silentAfterShowing.total +
    p.refusedHighScore.total +
    p.endlessNegotiations.total +
    p.sellerPropertyMissing.total +
    (p.lossSeries ? 1 : 0)
  );
}

/** «с телефона»/«с компьютера» — сервер отдаёт `now.device` человекочитаемой
 *  строкой («Chrome · Windows», «Safari · iOS», см. apps/api/src/lib/device.ts),
 *  не литералом «MOBILE»/«DESKTOP»: различаем по ОС внутри строки. */
function deviceKindLabel(device: string | null): string | null {
  if (!device) return null;
  return /ios|android/i.test(device) ? "с телефона" : "с компьютера";
}

/** Строка под именем в шапке: роль · онлайн/был(а) в сети · устройство ·
 *  отсутствие. Общая для ПК и телефона — блок 1 задания. */
function headerSubtitle(roleLabel: string, live: AgentLive | undefined, member: TeamMember | undefined): string {
  const parts = [roleLabel];
  if (live) {
    parts.push(
      live.now.online
        ? "в сети"
        : live.now.lastSeenAt
          ? `был(а) в сети ${relativeTime(live.now.lastSeenAt)}`
          : "не в сети"
    );
    const device = deviceKindLabel(live.now.device);
    if (device) parts.push(device);
  }
  if (member?.frozen) parts.push(absenceLabel(member));
  else if (member && leadsPaused(member)) parts.push(`пауза лидов до ${dushanbeDateTime(member.leadsPausedUntil!)}`);
  // Личные выходные (11.10.2026) — одной строкой и на ПК, и на телефоне (подзаголовок общий).
  if (member?.weeklyDaysOff?.length) parts.push(daysOffSentenceRu(member.weeklyDaysOff));
  return parts.join(" · ");
}

/** Действующая пауза приёма лидов (своя или от руководителя), 24.09.2026. */
function leadsPaused(member: TeamMember): boolean {
  return !!member.leadsPausedUntil && new Date(member.leadsPausedUntil).getTime() > Date.now();
}

/** Кнопку паузы видит руководитель у работающего агента: замороженному лиды и так не идут. */
function canPauseLeads(member: TeamMember): boolean {
  return member.role === "AGENT" && member.isActive && !member.frozen;
}

function elapsedLabel(fromIso: string | null): string {
  if (!fromIso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(fromIso).getTime()) / 60000));
  return mins < 1 ? "меньше минуты" : `${mins} мин`;
}

/** Блок «Сейчас», строка звонка. Живой звонок — ИЗ ПАМЯТИ (`now.call`):
 *  `null` значит «не на звонке прямо сейчас через CRM», а не «звонков не
 *  было» — эту разницу нельзя стирать (см. задание, 2.4, «Честность обязательна»). */
function callHeadline(call: AgentLive["now"]["call"]): { text: string; clientShortId: number | null } | null {
  if (!call) return null;
  const name = call.clientName ?? "клиентом";
  const text = call.state === "talking" ? `Говорит с ${name} · ${elapsedLabel(call.answeredAt)}` : `Набирает ${name}`;
  return { text, clientShortId: call.clientShortId };
}

function whenLabel(at: string): string {
  return dushanbeDayKey(at) === dushanbeTodayKey() ? `сегодня в ${dushanbeTime(at)}` : dushanbeDateTime(at);
}

function nextTaskText(task: NonNullable<AgentLive["now"]["nextTask"]>): string {
  const title = task.title ?? INTERACTION_TYPE_LABELS[task.type] ?? "задача";
  return `Ближайшее: ${title} ${whenLabel(task.at)} — ${task.client.fullName}`;
}

function lastActionText(i: AgentOverview["activity"]["recentInteractions"][number]): string {
  return `Последнее действие: ${INTERACTION_TYPE_LABELS[i.type] ?? i.type} · ${i.client.fullName} · ${relativeTime(i.createdAt)}`;
}

/** «Ждёт ответа»/«ответил бот»/ничего — чип строки переписки, блок 5. */
function chatChip(lastFrom: "client" | "agent" | "bot"): { text: string; crit: boolean } | null {
  if (lastFrom === "client") return { text: "ждёт ответа", crit: true };
  if (lastFrom === "bot") return { text: "ответил бот", crit: false };
  return null;
}

function callAttemptText(c: { callAttempt: string; durationSec: number | null }): string {
  if (c.callAttempt === "TALKED") return `поговорили ${formatCallDuration(c.durationSec)}`;
  if (c.callAttempt === "NO_ANSWER") return "клиент не ответил";
  if (c.callAttempt === "AGENT_NO_PICKUP") return "сам не снял трубку";
  if (c.callAttempt === "CANCELLED") return "звонок отменён";
  return "";
}

function weekScoreTone(score: number): "ok" | "warn" | "crit" {
  if (score >= 70) return "ok";
  if (score >= 40) return "warn";
  return "crit";
}

/** `state`, который несут ссылки на карточку клиента: «назад» возвращает
 *  СЮДА, на карточку сотрудника, а не в общий список (блок 8-10 задания). */
function backState(id: string, fullName: string) {
  return { from: `/team/${id}`, fromLabel: fullName };
}

function overviewErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Нет доступа к карточке этого сотрудника";
    if (err.status === 404) return "Сотрудник не найден";
  }
  return "Не удалось загрузить карточку сотрудника";
}

export function TeamMemberDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const mobile = useMobileUx();
  const overview = useAgentOverview(id);
  const live = useAgentLive(id);
  const can = useCan();
  const seesInvestigations = useCanViewInvestigations();
  const canManageAgents = can("agents.manage");
  // /team уже загружен «Командой» перед переходом сюда — тот же react-query
  // кеш, повторного запроса по сети не будет. Freeze/Handover просят полный
  // TeamMember (frozen, absenceKind…), которого нет ни в /overview, ни в /live.
  const { data: team } = useTeam(true);
  const member = useMemo(() => team?.find((m) => m.id === id), [team, id]);
  const callAgent = useCallAgent(id ?? "");
  const [showFreeze, setShowFreeze] = useState(false);
  const [showHandover, setShowHandover] = useState(false);
  const [showLeadPause, setShowLeadPause] = useState(false);

  // «Вернуть дела»: запрашиваем прошлые раздачи только для того, кто вообще
  // может ими управлять — иначе это лишний запрос на каждое открытие карточки.
  const handovers = useAgentHandovers(id ?? "", canManageAgents && !!id);
  const pendingHandover = handovers.data?.find((h) => h.revertedAt === null) ?? null;
  const revertHandover = useRevertHandover();
  const [showRevertConfirm, setShowRevertConfirm] = useState(false);
  const [revertResult, setRevertResult] = useState<HandoverRevertResult | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  const data = !overview.data || seesInvestigations ? overview.data : {
    ...overview.data,
    violations: { flaggedShowingCalls: 0, lastFlags: [] },
    problems: {
      ...overview.data.problems,
      refusedHighScore: { ...overview.data.problems.refusedHighScore, total: 0, items: [] },
      sellerPropertyMissing: { total: 0, items: [] },
      lossSeries: null,
    },
  };
  const liveData = live.data;

  // Таймер разговора тикает в браузере от `answeredAt`, не ждёт новый ответ
  // сервера (задание, блок 2). Интервал не секундный: минуты меняются раз в
  // 60 секунд, дёргать рендер чаще незачем.
  const [, setTick] = useState(0);
  const talking = liveData?.now.call?.state === "talking";
  const answeredAt = liveData?.now.call?.answeredAt ?? null;
  useEffect(() => {
    if (!talking) return;
    const timer = setInterval(() => setTick((v) => v + 1), 15_000);
    return () => clearInterval(timer);
  }, [talking, answeredAt]);

  const problemsTotal = totalProblems(data);
  const callInfo = liveData ? callHeadline(liveData.now.call) : null;
  const lastInteraction = data?.activity.recentInteractions[0] ?? null;
  const nextTask = liveData?.now.nextTask ?? null;

  const statusNow = !data
    ? null
    : member?.frozen
      ? { text: absenceLabel(member), crit: true }
      : { text: "в норме", crit: false };

  const shared: SharedProps = {
    id: id ?? "",
    navigate,
    overview,
    live,
    data,
    liveData,
    canManageAgents,
    member,
    callAgent,
    showFreeze,
    setShowFreeze,
    showLeadPause,
    setShowLeadPause,
    showHandover,
    setShowHandover,
    pendingHandover,
    showRevertConfirm,
    setShowRevertConfirm,
    revertHandover,
    revertResult,
    setRevertResult,
    revertError,
    setRevertError,
    problemsTotal,
    callInfo,
    lastInteraction,
    nextTask,
    statusNow,
  };

  return mobile ? <TeamMemberDetailMobile {...shared} /> : <TeamMemberDetailDesktop {...shared} />;
}

interface SharedProps {
  id: string;
  navigate: ReturnType<typeof useNavigate>;
  overview: ReturnType<typeof useAgentOverview>;
  live: ReturnType<typeof useAgentLive>;
  data: AgentOverview | undefined;
  liveData: AgentLive | undefined;
  canManageAgents: boolean;
  member: TeamMember | undefined;
  callAgent: ReturnType<typeof useCallAgent>;
  showFreeze: boolean;
  setShowFreeze: (v: boolean) => void;
  showLeadPause: boolean;
  setShowLeadPause: (v: boolean) => void;
  showHandover: boolean;
  setShowHandover: (v: boolean) => void;
  pendingHandover: AgentHandoverBatch | null;
  showRevertConfirm: boolean;
  setShowRevertConfirm: (v: boolean) => void;
  revertHandover: ReturnType<typeof useRevertHandover>;
  revertResult: HandoverRevertResult | null;
  setRevertResult: (v: HandoverRevertResult | null) => void;
  revertError: string | null;
  setRevertError: (v: string | null) => void;
  problemsTotal: number;
  callInfo: { text: string; clientShortId: number | null } | null;
  lastInteraction: AgentOverview["activity"]["recentInteractions"][number] | null;
  nextTask: AgentLive["now"]["nextTask"] | null | undefined;
  statusNow: { text: string; crit: boolean } | null;
}

/* ------------------------------------------------------------------------ */
/* ПК                                                                        */
/* ------------------------------------------------------------------------ */

function TeamMemberDetailDesktop(props: SharedProps) {
  const {
    id, navigate, overview, live, data, liveData, canManageAgents, member, callAgent,
    showFreeze, setShowFreeze, showLeadPause, setShowLeadPause, showHandover, setShowHandover, problemsTotal, callInfo,
    pendingHandover, showRevertConfirm, setShowRevertConfirm, revertHandover, revertResult, setRevertResult,
    revertError, setRevertError,
    lastInteraction, nextTask, statusNow,
  } = props;

  return (
    <div className="rh2 screens">
      <div className="scr">
        {overview.isLoading && (
          <div className="card">
            <p className="state">Загружаем карточку…</p>
          </div>
        )}
        {overview.isError && (
          <div className="card">
            <p className="state err">
              <span className="dot crit" />
              {overviewErrorText(overview.error)}
            </p>
            <button className="lnk" type="button" onClick={() => overview.refetch()}>
              Повторить
            </button>
          </div>
        )}

        {data && (
          <>
            {/* 1. Шапка */}
            <div className="card">
              <div className="pg-h">
                <div className="cd-h" style={{ marginBottom: 0 }}>
                  <span className="av xl ring" style={rh2AvatarTone(data.agent.fullName)}>
                    {data.agent.avatarUrl ? <img src={data.agent.avatarUrl} alt="" /> : initials(data.agent.fullName)}
                  </span>
                  <div className="who">
                    <h1>{data.agent.fullName}</h1>
                    <p className="sub">
                      {headerSubtitle(ROLE_LABELS[data.agent.role], liveData, member)}
                      {!data.agent.isActive && " · деактивирован"}
                    </p>
                  </div>
                </div>
                <div className="acts">
                  {data.agent.sipExtension ? (
                    <CallColleagueButton agentId={data.agent.id} extension={data.agent.sipExtension} className="pill ghost" />
                  ) : (
                    <a className="pill ghost" href={`tel:${data.agent.phone}`}>
                      <Phone className="i" aria-hidden="true" /> Позвонить
                    </a>
                  )}
                  {data.agent.email && (
                    <a className="pill ghost" href={`mailto:${data.agent.email}`}>
                      <Mail className="i" aria-hidden="true" /> Письмо
                    </a>
                  )}
                  {canManageAgents && member && (
                    <>
                      {canPauseLeads(member) && (
                        <button className="pill ghost" type="button" onClick={() => setShowLeadPause(true)}>
                          {leadsPaused(member) ? "Вернуть в раздачу лидов" : "Пауза лидов"}
                        </button>
                      )}
                      <button className="pill ghost" type="button" onClick={() => setShowFreeze(true)}>
                        {member.frozen ? "Вернуть в строй" : "Отпуск / больничный"}
                      </button>
                      <button className="pill ghost" type="button" onClick={() => setShowHandover(true)}>
                        Передать дела
                      </button>
                      {pendingHandover && (
                        <button
                          className="pill ghost sm"
                          type="button"
                          onClick={() => {
                            setRevertError(null);
                            setShowRevertConfirm(true);
                          }}
                        >
                          Вернуть дела ({dushanbeDate(pendingHandover.createdAt, { day: "2-digit", month: "2-digit" })})
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {revertResult && (
                <p className="quiet ok" style={{ marginTop: 8 }}>
                  <span className="dot ok" />
                  <span className="txt">
                    Возвращено: клиентов {revertResult.clients}, задач {revertResult.tasks}, объектов{" "}
                    {revertResult.properties}
                    {revertResult.reactivated && " — учётная запись включена"}
                    {(revertResult.skippedClients > 0 || revertResult.skippedProperties > 0) &&
                      `. Не тронуто: клиентов ${revertResult.skippedClients}, объектов ${revertResult.skippedProperties} — их уже передали дальше.`}
                  </span>
                </p>
              )}
              {revertError && (
                <p className="quiet crit" style={{ marginTop: 8 }}>
                  <span className="dot crit" />
                  <span className="txt">{revertError}</span>
                </p>
              )}
              {callAgent.isError && (
                <p className="state err" style={{ marginTop: 8 }}>
                  <span className="dot crit" />
                  {callAgent.error instanceof Error ? callAgent.error.message : "Не удалось позвонить"}
                </p>
              )}
            </div>

            {/* 2. Сейчас */}
            <div className="sec">
              <div className="sec-h">
                <h2>Сейчас</h2>
              </div>
              <div className="card">
                {live.isError && (
                  <p className="state err">
                    <span className="dot crit" />
                    Не удалось загрузить, что сотрудник делает сейчас
                  </p>
                )}
                {live.isLoading && <p className="state">Загружаем…</p>}
                {liveData && (
                  <>
                    {!callInfo && !lastInteraction && !nextTask && <p className="state">Сегодня в CRM ничего не делал</p>}
                    {callInfo ? (
                      <p
                        className="state"
                        role={callInfo.clientShortId ? "button" : undefined}
                        tabIndex={callInfo.clientShortId ? 0 : undefined}
                        style={callInfo.clientShortId ? { cursor: "pointer", fontSize: 17, fontWeight: 600 } : { fontSize: 17, fontWeight: 600 }}
                        onClick={() => callInfo.clientShortId && navigate(`/clients/${callInfo.clientShortId}`)}
                      >
                        {callInfo.text}
                      </p>
                    ) : (
                      (lastInteraction || nextTask) && <p className="state">Не на звонке</p>
                    )}
                    {lastInteraction && (
                      <p
                        className="state"
                        role="button"
                        tabIndex={0}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          navigate(`/clients/${lastInteraction.client.shortId}`, {
                            state: backState(id, data.agent.fullName),
                          })
                        }
                      >
                        {lastActionText(lastInteraction)}
                      </p>
                    )}
                    {nextTask && (
                      <p
                        className="state"
                        role="button"
                        tabIndex={0}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          navigate(`/clients/${nextTask.client.shortId}`, { state: backState(id, data.agent.fullName) })
                        }
                      >
                        {nextTaskText(nextTask)}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* 3. Что не так */}
            <div className="sec" id="problems">
              <div className="sec-h">
                <h2>Что не так</h2>
                <span className="cnt">{problemsTotal}</span>
              </div>
              <div className="card">
                {problemsTotal === 0 && data.activity.waitingForReply.length === 0 ? (
                  <p className="state">Проблем не найдено — ни просрочек, ни красных флагов антифрода.</p>
                ) : (
                  <div className="list">
                    {data.activity.waitingForReply.length > 0 && (
                      <>
                        <p className="state err" style={{ margin: "0 0 4px" }}>
                          <span className="dot crit" />
                          {data.activity.waitingForReply.length}{" "}
                          {data.activity.waitingForReply.length === 1 ? "клиент ждёт ответа" : "клиента ждут ответа"}
                        </p>
                        {data.activity.waitingForReply.map((c) => (
                          <Link key={c.id} className="row" to={`/clients/${c.shortId}`} state={backState(id, data.agent.fullName)}>
                            <div className="t">
                              <b>{c.fullName}</b>
                              <span>написал {relativeTime(c.lastClientMessageAt)}</span>
                            </div>
                          </Link>
                        ))}
                      </>
                    )}
                    {data.problems.overdueTasks.total > 0 && (
                      <>
                        <p className="state" style={{ margin: "8px 0 0" }}>
                          <b>Просроченные задачи</b> · {data.problems.overdueTasks.total}
                        </p>
                        {data.problems.overdueTasks.items.map((t) => (
                          <Link key={t.id} className="row" to={`/clients/${t.client.shortId}`} state={backState(id, data.agent.fullName)}>
                            <div className="t">
                              <b>{t.client.fullName}</b>
                              <span>
                                {t.nextAction ?? "задача"} · просрочено {t.nextActionDate ? relativeTime(t.nextActionDate) : ""}
                              </span>
                            </div>
                          </Link>
                        ))}
                      </>
                    )}
                    {data.problems.stalledClients.total > 0 && (
                      <>
                        <p className="state" style={{ margin: "8px 0 0" }}>
                          <b>Горячие клиенты без контакта</b> · {data.problems.stalledClients.total}
                        </p>
                        {data.problems.stalledClients.items.map((c) => (
                          <Link key={c.id} className="row" to={`/clients/${c.shortId}`} state={backState(id, data.agent.fullName)}>
                            <div className="t">
                              <b>{c.fullName}</b>
                              <span>
                                скоринг {c.aiScore ?? "—"} · {c.lastContactAt ? `молчит с ${relativeTime(c.lastContactAt)}` : "контакта не было"}
                              </span>
                            </div>
                          </Link>
                        ))}
                      </>
                    )}
                    {data.problems.silentAfterShowing.total > 0 && (
                      <>
                        <p className="state" style={{ margin: "8px 0 0" }}>
                          <b>Тишина после показа</b> · {data.problems.silentAfterShowing.total}
                        </p>
                        {data.problems.silentAfterShowing.items.map((c) => (
                          <Link key={c.id} className="row" to={`/clients/${c.shortId}`} state={backState(id, data.agent.fullName)}>
                            <div className="t">
                              <b>{c.fullName}</b>
                              <span>{c.lastContactAt ? `молчит с ${relativeTime(c.lastContactAt)}` : "давно без контакта"}</span>
                            </div>
                          </Link>
                        ))}
                      </>
                    )}
                    {data.problems.refusedHighScore.total > 0 && (
                      <>
                        <p className="state" style={{ margin: "8px 0 0" }}>
                          <b>Отказ при хорошем скоринге</b> · {data.problems.refusedHighScore.total}
                        </p>
                        {data.problems.refusedHighScore.items.map((r) => (
                          <div className="row" key={r.id} style={{ alignItems: "flex-start" }}>
                            <div className="t">
                              <b>
                                {r.client ? (
                                  <Link to={`/clients/${r.client.shortId}`} state={backState(id, data.agent.fullName)}>
                                    {r.client.fullName}
                                  </Link>
                                ) : (
                                  "Карточка удалена"
                                )}
                              </b>
                              <span>
                                {r.client?.refusalReason ?? "причина не указана"} · {relativeTime(r.createdAt)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                    {data.problems.endlessNegotiations.total > 0 && (
                      <>
                        <p className="state" style={{ margin: "8px 0 0" }}>
                          <b>Вечные переговоры</b> · {data.problems.endlessNegotiations.total}
                        </p>
                        {data.problems.endlessNegotiations.items.map((n) => (
                          <Link key={n.id} className="row" to={`/clients/${n.client.shortId}`} state={backState(id, data.agent.fullName)}>
                            <div className="t">
                              <b>{n.client.fullName}</b>
                              <span>{n.rounds} кругов переговоров</span>
                            </div>
                          </Link>
                        ))}
                      </>
                    )}
                    {data.problems.sellerPropertyMissing.total > 0 && (
                      <>
                        <p className="state" style={{ margin: "8px 0 0" }}>
                          <b>Продавец без объекта</b> · {data.problems.sellerPropertyMissing.total}
                        </p>
                        {data.problems.sellerPropertyMissing.items.map((s) => (
                          <Link key={s.id} className="row" to={`/clients/${s.shortId}`} state={backState(id, data.agent.fullName)}>
                            <div className="t">
                              <b>{s.fullName}</b>
                              <span>{s.daysSince} дней без объекта</span>
                            </div>
                            <span className={s.level === "CRITICAL" ? "chip crit" : "chip warn"}>
                              {s.level === "CRITICAL" ? "критично" : "внимание"}
                            </span>
                          </Link>
                        ))}
                      </>
                    )}
                    {data.problems.lossSeries && (
                      <p className="state err" style={{ margin: "8px 0 0" }}>
                        <span className="dot crit" />
                        Серия: {data.problems.lossSeries.count} переводов в «Неактивные»/потерь за{" "}
                        {data.problems.lossSeries.windowDays} дней
                      </p>
                    )}
                    {data.violations.flaggedShowingCalls > 0 && (
                      <>
                        <p className="state" style={{ margin: "8px 0 0" }}>
                          <b>Красные флаги после показа</b> · {data.violations.flaggedShowingCalls}
                        </p>
                        {data.violations.lastFlags.map((f) => (
                          <div className="row" key={f.id} style={{ alignItems: "flex-start" }}>
                            <div className="t">
                              <b>
                                {f.client ? (
                                  <Link to={`/clients/${f.client.shortId}`} state={backState(id, data.agent.fullName)}>
                                    {f.client.fullName}
                                  </Link>
                                ) : (
                                  "Карточка удалена"
                                )}
                              </b>
                              <span>
                                {f.flags.map((fl) => fl.detail).join("; ")} · {relativeTime(f.createdAt)}
                              </span>
                            </div>
                            {f.escalatedAt && <span className="chip crit">руководству отправлено</span>}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
                <Link className="lnk" to="/oversight" style={{ marginTop: 8, display: "inline-block" }}>
                  Открыть полный разбор в «Контроле руководителя»
                </Link>
              </div>
            </div>

            {/* 4. Цифры за неделю */}
            <div className="sec">
              <div className="sec-h">
                <h2>Цифры за неделю</h2>
              </div>
              {live.isError ? (
                <div className="card">
                  <p className="state err">
                    <span className="dot crit" />
                    Не удалось загрузить цифры за неделю
                  </p>
                </div>
              ) : !liveData ? (
                <div className="card">
                  <p className="state">Загружаем…</p>
                </div>
              ) : (
                <div className="tiles">
                  <Link className="tile" to={`/clients?agentId=${id}`}>
                    <span className="hd">Лидов в работе</span>
                    <b>{liveData.leads.inWork}</b>
                    <small>{liveData.leads.limit === 0 ? "без предела" : `из ${liveData.leads.limit}`}</small>
                  </Link>
                  <Link className="tile" to={`/calls?agentId=${id}`}>
                    <span className="hd">Звонков за неделю</span>
                    <b>{liveData.calls.weekTotal}</b>
                    <small>поговорил {liveData.calls.weekTalked}</small>
                  </Link>
                  <Link className="tile" to={`/calls?agentId=${id}&slice=missed`}>
                    <span className="hd">Пропустил звонков</span>
                    <b style={liveData.calls.weekMissedIncoming > 0 ? { color: "var(--crit)" } : undefined}>{liveData.calls.weekMissedIncoming}</b>
                    <small className={liveData.calls.weekMissedIncoming > 0 ? "crit" : undefined}>за неделю</small>
                  </Link>
                  <a
                    className="tile"
                    href="#problems"
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById("problems")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    <span className="hd">Просрочено задач</span>
                    <b style={data.problems.overdueTasks.total > 0 ? { color: "var(--crit)" } : undefined}>{data.problems.overdueTasks.total}</b>
                    <small className={data.problems.overdueTasks.total > 0 ? "crit" : undefined}>нужно закрыть</small>
                  </a>
                </div>
              )}
            </div>

            {/* 5. Переписка */}
            <div className="sec">
              <div className="sec-h">
                <h2>Переписка</h2>
              </div>
              <div className="card">
                {live.isError ? (
                  <p className="state err">
                    <span className="dot crit" />
                    Не удалось загрузить переписку
                  </p>
                ) : !liveData ? (
                  <p className="state">Загружаем…</p>
                ) : liveData.chats.length === 0 ? (
                  <p className="state">Переписки с клиентами нет</p>
                ) : (
                  <div className="list">
                    {liveData.chats.map((c) => {
                      const chip = chatChip(c.lastFrom);
                      return (
                        <Link key={c.conversationId} className="row wrapt" to={`/messages?open=${c.conversationId}`}>
                          <div className="t">
                            <b>{c.client.fullName}</b>
                            <span>
                              {c.lastText || "…"} · {relativeTime(c.lastMessageAt)}
                            </span>
                          </div>
                          {chip && <span className={chip.crit ? "chip crit" : "chip"}>{chip.text}</span>}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* 6. Звонки */}
            <div className="sec">
              <div className="sec-h">
                <h2>Звонки</h2>
              </div>
              <div className="card">
                {live.isError ? (
                  <p className="state err">
                    <span className="dot crit" />
                    Не удалось загрузить звонки
                  </p>
                ) : !liveData ? (
                  <p className="state">Загружаем…</p>
                ) : liveData.calls.last.length === 0 ? (
                  <p className="state">Разговоров с записью пока не было</p>
                ) : (
                  <div className="list">
                    {liveData.calls.last.map((c) => (
                      <Link
                        key={c.id}
                        className="row wrapt"
                        to={`/clients/${c.client.shortId}?tab=calls`}
                        state={backState(id, data.agent.fullName)}
                      >
                        <div className="t">
                          <b>{c.client.fullName}</b>
                          <span>
                            {callAttemptText(c)} · {relativeTime(c.createdAt)}
                          </span>
                        </div>
                        {c.hasRecording && liveData.calls.canHear && <Headphones className="i" aria-label="Есть запись" />}
                        {c.score != null && <span className={`score ${weekScoreTone(c.score)}`}>{c.score}</span>}
                        {c.agreedNextStep === false && <span className="chip warn">без договорённости</span>}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 7. Лиды по этапам */}
            <div className="sec">
              <div className="sec-h">
                <h2>Лиды по этапам</h2>
              </div>
              <div className="card">
                {live.isError ? (
                  <p className="state err">
                    <span className="dot crit" />
                    Не удалось загрузить портфель по этапам
                  </p>
                ) : !liveData ? (
                  <p className="state">Загружаем…</p>
                ) : (
                  <>
                    {Object.keys(liveData.leads.byStatus).length === 0 ? (
                      <p className="state">Клиентов в работе нет</p>
                    ) : (
                      <div className="wrap">
                        {Object.entries(liveData.leads.byStatus).map(([status, n]) => (
                          <Link key={status} className="chip" to={`/clients?agentId=${id}&status=${status}`}>
                            {(CLIENT_STATUS_LABELS as Record<string, string>)[status] ?? status}: {n}
                          </Link>
                        ))}
                      </div>
                    )}
                    {liveData.leads.unaccepted > 0 && (
                      <p className="state err" style={{ marginTop: 8 }}>
                        <span className="dot crit" />
                        <Link className="lnk" to={`/clients?agentId=${id}`}>
                          Выдано, но не принято: {liveData.leads.unaccepted}
                        </Link>
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* 8. Объекты */}
            <div className="sec">
              <div className="sec-h">
                <h2>Объекты</h2>
                <span className="cnt">{data.properties.total}</span>
              </div>
              {data.properties.last.length === 0 ? (
                <div className="card">
                  <p className="state">Объектов пока нет</p>
                </div>
              ) : (
                <div className="card">
                  <div className="list">
                    {data.properties.last.map((p) => (
                      <Link key={p.id} className="row" to={`/properties/${p.shortId}`}>
                        <div className="t">
                          <b>{p.title}</b>
                          <span>{formatMoney(p.price, p.currency)}</span>
                        </div>
                        <span className={PROPERTY_STATUS_CHIP[p.status]}>{PROPERTY_STATUS_LABELS[p.status]}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 9. Клиенты */}
            <div className="sec">
              <div className="sec-h">
                <h2>Клиенты</h2>
                <span className="cnt">{data.clients.total}</span>
              </div>
              {data.clients.last.length === 0 ? (
                <div className="card">
                  <p className="state">Клиентов пока нет</p>
                </div>
              ) : (
                <div className="card">
                  <div className="list">
                    {data.clients.last.map((c) => (
                      <Link key={c.id} className="row" to={`/clients/${c.shortId}`} state={backState(id, data.agent.fullName)}>
                        <div className="t">
                          <b>{c.fullName}</b>
                          <span>
                            {formatClientCode(c.shortId, c.kind)} · {CLIENT_STATUS_LABELS[c.status as ClientStatus]}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 10. Сделки */}
            <div className="sec">
              <div className="sec-h">
                <h2>Сделки</h2>
                <span className="cnt">{data.deals.total}</span>
              </div>
              {data.deals.last.length === 0 ? (
                <div className="card">
                  <p className="state">Сделок пока нет</p>
                </div>
              ) : (
                <div className="card">
                  <div className="list">
                    {data.deals.last.map((d) => (
                      <Link key={d.id} className="row" to={`/properties/${d.property.shortId}`}>
                        <div className="t">
                          <b>{d.property.title}</b>
                          <span>
                            {d.client.fullName} · {dealStageText(d)}
                          </span>
                        </div>
                        {d.commissionAmount && <span className="meta">{formatMoney(d.commissionAmount, d.currency)}</span>}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 11. KPI за последние дни */}
            <div className="sec">
              <div className="sec-h">
                <h2>KPI за последние дни</h2>
              </div>
              <div className="card">
                {data.kpiHistory.length === 0 ? (
                  <p className="state">История KPI ещё не накопилась</p>
                ) : (
                  <div className="list">
                    {[...data.kpiHistory].reverse().map((k) => (
                      <div key={k.date} className="row">
                        <div className="t">
                          <b>{dushanbeDate(k.date)}</b>
                        </div>
                        <span className={k.score >= 70 ? "score ok" : k.score >= 40 ? "score warn" : "score crit"}>{k.score}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {showFreeze && member && <FreezeAgentModal agent={member} onClose={() => setShowFreeze(false)} />}
      {showLeadPause && member && <LeadPauseAgentModal agent={member} onClose={() => setShowLeadPause(false)} />}
      {showHandover && member && <HandoverModal agent={member} onClose={() => setShowHandover(false)} />}
      {showRevertConfirm && member && pendingHandover && (
        <ConfirmDialog
          title="Вернуть дела"
          description={`Вернуть ${member.fullName} всё, что было передано ${dushanbeDate(pendingHandover.createdAt, { day: "numeric", month: "long" })}: клиентов ${pendingHandover.clients}, задач ${pendingHandover.tasks}, объектов ${pendingHandover.properties}?${pendingHandover.deactivated ? " Учётная запись будет включена." : ""}`}
          confirmLabel={revertHandover.isPending ? "Возвращаем…" : "Вернуть"}
          danger={false}
          confirmDisabled={revertHandover.isPending}
          onCancel={() => setShowRevertConfirm(false)}
          onConfirm={() => {
            setRevertError(null);
            revertHandover.mutate(pendingHandover.id, {
              onSuccess: (data) => {
                setRevertResult(data);
                setShowRevertConfirm(false);
              },
              onError: (err) => setRevertError(err instanceof Error ? err.message : "Не удалось вернуть раздачу"),
            });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Телефон                                                                   */
/* ------------------------------------------------------------------------ */

function TeamMemberDetailMobile(props: SharedProps) {
  const {
    id, navigate, overview, live, data, liveData, canManageAgents, member, callAgent,
    showFreeze, setShowFreeze, showLeadPause, setShowLeadPause, showHandover, setShowHandover, problemsTotal, callInfo,
    pendingHandover, showRevertConfirm, setShowRevertConfirm, revertHandover, revertResult, setRevertResult,
    revertError, setRevertError,
    lastInteraction, nextTask, statusNow,
  } = props;
  // Шаг назад вместо жёсткого перехода в «Команду»: иначе возврат терял срез и
  // место в списке (разбор в hooks/useGoBack.ts).
  const goBack = useGoBack("/team");

  return (
    <div className="rh2" style={MH_HOST}>
      <div className="mh">
        <ShellOwnHeader />
        <div className="top">
          <button type="button" className="ico card" aria-label="Назад" onClick={goBack}>
            <ChevronLeft className="i" aria-hidden="true" />
          </button>
          <div className="grow" style={{ fontSize: 14, color: "var(--muted)" }}>
            Команда · {data?.agent.fullName ?? ""}
          </div>
        </div>
        <div className="body">
          {overview.isLoading && (
            <div className="card-s" style={{ padding: 16 }}>
              <div className="quiet">
                <div className="ln">Загружаем карточку…</div>
              </div>
            </div>
          )}
          {overview.isError && (
            <div className="card-s" style={{ padding: 16 }}>
              <div className="quiet">
                <div className="ln">
                  <i className="c" aria-hidden="true" />
                  <span>{overviewErrorText(overview.error)}</span>
                </div>
              </div>
              <button className="lnk" type="button" onClick={() => overview.refetch()}>
                Повторить
              </button>
            </div>
          )}

          {data && (
            <>
              {/* 1. Шапка */}
              <div className="chead">
                <span className="av" style={{ width: 96, height: 96, fontSize: 34, ...rh2AvatarTone(data.agent.fullName) }}>
                  {data.agent.avatarUrl ? <img src={data.agent.avatarUrl} alt="" /> : initials(data.agent.fullName)}
                </span>
                <h1 className="n">{data.agent.fullName}</h1>
                <div className="tags">
                  <span className="chip lav">{ROLE_LABELS[data.agent.role]}</span>
                  {!data.agent.isActive && <span className="chip crit">деактивирован</span>}
                  {liveData && <span className={liveData.now.online ? "chip lime" : "chip"}>{liveData.now.online ? "в сети" : liveData.now.lastSeenAt ? `был(а) ${relativeTime(liveData.now.lastSeenAt)}` : "не в сети"}</span>}
                  {liveData && deviceKindLabel(liveData.now.device) && <span className="chip">{deviceKindLabel(liveData.now.device)}</span>}
                  {statusNow?.crit && <span className="chip crit">{statusNow.text}</span>}
                </div>
              </div>

              <div className="qa" role="group" aria-label="Быстрые действия" style={{ gridTemplateColumns: data.agent.email ? "repeat(2,1fr)" : "1fr" }}>
                {data.agent.sipExtension ? (
                  <button type="button" className="main" disabled={callAgent.isPending} onClick={() => callAgent.mutate()}>
                    <Phone className="i" aria-hidden="true" />
                    {callAgent.isPending ? "Соединяем…" : "Позвонить"}
                  </button>
                ) : (
                  <button type="button" className="main" onClick={() => (window.location.href = `tel:${data.agent.phone}`)}>
                    <Phone className="i" aria-hidden="true" />
                    Позвонить
                  </button>
                )}
                {data.agent.email && (
                  <button type="button" onClick={() => (window.location.href = `mailto:${data.agent.email}`)}>
                    <Mail className="i" aria-hidden="true" />
                    Письмо
                  </button>
                )}
              </div>
              {callAgent.isError && (
                <div className="quiet" style={{ marginTop: 4 }}>
                  <div className="ln">
                    <i className="c" aria-hidden="true" />
                    <span>{callAgent.error instanceof Error ? callAgent.error.message : "Не удалось позвонить"}</span>
                  </div>
                </div>
              )}

              {canManageAgents && member && (
                <div className="qa" role="group" aria-label="Действия руководителя" style={{ gridTemplateColumns: "repeat(2,1fr)", marginTop: 8 }}>
                  {canPauseLeads(member) && (
                    <button type="button" onClick={() => setShowLeadPause(true)}>
                      {leadsPaused(member) ? "Вернуть в раздачу лидов" : "Пауза лидов"}
                    </button>
                  )}
                  <button type="button" onClick={() => setShowFreeze(true)}>
                    {member.frozen ? "Вернуть в строй" : "Отпуск / больничный"}
                  </button>
                  <button type="button" onClick={() => setShowHandover(true)}>
                    Передать дела
                  </button>
                  {pendingHandover && (
                    <button
                      type="button"
                      onClick={() => {
                        setRevertError(null);
                        setShowRevertConfirm(true);
                      }}
                    >
                      Вернуть дела ({dushanbeDate(pendingHandover.createdAt, { day: "2-digit", month: "2-digit" })})
                    </button>
                  )}
                </div>
              )}
              {revertResult && (
                <div className="quiet" style={{ marginTop: 8 }}>
                  <div className="ln">
                    <i aria-hidden="true" />
                    <span>
                      Возвращено: клиентов {revertResult.clients}, задач {revertResult.tasks}, объектов{" "}
                      {revertResult.properties}
                      {revertResult.reactivated && " — учётная запись включена"}
                      {(revertResult.skippedClients > 0 || revertResult.skippedProperties > 0) &&
                        `. Не тронуто: клиентов ${revertResult.skippedClients}, объектов ${revertResult.skippedProperties} — их уже передали дальше.`}
                    </span>
                  </div>
                </div>
              )}
              {revertError && (
                <div className="quiet" style={{ marginTop: 8 }}>
                  <div className="ln">
                    <i className="c" aria-hidden="true" />
                    <span>{revertError}</span>
                  </div>
                </div>
              )}

              {/* 2. Сейчас */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Сейчас</h2>
                </div>
                <div className="card-s" style={{ padding: 16 }}>
                  {live.isError && (
                    <div className="quiet">
                      <div className="ln">
                        <i className="c" aria-hidden="true" />
                        <span>Не удалось загрузить, что сотрудник делает сейчас</span>
                      </div>
                    </div>
                  )}
                  {live.isLoading && (
                    <div className="quiet">
                      <div className="ln">Загружаем…</div>
                    </div>
                  )}
                  {liveData && (
                    <div className="quiet">
                      {!callInfo && !lastInteraction && !nextTask && <div className="ln">Сегодня в CRM ничего не делал</div>}
                      {callInfo ? (
                        <div
                          className="ln"
                          role={callInfo.clientShortId ? "button" : undefined}
                          tabIndex={callInfo.clientShortId ? 0 : undefined}
                          onClick={() => callInfo.clientShortId && navigate(`/clients/${callInfo.clientShortId}`)}
                        >
                          <span style={{ fontWeight: 600 }}>{callInfo.text}</span>
                        </div>
                      ) : (
                        (lastInteraction || nextTask) && <div className="ln">Не на звонке</div>
                      )}
                      {lastInteraction && (
                        <div
                          className="ln"
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            navigate(`/clients/${lastInteraction.client.shortId}`, { state: backState(id, data.agent.fullName) })
                          }
                        >
                          {lastActionText(lastInteraction)}
                        </div>
                      )}
                      {nextTask && (
                        <div
                          className="ln"
                          role="button"
                          tabIndex={0}
                          onClick={() => navigate(`/clients/${nextTask.client.shortId}`, { state: backState(id, data.agent.fullName) })}
                        >
                          {nextTaskText(nextTask)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>

              {/* 3. Что не так */}
              <section className="sec" id="problems">
                <div className="sec-t">
                  <h2>Что не так</h2>
                  <span className="cnt">{problemsTotal}</span>
                </div>
                {problemsTotal === 0 && data.activity.waitingForReply.length === 0 ? (
                  <div className="card-s">
                    <div className="quiet">
                      <div className="ln">Проблем не найдено — ни просрочек, ни красных флагов</div>
                    </div>
                  </div>
                ) : (
                  <div className="card-s">
                    {data.activity.waitingForReply.length > 0 && (
                      <>
                        <div className="quiet" style={{ marginTop: 0 }}>
                          <div className="ln">
                            <i className="c" aria-hidden="true" />
                            <b>
                              {data.activity.waitingForReply.length}{" "}
                              {data.activity.waitingForReply.length === 1 ? "клиент ждёт ответа" : "клиента ждут ответа"}
                            </b>
                          </div>
                        </div>
                        {data.activity.waitingForReply.map((c) => (
                          <div key={c.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/clients/${c.shortId}`, { state: backState(id, data.agent.fullName) })}>
                            <span className="plate crit" aria-hidden="true" />
                            <span className="t">
                              <span className="n">{c.fullName}</span>
                              <span className="s">написал {relativeTime(c.lastClientMessageAt)}</span>
                            </span>
                            <ChevronRight className="i" aria-hidden="true" />
                          </div>
                        ))}
                      </>
                    )}
                    {data.problems.overdueTasks.total > 0 && (
                      <div className="quiet" style={{ marginTop: 0 }}>
                        <div className="ln">
                          <b>Просроченные задачи · {data.problems.overdueTasks.total}</b>
                        </div>
                      </div>
                    )}
                    {data.problems.overdueTasks.items.map((t) => (
                      <div key={t.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/clients/${t.client.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{t.client.fullName}</span>
                          <span className="s">
                            {t.nextAction ?? "задача"} · просрочено {t.nextActionDate ? relativeTime(t.nextActionDate) : ""}
                          </span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                    {data.problems.stalledClients.total > 0 && (
                      <div className="quiet">
                        <div className="ln">
                          <b>Горячие клиенты без контакта · {data.problems.stalledClients.total}</b>
                        </div>
                      </div>
                    )}
                    {data.problems.stalledClients.items.map((c) => (
                      <div key={c.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/clients/${c.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{c.fullName}</span>
                          <span className="s">
                            скоринг {c.aiScore ?? "—"} · {c.lastContactAt ? `молчит с ${relativeTime(c.lastContactAt)}` : "контакта не было"}
                          </span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                    {data.problems.silentAfterShowing.total > 0 && (
                      <div className="quiet">
                        <div className="ln">
                          <b>Тишина после показа · {data.problems.silentAfterShowing.total}</b>
                        </div>
                      </div>
                    )}
                    {data.problems.silentAfterShowing.items.map((c) => (
                      <div key={c.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/clients/${c.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{c.fullName}</span>
                          <span className="s">{c.lastContactAt ? `молчит с ${relativeTime(c.lastContactAt)}` : "давно без контакта"}</span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                    {data.problems.refusedHighScore.total > 0 && (
                      <div className="quiet">
                        <div className="ln">
                          <b>Отказ при хорошем скоринге · {data.problems.refusedHighScore.total}</b>
                        </div>
                      </div>
                    )}
                    {data.problems.refusedHighScore.items.map((r) => (
                      <div key={r.id} className="row" role="button" tabIndex={0} onClick={() => r.client && navigate(`/clients/${r.client.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{r.client ? r.client.fullName : "Карточка удалена"}</span>
                          <span className="s">
                            {r.client?.refusalReason ?? "причина не указана"} · {relativeTime(r.createdAt)}
                          </span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                    {data.problems.endlessNegotiations.total > 0 && (
                      <div className="quiet">
                        <div className="ln">
                          <b>Вечные переговоры · {data.problems.endlessNegotiations.total}</b>
                        </div>
                      </div>
                    )}
                    {data.problems.endlessNegotiations.items.map((n) => (
                      <div key={n.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/clients/${n.client.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{n.client.fullName}</span>
                          <span className="s">{n.rounds} кругов переговоров</span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                    {data.problems.sellerPropertyMissing.total > 0 && (
                      <div className="quiet">
                        <div className="ln">
                          <b>Продавец без объекта · {data.problems.sellerPropertyMissing.total}</b>
                        </div>
                      </div>
                    )}
                    {data.problems.sellerPropertyMissing.items.map((s) => (
                      <div key={s.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/clients/${s.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{s.fullName}</span>
                          <span className="s">{s.daysSince} дней без объекта, {s.level === "CRITICAL" ? "критично" : "внимание"}</span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                    {data.problems.lossSeries && (
                      <div className="quiet">
                        <div className="ln">
                          <i className="c" aria-hidden="true" />
                          <span>
                            Серия: {data.problems.lossSeries.count} переводов в «Неактивные»/потерь за {data.problems.lossSeries.windowDays} дней
                          </span>
                        </div>
                      </div>
                    )}
                    {data.violations.flaggedShowingCalls > 0 && (
                      <div className="quiet">
                        <div className="ln">
                          <b>Красные флаги после показа · {data.violations.flaggedShowingCalls}</b>
                        </div>
                      </div>
                    )}
                    {data.violations.lastFlags.map((f) => (
                      <div key={f.id} className="row" role="button" tabIndex={0} onClick={() => f.client && navigate(`/clients/${f.client.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{f.client ? f.client.fullName : "Карточка удалена"}</span>
                          <span className="s">
                            {f.flags.map((fl) => fl.detail).join("; ")} · {relativeTime(f.createdAt)}
                          </span>
                        </span>
                        {f.escalatedAt && <span className="plate crit" aria-hidden="true" />}
                      </div>
                    ))}
                  </div>
                )}
                <Link className="lnk" to="/oversight" style={{ display: "inline-block", marginTop: 8 }}>
                  Открыть полный разбор в «Контроле руководителя»
                </Link>
              </section>

              {/* 4. Цифры за неделю */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Цифры за неделю</h2>
                </div>
                {live.isError ? (
                  <div className="card-s" style={{ padding: 16 }}>
                    <div className="quiet">
                      <div className="ln">
                        <i className="c" aria-hidden="true" />
                        <span>Не удалось загрузить цифры за неделю</span>
                      </div>
                    </div>
                  </div>
                ) : !liveData ? (
                  <div className="card-s" style={{ padding: 16 }}>
                    <div className="quiet">
                      <div className="ln">Загружаем…</div>
                    </div>
                  </div>
                ) : (
                  <div className="tiles">
                    <Link className="tile" to={`/clients?agentId=${id}`}>
                      <div className="v">{liveData.leads.inWork}</div>
                      <div className="l">
                        лидов в работе
                        <br />
                        {liveData.leads.limit === 0 ? "без предела" : `из ${liveData.leads.limit}`}
                      </div>
                    </Link>
                    <Link className="tile" to={`/calls?agentId=${id}`}>
                      <div className="v">{liveData.calls.weekTotal}</div>
                      <div className="l">
                        звонков за неделю
                        <br />
                        поговорил {liveData.calls.weekTalked}
                      </div>
                    </Link>
                    <Link className="tile" to={`/calls?agentId=${id}&slice=missed`}>
                      <div className={liveData.calls.weekMissedIncoming > 0 ? "v crit" : "v"}>{liveData.calls.weekMissedIncoming}</div>
                      <div className={liveData.calls.weekMissedIncoming > 0 ? "l crit" : "l"}>пропустил за неделю</div>
                    </Link>
                    <a
                      className="tile"
                      href="#problems"
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById("problems")?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      <div className={data.problems.overdueTasks.total > 0 ? "v crit" : "v"}>{data.problems.overdueTasks.total}</div>
                      <div className={data.problems.overdueTasks.total > 0 ? "l crit" : "l"}>просрочено, нужно закрыть</div>
                    </a>
                  </div>
                )}
              </section>

              {/* 5. Переписка */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Переписка</h2>
                </div>
                {live.isError ? (
                  <div className="card-s" style={{ padding: 16 }}>
                    <div className="quiet">
                      <div className="ln">
                        <i className="c" aria-hidden="true" />
                        <span>Не удалось загрузить переписку</span>
                      </div>
                    </div>
                  </div>
                ) : !liveData ? (
                  <div className="card-s" style={{ padding: 16 }}>
                    <div className="quiet">
                      <div className="ln">Загружаем…</div>
                    </div>
                  </div>
                ) : liveData.chats.length === 0 ? (
                  <div className="card-s">
                    <div className="quiet">
                      <div className="ln">Переписки с клиентами нет</div>
                    </div>
                  </div>
                ) : (
                  <div className="card-s">
                    {liveData.chats.map((c) => {
                      const chip = chatChip(c.lastFrom);
                      return (
                        <div key={c.conversationId} className="row" role="button" tabIndex={0} onClick={() => navigate(`/messages?open=${c.conversationId}`)}>
                          <span className="t">
                            <span className="n" style={{ whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}>
                              {c.client.fullName}
                            </span>
                            <span className="s" style={{ whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}>
                              {c.lastText || "…"} · {relativeTime(c.lastMessageAt)}
                            </span>
                          </span>
                          {chip && <span className={chip.crit ? "chip crit" : "chip"}>{chip.text}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* 6. Звонки */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Звонки</h2>
                </div>
                {live.isError ? (
                  <div className="card-s" style={{ padding: 16 }}>
                    <div className="quiet">
                      <div className="ln">
                        <i className="c" aria-hidden="true" />
                        <span>Не удалось загрузить звонки</span>
                      </div>
                    </div>
                  </div>
                ) : !liveData ? (
                  <div className="card-s" style={{ padding: 16 }}>
                    <div className="quiet">
                      <div className="ln">Загружаем…</div>
                    </div>
                  </div>
                ) : liveData.calls.last.length === 0 ? (
                  <div className="card-s">
                    <div className="quiet">
                      <div className="ln">Разговоров с записью пока не было</div>
                    </div>
                  </div>
                ) : (
                  <div className="card-s">
                    {liveData.calls.last.map((c) => (
                      <div
                        key={c.id}
                        className="row"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/clients/${c.client.shortId}?tab=calls`, { state: backState(id, data.agent.fullName) })}
                      >
                        <span className="t">
                          <span className="n" style={{ whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}>
                            {c.client.fullName}
                          </span>
                          <span className="s" style={{ whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}>
                            {callAttemptText(c)} · {relativeTime(c.createdAt)}
                          </span>
                        </span>
                        {c.hasRecording && liveData.calls.canHear && <Headphones className="i" aria-label="Есть запись" />}
                        {c.score != null && <span className={`score ${weekScoreTone(c.score)}`}>{c.score}</span>}
                        {c.agreedNextStep === false && <span className="chip warn">без договорённости</span>}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 7. Лиды по этапам */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Лиды по этапам</h2>
                </div>
                <div className="card-s" style={{ padding: 16 }}>
                  {live.isError ? (
                    <div className="quiet">
                      <div className="ln">
                        <i className="c" aria-hidden="true" />
                        <span>Не удалось загрузить портфель по этапам</span>
                      </div>
                    </div>
                  ) : !liveData ? (
                    <div className="quiet">
                      <div className="ln">Загружаем…</div>
                    </div>
                  ) : (
                    <>
                      {Object.keys(liveData.leads.byStatus).length === 0 ? (
                        <div className="quiet">
                          <div className="ln">Клиентов в работе нет</div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {Object.entries(liveData.leads.byStatus).map(([status, n]) => (
                            <Link key={status} className="chip" to={`/clients?agentId=${id}&status=${status}`}>
                              {(CLIENT_STATUS_LABELS as Record<string, string>)[status] ?? status}: {n}
                            </Link>
                          ))}
                        </div>
                      )}
                      {liveData.leads.unaccepted > 0 && (
                        <div className="quiet" style={{ marginTop: 8 }}>
                          <div className="ln">
                            <i className="c" aria-hidden="true" />
                            <Link className="lnk" to={`/clients?agentId=${id}`}>
                              Выдано, но не принято: {liveData.leads.unaccepted}
                            </Link>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>

              {/* 8. Объекты */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Объекты</h2>
                  <span className="cnt">{data.properties.total}</span>
                </div>
                {data.properties.last.length === 0 ? (
                  <div className="card-s">
                    <div className="quiet">
                      <div className="ln">Объектов пока нет</div>
                    </div>
                  </div>
                ) : (
                  <div className="card-s">
                    {data.properties.last.map((p) => (
                      <div key={p.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/properties/${p.shortId}`)}>
                        <span className="t">
                          <span className="n">{p.title}</span>
                          <span className="s">
                            {formatMoney(p.price, p.currency)} · {PROPERTY_STATUS_LABELS[p.status]}
                          </span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 9. Клиенты */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Клиенты</h2>
                  <span className="cnt">{data.clients.total}</span>
                </div>
                {data.clients.last.length === 0 ? (
                  <div className="card-s">
                    <div className="quiet">
                      <div className="ln">Клиентов пока нет</div>
                    </div>
                  </div>
                ) : (
                  <div className="card-s">
                    {data.clients.last.map((c) => (
                      <div key={c.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/clients/${c.shortId}`, { state: backState(id, data.agent.fullName) })}>
                        <span className="t">
                          <span className="n">{c.fullName}</span>
                          <span className="s">
                            {formatClientCode(c.shortId, c.kind)} · {CLIENT_STATUS_LABELS[c.status as ClientStatus]}
                          </span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 10. Сделки */}
              <section className="sec">
                <div className="sec-t">
                  <h2>Сделки</h2>
                  <span className="cnt">{data.deals.total}</span>
                </div>
                {data.deals.last.length === 0 ? (
                  <div className="card-s">
                    <div className="quiet">
                      <div className="ln">Сделок пока нет</div>
                    </div>
                  </div>
                ) : (
                  <div className="card-s">
                    {data.deals.last.map((d) => (
                      <div key={d.id} className="row" role="button" tabIndex={0} onClick={() => navigate(`/properties/${d.property.shortId}`)}>
                        <span className="t">
                          <span className="n">{d.property.title}</span>
                          <span className="s">
                            {d.client.fullName} · {dealStageText(d)}
                          </span>
                        </span>
                        {d.commissionAmount && <span className="s">{formatMoney(d.commissionAmount, d.currency)}</span>}
                        <ChevronRight className="i" aria-hidden="true" />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* 11. KPI за последние дни */}
              <section className="sec">
                <div className="sec-t">
                  <h2>KPI за последние дни</h2>
                </div>
                {data.kpiHistory.length === 0 ? (
                  <div className="card-s">
                    <div className="quiet">
                      <div className="ln">История KPI ещё не накопилась</div>
                    </div>
                  </div>
                ) : (
                  <div className="card-s">
                    {[...data.kpiHistory].reverse().map((k) => (
                      <div key={k.date} className="row">
                        <span className="t">
                          <span className="n">{dushanbeDate(k.date)}</span>
                        </span>
                        <span className={k.score >= 70 ? "score ok" : k.score >= 40 ? "score warn" : "score crit"}>{k.score}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
      {showFreeze && member && <FreezeAgentModal agent={member} onClose={() => setShowFreeze(false)} />}
      {showLeadPause && member && <LeadPauseAgentModal agent={member} onClose={() => setShowLeadPause(false)} />}
      {showHandover && member && <HandoverModal agent={member} onClose={() => setShowHandover(false)} />}
      {showRevertConfirm && member && pendingHandover && (
        <ConfirmDialog
          title="Вернуть дела"
          description={`Вернуть ${member.fullName} всё, что было передано ${dushanbeDate(pendingHandover.createdAt, { day: "numeric", month: "long" })}: клиентов ${pendingHandover.clients}, задач ${pendingHandover.tasks}, объектов ${pendingHandover.properties}?${pendingHandover.deactivated ? " Учётная запись будет включена." : ""}`}
          confirmLabel={revertHandover.isPending ? "Возвращаем…" : "Вернуть"}
          danger={false}
          confirmDisabled={revertHandover.isPending}
          onCancel={() => setShowRevertConfirm(false)}
          onConfirm={() => {
            setRevertError(null);
            revertHandover.mutate(pendingHandover.id, {
              onSuccess: (data) => {
                setRevertResult(data);
                setShowRevertConfirm(false);
              },
              onError: (err) => setRevertError(err instanceof Error ? err.message : "Не удалось вернуть раздачу"),
            });
          }}
        />
      )}
    </div>
  );
}
