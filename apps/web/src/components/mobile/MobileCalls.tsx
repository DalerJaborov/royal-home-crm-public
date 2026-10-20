import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search, SlidersHorizontal } from "lucide-react";
import { MIN_ANALYZED_TRANSCRIPT_CHARS } from "@royal-home/shared";
import { MhLane, MhListScreen, type MhLaneChip } from "./mh/MhList";
import { MhNoData, MhQuiet } from "../home/mh/MhScreen";
import { useSyncFiltersToUrl } from "../../hooks/useUrlFilters";
import { useAccumulatedPages } from "../../hooks/useAccumulatedPages";
import { Pagination } from "../Pagination";
import { InboxTabs } from "../SectionTabs";
import { useCleanShell } from "../../hooks/useCleanShell";
import { CleanCallsSummary } from "../clean/CleanCallsSummary";
import {
  CALL_ATTEMPT_LABELS,
  useCallFeed,
  useCallInsights,
  useCalls,
  useCallsSummary,
  useIncomingCalls,
  useTelephonyDashboard,
  type CallFeedRow,
  type CallRow,
  type IncomingCallRow,
} from "../../hooks/useCalls";
import { useAgents } from "../../hooks/useAgents";
import { useSettings } from "../../hooks/useSettings";
import { CallClientButton } from "../CallClientButton";
import { CallDetails, TranscriptionStatus, formatCallDuration, scoreTone } from "../CallDetails";
import { DialPadModal } from "../DialPad";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { BlockCallerButton } from "../IncomingCallTools";
import { IconIncoming, IconKeypad, IconMissed, IconOutgoing } from "../proto/ProtoIcons";
import { dushanbeDayKey, dushanbeDayLabel, dushanbeTime } from "../../lib/date";
import { exactDateTime } from "../../lib/format";
import { mergeCallFeed } from "../../lib/callFeedMerge";
import { LiveVoiceSessionsMh, useCanSeeLiveVoiceSessions } from "../LiveVoiceSessions";
import { LiveVoiceListenMh } from "../LiveVoiceListen";

/**
 * Мобильные «Звонки»: `MobileCallsSupervisor` (руководство) и `MobileCallsAgent`
 * (агент, лента своих вызовов).
 *
 * ОБЛИК — МАКЕТ ВЛАДЕЛЬЦА `.rh2 .mh` (docs/pult/theme-2026/artifact-c99db05f-
 * mobile-nav-14-09.html, экраны `mycalls` и `companyCalls`): шапка `.top`
 * (MhListScreen), лента срезов `.lane`, карточка-список `.list` + `.row`
 * (плитка направления `.plate`, имя `.n`, суть `.s`, синяя кнопка `.btn.pill.sm`),
 * тихие строки `.quiet`. До 17.09.2026 оба экрана рисовали ПК-эталон
 * `.rh2 .screens > .scr` (`.pg-h`, `.call-row`, `.seg`, `.tiles` StatTile,
 * `.pager`, чёрные `.pill`) — «всё как будто с компьютера берёт, а не из
 * макета» (владелец 15.09.2026 после прохода по приложению с iPhone).
 *
 * Экраны остаются отдельными компонентами, а не отзывчивой копией десктопного, по
 * правилу репозитория и потому, что у агента здесь ДРУГОЙ источник данных: лента
 * `GET /calls/feed` с курсором, поиском и «Показать ещё» вместо страниц журнала.
 * Эту разницу нельзя свести к брейкпойнту.
 */

/* ---------- Общие кусочки журнала ---------- */

/** Журнал группируется по суткам Душанбе с подзаголовками `.sec-t`. */
function groupByDay<T>(items: T[], at: (x: T) => string): { key: string; label: string; rows: T[] }[] {
  const groups: { key: string; label: string; rows: T[] }[] = [];
  for (const item of items) {
    const key = dushanbeDayKey(at(item));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(item);
    else groups.push({ key, label: dushanbeDayLabel(at(item)), rows: [item] });
  }
  return groups;
}

/** Причина, по которой у разговора нет разбора. Порог общий с сервером. */
function missingAnalysisReason(transcript: string | null | undefined): string {
  if (!transcript) return "разговор не расшифрован";
  if (transcript.length < MIN_ANALYZED_TRANSCRIPT_CHARS) return "слишком короткий разговор, разбор не делается";
  return "разбор ещё готовится";
}

/**
 * Направление звонка плиткой макета (`.plate` + стрелка), тона те же, что у
 * быстрых кнопок главной: исходящий — «aqua», принятый входящий — «lav»,
 * пропущенный — «pink».
 *
 * Цвет не единственный носитель смысла: подпись направления стоит словом в
 * строке, а плитка подписана для скринридера.
 */
type CallDir = "out" | "in" | "missed";

const DIR_TONE: Record<CallDir, "aqua" | "lav" | "pink"> = { out: "aqua", in: "lav", missed: "pink" };

function DirPlate({ dir, label }: { dir: CallDir; label: string }) {
  const Icon = dir === "missed" ? IconMissed : dir === "in" ? IconIncoming : IconOutgoing;
  return (
    <span className={`plate ${DIR_TONE[dir]}`} aria-label={label}>
      <Icon className="i" />
    </span>
  );
}

/**
 * Строка разговора: плитка направления, имя со ссылкой в карточку, одна строка
 * сути (время, длительность, автор, итог разбора), справа синяя кнопка
 * «Позвонить». Нажатие по строке раскрывает запись и разбор — та же разметка,
 * что у ленты агента ниже (`FeedRow`), а не пультовая `.call-row`.
 */
function MhJournalRow({ call, showAgent }: { call: CallRow; showAgent: boolean }) {
  const [open, setOpen] = useState(false);
  const analysis = call.analysis;
  const detailsId = `mcall-${call.id}`;
  // Недозвон через CRM (18.09.2026) — станция разметила callAttempt, а
  // разговора не было: ни записи, ни расшифровки не будет никогда. Показываем
  // как пропущенный, а не как разговор с «0:00» и вечным «разбор готовится».
  const noAnswer = !!call.callAttempt && call.callAttempt !== "TALKED";
  const attemptLabel = noAnswer ? (CALL_ATTEMPT_LABELS[call.callAttempt!] ?? "Не дозвонились") : null;
  const expandable = !noAnswer && (call.hasRecording || !!call.transcript || !!analysis);
  const name = call.client?.fullName ?? "Клиент удалён";
  const parts = noAnswer
    ? [`${attemptLabel} · ${dushanbeTime(call.createdAt)}`, showAgent && call.agent ? call.agent.fullName : null].filter(
        Boolean
      ) as string[]
    : [
        `Исходящий · ${dushanbeTime(call.createdAt)}`,
        formatCallDuration(call.durationSec),
        showAgent && call.agent ? call.agent.fullName : null,
        analysis
          ? analysis.summary
          : call.transcriptionStage
            ? "расшифровываем"
            : missingAnalysisReason(call.transcript),
      ].filter(Boolean) as string[];

  return (
    <>
      <div className="row">
        <DirPlate dir={noAnswer ? "missed" : "out"} label={noAnswer ? attemptLabel! : "Исходящий"} />
        <button
          type="button"
          className="t"
          style={{ textAlign: "left" }}
          onClick={expandable ? () => setOpen((v) => !v) : undefined}
          aria-expanded={expandable ? open : undefined}
          aria-controls={expandable ? detailsId : undefined}
          disabled={!expandable}
        >
          <span className="n">
            <span className="nm">
              {call.client ? (
                <Link className="lk" to={`/clients/${call.client.shortId}`} onClick={(e) => e.stopPropagation()}>
                  {name}
                </Link>
              ) : (
                name
              )}
            </span>
            {analysis && <span className={`chip xs ${scoreTone(analysis.score)}`}>балл {analysis.score}</span>}
            {analysis && !analysis.agreedNextStep && <span className="chip crit xs">без договорённости</span>}
          </span>
          <span className={noAnswer ? "s crit" : "s"}>
            {parts.map((p, i) => (
              <span key={i} className="tx">
                {i > 0 ? `· ${p}` : p}
              </span>
            ))}
          </span>
        </button>
        {/* Телефона в строке журнала нет намеренно (сервер его не отдаёт) —
            кнопка звонит через карточку клиента, тем же путём CRM→станция. Она
            же служит «Перезвонить» у недозвона — разбирать нечего, а действие
            то же самое. */}
        {call.client && (
          <CallClientButton
            clientId={call.client.id}
            phone=""
            variant="full"
            label="Позвонить"
            title="Позвонить через CRM"
            className="btn pill sm"
          />
        )}
      </div>
      {open && (
        <div className="card-s" id={detailsId} style={{ margin: "0 14px 12px" }}>
          {!analysis && call.transcriptionStage && (
            <TranscriptionStatus stage={call.transcriptionStage} progress={call.transcriptionProgress} />
          )}
          <CallDetails
            interactionId={call.id}
            createdAt={call.createdAt}
            hasRecording={call.hasRecording}
            // Плеер прячется отдельно от текста — см. CallDetails.tsx
            // (04.09.2026, calls.hearRecording).
            canHear={call.canHear}
            transcript={call.transcript}
            transcriptRu={call.transcriptRu}
            analysis={analysis}
            notes={call.notes}
            recordingDurationSec={call.durationSec}
            agentName={call.agent?.fullName ?? null}
          />
        </div>
      )}
    </>
  );
}

/** Строка входящего: то же тело, но без автора и разбора — у входящего своей
 *  записи в CRM нет. Действия («Перезвонить», «больше не звонить») остаются те же. */
function MhIncomingRow({ call }: { call: IncomingCallRow }) {
  const needsQualifying = call.answered && !!call.client && !call.qualifiedAt;
  const name = call.client?.fullName ?? call.phone;
  const parts = [
    call.answered
      ? `Входящий · ${dushanbeTime(call.startedAt)} · ${formatCallDuration(call.talkSeconds)}`
      : `Пропущенный · ${dushanbeTime(call.startedAt)} · до оператора не дозвонился`,
    call.answered ? (call.answeredByName ?? (call.answeredBy ? `оператор ${call.answeredBy}` : null)) : null,
    call.client ? null : "в базе нет",
    call.qualifiedBy ? `разобрал ${call.qualifiedBy.fullName}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="row">
      <DirPlate
        dir={call.answered ? "in" : "missed"}
        label={call.answered ? "Входящий" : "Пропущенный входящий"}
      />
      <span className="b">
        <span className="n">
          <span className="nm">
            {call.client ? (
              <Link className="lk" to={`/clients/${call.client.shortId}`}>
                {name}
              </Link>
            ) : (
              name
            )}
          </span>
          {call.irrelevant && <span className="chip lav xs">не по делу</span>}
          {needsQualifying && <span className="chip warn xs">без разбора</span>}
          {!call.answered &&
            (call.callbackAgent ? (
              <span className="chip warn xs">перезвонит {call.callbackAgent.fullName}</span>
            ) : (
              <span className="chip crit xs">никто не перезвонил</span>
            ))}
          {/* Бейдж «без перезвона» (Пачка 18, 12.09.2026) — см. Calls.tsx. */}
          {call.missingCallback && <span className="chip crit xs">без перезвона {call.missedCallbackHours}ч+</span>}
        </span>
        <span className={call.answered ? "s" : "s crit"}>
          {parts.map((p, i) => (
            <span key={i} className="tx">
              {i > 0 ? `· ${p}` : p}
            </span>
          ))}
        </span>
      </span>
      {/* «Перезвонить» — только по пропущенному (правило владельца). */}
      {!call.answered && (
        <CallClientButton
          clientId={call.client?.id}
          phone={call.phone}
          variant="full"
          label="Перезвонить"
          title="Перезвонить через CRM"
          className="btn pill sm"
        />
      )}
      <BlockCallerButton callId={call.id} known={!!call.client} />
    </div>
  );
}

/** Разговоры по дням: подзаголовок `.sec-t` и карточка-список макета. */
function MhJournalGroups({ items, showAgent }: { items: CallRow[]; showAgent: boolean }) {
  const groups = useMemo(() => groupByDay(items, (c) => c.createdAt), [items]);
  return (
    <>
      {groups.map((g) => (
        <div className="sec" key={g.key}>
          <div className="sec-t">
            <h2>{g.label}</h2>
            <span className="cnt">{g.rows.length}</span>
          </div>
          <div className="list">
            {g.rows.map((call) => (
              <MhJournalRow key={call.id} call={call} showAgent={showAgent} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Входящие по дням — те же группы, строка своя. */
function MhIncomingGroups({ items }: { items: IncomingCallRow[] }) {
  const groups = useMemo(() => groupByDay(items, (c) => c.startedAt), [items]);
  return (
    <>
      {groups.map((g) => (
        <div className="sec" key={g.key}>
          <div className="sec-t">
            <h2>{g.label}</h2>
            <span className="cnt">{g.rows.length}</span>
          </div>
          <div className="list">
            {g.rows.map((call) => (
              <MhIncomingRow key={call.id} call={call} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ------------------------- Руководство ------------------------- */

type SupervisorTab = "all" | "problems" | "incoming" | "missed" | "unqualified";

const INCOMING_PERIODS = [
  { days: 7, label: "Неделя" },
  { days: 30, label: "Месяц" },
  { days: 90, label: "Квартал" },
] as const;

const tabFromUrl = (value: string | null): SupervisorTab =>
  value === "problems" || value === "incoming" || value === "missed" || value === "unqualified" ? value : "all";

/**
 * «ЗВОНКИ» РУКОВОДИТЕЛЯ НА ТЕЛЕФОНЕ — переодето 17.09.2026 в облик макета
 * владельца (`.rh2 .mh`, artifact-c99db05f-mobile-nav-14-09.html, экраны
 * `mycalls`/`companyCalls`: `.sec` + `.sec-t` + карточка-список со строками
 * «плитка направления · имя · время/итог» и кнопкой звонка).
 *
 * ЧТО БЫЛО НЕ ТАК. Экран рисовал ПК-эталон `.rh2 .screens > .scr` целиком:
 * шапка `.pg-h` с длинным подзаголовком, плитки `StatTile` (`.hd`/`b`/`small`),
 * сегменты `.seg` в `.hscroll`, ряд `<select>` прямо в теле, журнал строками
 * `.call-row` во всю ширину и чёрные кнопки `.pill`. Именно про это владелец
 * 15.09 сказал: «всё как будто с компьютера берёт, а не из макета».
 *
 * ФАЙЛ-ИСТОЧНИК ИДИОМЫ — `components/mobile/MobilePropertiesList.tsx`: шапка
 * `MhListScreen` с круглыми кнопками `.ico.card`, лента срезов `MhLane`,
 * фильтры шторкой `Rh2Sheet` (`.fgrid`/`.fld`), список `.list` + `.row`,
 * тихие строки `MhQuiet`. Ни одного своего класса не заведено.
 *
 * ДАННЫЕ, ХУКИ И ПРАВА НЕ ТРОНУТЫ: тот же состав и порядок запросов
 * (`useCalls`, `useCallsSummary`, `useCallInsights`, `useAgents`,
 * `useTelephonyDashboard`, `useIncomingCalls`, `useSettings`), тот же срез из
 * адреса (`?slice=`), те же фильтры (сотрудник, период, оператор, «без
 * перезвона»); журнал растёт лентой «Показать ещё», как на ПК.
 *
 * Плавающей кнопки набора здесь нет и не было (она у агента, `MobileCallsAgent`,
 * и её чинит другой агент) — наборщик остаётся круглой кнопкой в шапке.
 */
export function MobileCallsSupervisor() {
  const clean = useCleanShell();
  const [searchParams, setSearchParams] = useSearchParams();
  // Срез читается из адреса (`?slice=missed`) — те же плитки «Телефонии» и
  // главной директора ведут сюда с телефона тоже (задание 15.09.2026).
  const [tab, setTab] = useState<SupervisorTab>(() => tabFromUrl(searchParams.get("slice")));
  // ?agentId= — как на ПК (pages/Calls.tsx): плитки карточки сотрудника ведут
  // сюда сразу отфильтрованными на агента, и с телефона тоже (аудит 02.10.2026:
  // мобильный экран адрес не читал и показывал звонки всех).
  const [agentId, setAgentId] = useState<string>(() => searchParams.get("agentId") ?? "");
  const [page, setPage] = useState(1);
  const [incomingPage, setIncomingPage] = useState(1);
  const [days, setDays] = useState<number>(30);
  const [operator, setOperator] = useState("");
  const [dialOpen, setDialOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // «Без перезвона» (Пачка 18, 12.09.2026) — тот же фильтр, что на десктопе
  // (pages/Calls.tsx): сужает журнал входящих до пропущенных без исходящего
  // контакта дольше порога.
  const [noCallbackOnly, setNoCallbackOnly] = useState(false);

  const callsTab = tab === "all" || tab === "problems";
  // Список живого голоса сервер отдаёт при двух правах сразу (аудит №6) — тот же
  // вопрос, что на ПК, одной функцией из components/LiveVoiceSessions.tsx.
  const canSeeLiveVoice = useCanSeeLiveVoiceSessions();
  // isError раньше не читался: при отказе журнал был просто пустым местом под
  // фильтрами — ни объяснения, ни кнопки повторить, а руководитель делал вывод,
  // что за период никто не звонил.
  const { data, isLoading, isError, refetch } = useCalls(
    { agentId: agentId || undefined, problems: tab === "problems", page },
    { enabled: callsTab }
  );
  const { data: summary, isError: summaryFailed, isLoading: summaryLoading, refetch: retrySummary } = useCallsSummary(30);
  const { data: insights } = useCallInsights();
  const { data: agents } = useAgents();
  // Плитки «Сегодня» — по эталону, живые счётчики станции, а не месячная сводка.
  const { data: dashboard, isError: dashboardFailed, isLoading: dashboardLoading, refetch: retryDashboard } = useTelephonyDashboard();
  // Входящие опрашиваются всегда: их счётчики стоят на плитках и на срезах, а не
  // только внутри своей вкладки.
  const {
    data: incoming,
    isLoading: incomingLoading,
    isError: incomingError,
    refetch: refetchIncoming,
  } = useIncomingCalls({
    missed: tab === "missed",
    unqualified: tab === "unqualified",
    noCallback: noCallbackOnly,
    operator: operator || undefined,
    days,
    page: incomingPage,
  });
  /**
   * Кнопки «Разобрать» на мобильном журнале больше нет (владелец 18.08.2026):
   * роль оператора входящих отменена, тип обращения и карточку CRM заводит сама
   * из расшифровки разговора. Журнал, фильтры и «больше не звонить» — на месте.
   */
  const { data: settings } = useSettings();

  // «Показать ещё» лентой, как на ПК (решение владельца 15.09.2026): раньше
  // здесь были свои «Назад/Вперёд», и один и тот же журнал листался на ПК
  // лентой, а на телефоне страницами. Наборы сброса — те же, что у ПК; свежая
  // первая страница подписана вторым вызовом (аудит №38, useAccumulatedPages).
  const { data: callsHead } = useCalls(
    { agentId: agentId || undefined, problems: tab === "problems", page: 1 },
    { enabled: callsTab && page > 1 }
  );
  const { data: incomingHead } = useIncomingCalls(
    {
      missed: tab === "missed",
      unqualified: tab === "unqualified",
      noCallback: noCallbackOnly,
      operator: operator || undefined,
      days,
      page: 1,
    },
    { enabled: incomingPage > 1 }
  );
  const callsFeed = useAccumulatedPages(data?.items, page, `${agentId}:${tab === "problems"}`, callsHead?.items);
  const incomingFeed = useAccumulatedPages(
    incoming?.items,
    incomingPage,
    `${tab}:${noCallbackOnly}:${operator}:${days}`,
    incomingHead?.items
  );
  const forwardPhone = settings?.incomingForwardPhone?.trim() || null;
  const withExtension = (agents ?? []).filter((a) => a.sipExtension);
  const missedNobody = incoming?.items.filter((c) => !c.answered && !c.callbackAgent).length ?? 0;

  const pickTab = (t: SupervisorTab) => {
    setTab(t);
    setPage(1);
    setIncomingPage(1);
  };

  // Плитки «Сегодня» ведут в журнал ниже: переключают срез и прокручивают к нему.
  const goToTab = (t: SupervisorTab) => {
    pickTab(t);
    document.getElementById("call-log-m")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useSyncFiltersToUrl(searchParams, setSearchParams, {
    slice: tab === "all" ? undefined : tab,
    agentId: agentId || undefined,
  });

  // Сколько фильтров сужает выдачу прямо сейчас — точкой на круглой кнопке
  // шторки, тем же приёмом, что у «Объектов».
  const activeFilters =
    (callsTab ? (agentId ? 1 : 0) : 0) + (!callsTab && operator ? 1 : 0) + (!callsTab && noCallbackOnly ? 1 : 0);

  const sliceChips: MhLaneChip[] = [
    { key: "all", label: "Все", count: callsTab ? (data?.total ?? null) : null, active: tab === "all", onSelect: () => pickTab("all") },
    { key: "problems", label: "Требуют внимания", active: tab === "problems", onSelect: () => pickTab("problems") },
    {
      key: "incoming",
      label: "Входящие",
      count: incoming?.periodTotal ?? null,
      active: tab === "incoming",
      onSelect: () => pickTab("incoming"),
    },
    {
      key: "missed",
      label: "Пропущенные",
      count: incoming?.missed ?? null,
      active: tab === "missed",
      onSelect: () => pickTab("missed"),
    },
    {
      key: "unqualified",
      label: "Без разбора",
      count: incoming?.unqualified ?? null,
      active: tab === "unqualified",
      onSelect: () => pickTab("unqualified"),
    },
  ];

  return (
    <MhListScreen
      title="Звонки"
      count={callsTab ? (data?.total ?? null) : (incoming?.periodTotal ?? null)}
      actions={
        <>
          <button
            type="button"
            className="ico card"
            aria-label="Фильтры звонков"
            onClick={() => setFiltersOpen(true)}
            style={{ position: "relative" }}
          >
            <SlidersHorizontal className="i" aria-hidden />
            {activeFilters > 0 && <span className="dot" style={{ background: "var(--accent)" }} aria-hidden />}
          </button>
          <button type="button" className="ico card" aria-label="Набрать номер" onClick={() => setDialOpen(true)}>
            <IconKeypad className="i" />
          </button>
        </>
      }
    >
      {/* Полоса «Обращения» — тот же набор, что на компьютере (pages/Calls.tsx) и на
          остальных трёх экранах группы (docs/archive/menu-wave2-brief-15-09.md). */}
      <InboxTabs />

      {/* Идущие сейчас разговоры робота: слушать вживую (блока нет, пока на линии пусто). */}
      <LiveVoiceListenMh />

      {missedNobody > 0 && (
        <div className="sec" style={{ marginTop: 12 }}>
          <div className="list">
            <div className="quiet">
              <div className="ln">
                <i className="c" aria-hidden />
                <span>
                  {missedNobody === 1
                    ? "Один пропущенный звонок остался без ответа: никто не перезвонил."
                    : `${missedNobody} пропущенных звонков остались без ответа: никто не перезвонил.`}{" "}
                  <button type="button" className="lnk" onClick={() => pickTab("missed")}>
                    Посмотреть
                  </button>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {clean ? <CleanCallsSummary today={dashboard?.today} averageScore={summary?.averageScore}
        agreedNextStep={summary?.steps?.agreedNextStep} unreturnedOnPage={missedNobody}
        activeSlice={tab} onSlice={(slice) => goToTab(slice === "outgoing" ? "all" : slice)}
        failed={summaryFailed || dashboardFailed} loading={summaryLoading || dashboardLoading}
        retry={() => Promise.allSettled([retrySummary(), retryDashboard()])} /> : <div className="sec">
        <div className="sec-t">
          <h2>Сегодня</h2>
          <span className="cnt">данные станции, обновляются сами</span>
        </div>
        {/* `.mh .tile` — мобильная плитка макета (`.v` число сверху, `.l` подпись
            снизу), а не эталонная `.tile` из StatTile (`.hd`/`b`/`small`): в
            области `.rh2 .mh` у неё другая разметка. Плитка ведёт в срез журнала
            ниже — требование владельца 15.09.2026 «плитки должны вести куда-то». */}
        <div className="tiles">
          <button type="button" className="tile" onClick={() => goToTab("incoming")} title="Журнал входящих звонков">
            <div className="v">{dashboard ? dashboard.today.incoming : "…"}</div>
            <div className="l">входящих · с начала суток по Душанбе</div>
          </button>
          <button type="button" className="tile" onClick={() => goToTab("all")} title="Все разговоры журналом">
            <div className="v">{dashboard ? dashboard.today.outgoing : "…"}</div>
            <div className="l">исходящих · агенты звонили сами</div>
          </button>
          <button type="button" className="tile" onClick={() => goToTab("missed")} title="Пропущенные звонки">
            <div className={dashboard && dashboard.today.missed > 0 ? "v crit" : "v"}>
              {dashboard ? dashboard.today.missed : "…"}
            </div>
            <div className={missedNobody > 0 ? "l crit" : "l"}>
              пропущено · {missedNobody > 0 ? "по части никто не перезвонил" : "срез «Пропущенные» ниже"}
            </div>
          </button>
          <button
            type="button"
            className="tile"
            onClick={() => goToTab("problems")}
            title="Разговоры, требующие внимания"
          >
            {/* ТОН СРЕДНЕГО БАЛЛА — как на ПК (pages/Calls.tsx: точка `ok` от 70,
                иначе `warn`). На телефоне плитка была всегда нейтральной, и
                низкий балл ничем не отличался от хорошего — а это единственная
                из четырёх плиток, которая говорит о качестве работы. Порог тот
                же, чтобы два экрана не спорили между собой. */}
            <div className={summary?.averageScore == null ? "v" : summary.averageScore >= 70 ? "v" : "v warn"}>
              {summary?.averageScore ?? "…"}
            </div>
            <div className="l">
              средний балл ·{" "}
              {summary?.steps
                ? `за месяц, договорённость в ${summary.steps.agreedNextStep} из 100`
                : "разобранных пока нет"}
            </div>
          </button>
        </div>
      </div>

      }
      {/* Ночной разбор: не «сколько», а «что с этим делать». Длинный текст живёт
          тихими строками `.quiet` (они переносятся), а не строкой списка `.s`,
          которая обрезается многоточием в одну строку. */}
      {insights && (insights.weaknesses.length > 0 || insights.actions.length > 0) && (
        <div className="sec">
          <div className="sec-t">
            <h2>Разбор разговоров</h2>
            <span className="cnt">
              за {insights.days} дней, {insights.calls} звонков
            </span>
          </div>
          <div className="list">
            <div className="quiet">
              {insights.weaknesses.length > 0 && (
                <div className="ln">
                  <i className="c" aria-hidden />
                  <span>
                    <b>Где теряем клиентов.</b> {insights.weaknesses.join(" · ")}
                  </span>
                </div>
              )}
              {insights.actions.length > 0 && (
                <div className="ln">
                  <i className="w" aria-hidden />
                  <span>
                    <b>Что сделать.</b> {insights.actions.join(" · ")}
                  </span>
                </div>
              )}
              {insights.strengths.length > 0 && (
                <div className="ln">
                  <i aria-hidden />
                  <span>
                    <b>Что получается.</b> {insights.strengths.join(" · ")}
                  </span>
                </div>
              )}
              {insights.demand.length > 0 && (
                <div className="ln">
                  <i aria-hidden />
                  <span>
                    <b>Что спрашивает рынок.</b> {insights.demand.join(" · ")}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div id="call-log-m">
        <MhLane label="Срезы звонков" chips={sliceChips} />
      </div>

      {/* Куда уходят пропущенные — видно там, где на них смотрят. */}
      {!callsTab && forwardPhone && (
        <div className="sec" style={{ marginTop: 12 }}>
          <MhQuiet>
            Когда оператор недоступен, станция уводит звонок на <b>{forwardPhone}</b>: часть пропущенных могла быть
            принята там.
          </MhQuiet>
        </div>
      )}

      {/* Загрузка, отказ и пустота — строкой внутри карточки-списка, как на
          остальных списках телефона, а не блоком `.empty` с большой иконкой. */}
      {(callsTab ? isLoading && callsFeed.length === 0 : incomingLoading && incomingFeed.length === 0) && (
        <div className="sec" style={{ marginTop: 12 }}>
          <div className="list">
            <div className="state">Загружаем разговоры</div>
          </div>
        </div>
      )}

      {(callsTab ? isError : incomingError) && (
        <div className="sec" style={{ marginTop: 12 }}>
          <div className="list">
            <div className="state err">
              {callsTab
                ? "Журнал разговоров не загрузился. Это сбой связи, а не тишина в эфире."
                : "Входящие не загрузились. Не считайте, что пропущенных нет."}
              <button type="button" className="lnk" onClick={() => (callsTab ? refetch() : refetchIncoming())}>
                Повторить
              </button>
            </div>
          </div>
        </div>
      )}

      {callsTab && data && callsFeed.length === 0 && (
        <div className="sec" style={{ marginTop: 12 }}>
          <div className="list">
            <div className="state">
              {tab === "problems"
                ? "Проблемных разговоров нет: все заканчивались договорённостью о следующем шаге."
                : "Здесь появятся разговоры через CRM: запись, расшифровка и разбор."}
            </div>
          </div>
        </div>
      )}

      {!callsTab && incoming && incomingFeed.length === 0 && (
        <div className="sec" style={{ marginTop: 12 }}>
          <div className="list">
            <div className="state">
              {tab === "unqualified"
                ? "Все разговоры разобраны: у каждого указан тип обращения."
                : tab === "missed"
                  ? "Пропущенных звонков за период нет."
                  : "Здесь появятся звонки, которые клиенты сделали сами на номер агентства."}
            </div>
          </div>
        </div>
      )}

      {callsTab && callsFeed.length > 0 && <MhJournalGroups items={callsFeed} showAgent />}
      {!callsTab && incomingFeed.length > 0 && <MhIncomingGroups items={incomingFeed} />}

      {callsTab
        ? data && (
            <Pagination
              variant="loadMore"
              page={data.page}
              total={data.total}
              pageSize={data.pageSize}
              onPageChange={setPage}
            />
          )
        : incoming && (
            <Pagination
              variant="loadMore"
              page={incoming.page}
              total={incoming.total}
              pageSize={incoming.pageSize}
              onPageChange={setIncomingPage}
            />
          )}

      {/* Тот же список, что на ПК под журналом (23.09.2026: до телефона не
          доехал). Экран руководителя — значит, видят те же, кому он на ПК. */}
      {canSeeLiveVoice && <LiveVoiceSessionsMh />}

      <div className="sec">
        <MhQuiet tone="ok">
          {callsTab
            ? "Звонки через CRM записываются сами, история хранится в карточке клиента."
            : "Входящие идут прямо агентам, пропущенным CRM сама назначает, кто перезвонит."}
        </MhQuiet>
      </div>

      {/* ================= Шторка фильтров =================
          Ряд `<select>` прямо в теле экрана — приём пульта; на телефоне
          фильтры живут в шторке, как на «Объектах». Сами фильтры и их значения
          те же, что были. */}
      <Rh2Sheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Фильтры"
        ariaLabel="Фильтры звонков"
        footer={
          <>
            <button
              className="pill ghost"
              type="button"
              onClick={() => {
                setAgentId("");
                setOperator("");
                setNoCallbackOnly(false);
                setDays(30);
                setPage(1);
                setIncomingPage(1);
              }}
            >
              Сбросить
            </button>
            <button className="pill" type="button" onClick={() => setFiltersOpen(false)}>
              Показать
            </button>
          </>
        }
      >
        <div className="fgrid" style={{ gridTemplateColumns: "1fr" }}>
          {callsTab && (agents?.length ?? 0) > 0 && (
            <label className="fld">
              <span className="lab">Сотрудник</span>
              <select
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Все сотрудники</option>
                {agents?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!callsTab && (
            <>
              <label className="fld">
                <span className="lab">Период</span>
                <select
                  value={days}
                  onChange={(e) => {
                    setDays(Number(e.target.value));
                    setIncomingPage(1);
                  }}
                >
                  {INCOMING_PERIODS.map((p) => (
                    <option key={p.days} value={p.days}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {withExtension.length > 0 && (
                <label className="fld">
                  <span className="lab">Оператор</span>
                  <select
                    value={operator}
                    onChange={(e) => {
                      setOperator(e.target.value);
                      setIncomingPage(1);
                    }}
                  >
                    <option value="">Все операторы</option>
                    {withExtension.map((agent) => (
                      <option key={agent.id} value={agent.sipExtension!}>
                        {agent.fullName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="fld">
                <span className="lab">Только проблемные</span>
                <div className="wrap">
                  <label className="chk">
                    <input
                      type="checkbox"
                      checked={noCallbackOnly}
                      onChange={(e) => {
                        setNoCallbackOnly(e.target.checked);
                        setIncomingPage(1);
                      }}
                    />
                    Без перезвона
                  </label>
                </div>
              </div>
            </>
          )}

          {callsTab && (agents?.length ?? 0) === 0 && (
            <p className="lab">Фильтры входящих открываются на срезах «Входящие», «Пропущенные», «Без разбора».</p>
          )}
        </div>
      </Rh2Sheet>

      {dialOpen && <DialPadModal onClose={() => setDialOpen(false)} />}
    </MhListScreen>
  );
}

/* --------------------------- Агент: лента своих вызовов --------------------------- */

/** Подписи направления в ленте агента. Тон и стрелку рисует общий `DirPlate`
 *  выше — тот же, что в журнале руководителя: две копии соответствия
 *  «направление → цвет» неминуемо разъехались бы. */
const FEED_KIND: Record<CallFeedRow["kind"], { label: string; dir: CallDir }> = {
  OUT: { label: "Исходящий", dir: "out" },
  IN: { label: "Входящий", dir: "in" },
  MISSED: { label: "Пропущенный", dir: "missed" },
};

/**
 * «МОИ ЗВОНКИ» — облик второго артефакта владельца (`.rh2 .mh`, MhListScreen из
 * mh/MhList.tsx), не разметка ПК-эталона `.rh2 .scr` (`.pg-h`, `.call-row` во всю
 * ширину, чёрная кнопка «Позвонить»). Отдельных «Звонков» в макете c99db05f нет —
 * экран одет по общему договору списков (шапка `.top`, `.card-s` + `.list` + `.row`,
 * компактная `.btn.pill.sm` вместо кнопки во всю ширину), тем же приёмом, что уже
 * стоит на `MobileChatsList.tsx` и главной агента.
 *
 * Плавающая круглая кнопка набора (`.fab`) — из старого эталона и её позицию чинит
 * другой агент в theme-2026-proto.css, поэтому она осталась как есть.
 */
export function MobileCallsAgent() {
  const [q, setQ] = useState("");
  const [dialOpen, setDialOpen] = useState(false);
  /**
   * Курсор ленты: null — первая страница. Накопленные строки держим сами, потому
   * что «Показать ещё» дописывает к уже показанному, а не заменяет его.
   */
  const [before, setBefore] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<CallFeedRow[]>([]);
  // Голова (первая страница) ВСЕГДА под наблюдением, а «Показать ещё» читает
  // страницу глубже отдельным запросом. Раньше единственный запрос переезжал на
  // страницу `before`, голова оставалась без наблюдателя, и новый звонок или
  // готовая расшифровка после инвалидации не появлялись до повторного открытия
  // экрана (WEB-PAGES03).
  const head = useCallFeed(null);
  const more = useCallFeed(before, before !== null);
  const active = before !== null ? more : head;
  const { data, isLoading, isError, refetch } = active;
  // Полоса «Обращения» — тот же набор, что и у руководителя выше и на остальных
  // трёх экранах группы (docs/archive/menu-wave2-brief-15-09.md).

  /**
   * СЛИЯНИЕ ПО id С ЗАМЕНОЙ И СОРТИРОВКОЙ (аудит №4, 27.08).
   *
   * Раньше страница только ДОПИСЫВАЛАСЬ в хвост и существующие строки не
   * обновлялись никогда. Отсюда две беды: (1) разговор, показанный «без
   * расшифровки», так и висел без неё, пока агент не уйдёт с экрана целиком —
   * конвейер давно закончил, а строка заморожена; (2) свежий звонок, сделанный
   * при открытом экране, приходил поллингом первой страницы и падал НИЖЕ
   * вчерашних — агент его не видел и решал, что звонок не записался.
   *
   * Теперь пришедшие строки заменяют одноимённые, а лента всегда отсортирована
   * по времени: новое сверху.
   */
  const headItems = head.data?.items;
  const moreItems = more.data?.items;
  useEffect(() => {
    if (!headItems && !moreItems) return;
    // Голова последней: её перечитанные строки новее копий из страницы глубже.
    setLoaded((prev) => mergeCallFeed(prev, moreItems, headItems));
  }, [headItems, moreItems]);

  // Поиск — по имени клиента и номеру в уже загруженном: отдельного поиска по
  // ленте у сервера нет, а строка нужна, чтобы не листать пальцем.
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return loaded;
    return loaded.filter(
      (c) =>
        (c.client?.fullName ?? "").toLowerCase().includes(needle) || (c.phone ?? "").toLowerCase().includes(needle)
    );
  }, [loaded, q]);

  return (
    <MhListScreen
      title="Мои звонки"
      count={items.length || null}
      /* Наборщик — круглой кнопкой в шапке, как на экране руководителя выше.
         До 21.09.2026 он висел плавающей кнопкой над списком (`.fab.dialfab`) и
         закрывал собой последнюю строку: владелец «убрать плашку которая там
         висит… или поставить в самый низ экрана». Низ экрана занят нижним меню,
         поэтому единственное свободное и предсказуемое место — шапка, и заодно
         оба экрана звонков стали одинаковыми. */
      actions={
        <button type="button" className="ico card" aria-label="Набрать номер" onClick={() => setDialOpen(true)}>
          <IconKeypad className="i" />
        </button>
      }
    >
      {/* Лента вкладок разделов — перенос пунктов из меню (вторая сессия,
          15.09.2026). При слиянии с переодеванием экрана встала первой
          строкой тела, как на «Клиентах» и «Объектах». */}
      <InboxTabs />

      <div className="sec" style={{ marginTop: 6 }}>
        <div className="srch">
          <div className="field">
            <Search className="i" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Имя клиента или номер"
              aria-label="Поиск по своим звонкам"
            />
          </div>
        </div>
      </div>

      <div className="sec">
        {/* СЕГМЕНТОВ БОЛЬШЕ НЕТ (владелец 20.08.2026: «сегменты звонков не надо
            добавлять, можно один общий список, где видно пропущенные, исходящие и
            так далее»). Тип звонка виден стрелкой-плиткой и подписью в самой строке. */}
        {isLoading && loaded.length === 0 && <MhNoData>Загружаем вызовы…</MhNoData>}

        {/* Отказ ленты раньше приводил к прямой лжи: агенту, который сегодня
            звонил, экран уверенно писал «позвоните клиенту — звонок появится
            здесь», то есть что его звонков не существует. */}
        {isError && loaded.length === 0 && (
          <MhNoData tone="crit">
            Лента звонков не загрузилась. Ваши разговоры на месте, оборвалась связь.{" "}
            <button type="button" className="btn ghost sm" onClick={() => refetch()}>
              Повторить
            </button>
          </MhNoData>
        )}

        {!isLoading && q.trim() && items.length === 0 && (
          <MhNoData>Никого не нашли. Проверьте написание или наберите номер вручную.</MhNoData>
        )}

        {!isLoading && !isError && !q.trim() && items.length === 0 && (
          <MhNoData tone="ok">Позвоните клиенту из карточки или примите входящий, и звонок появится здесь.</MhNoData>
        )}

        {items.length > 0 && (
          <div className="card-s">
            <div className="list">
              {items.map((call) => (
                <FeedRow key={call.id} call={call} />
              ))}
            </div>
          </div>
        )}

        {/* «Показать ещё» вместо страниц: лента склеена из двух источников, и номер
            страницы в ней ничему не соответствует (см. GET /calls/feed). Курсор —
            момент последней показанной строки. */}
        {data?.nextBefore && !q.trim() && (
          <button type="button" className="row morerow" onClick={() => setBefore(data.nextBefore)}>
            <span className="t">
              <span className="n">Показать ещё</span>
            </span>
          </button>
        )}
      </div>

      <div className="sec">
        <MhQuiet tone="ok">Звонки через CRM записываются сами, история хранится в карточке клиента.</MhQuiet>
      </div>

      {dialOpen && <DialPadModal onClose={() => setDialOpen(false)} />}
    </MhListScreen>
  );
}

/**
 * Строка общей ленты: исходящий, входящий или пропущенный.
 *
 * Тип виден дважды и намеренно — плиткой-стрелкой (направление, тон по FEED_KIND) и
 * словом в подписи. Цвет не может быть единственным носителем смысла: при
 * дальтонизме красная стрелка пропущенного неотличима от серой исходящего, а это
 * разные вещи.
 *
 * Время — точной датой и часом (владелец 20.08.2026, «дата полная»).
 *
 * Разбор раскрывается только у исходящего: у входящего своей записи в CRM нет —
 * станция связывает её с хронологией клиента, и вести туда честнее, чем открывать
 * пустоту. У звонка без карточки строка не ведёт никуда.
 */
function FeedRow({ call }: { call: CallFeedRow }) {
  const [open, setOpen] = useState(false);
  const kind = FEED_KIND[call.kind];
  // Недозвон через CRM — тот же признак, что в журнале руководства выше: kind
  // остаётся "OUT" (это исходящий, автор — агент), но разговора не было.
  const outNoAnswer = call.kind === "OUT" && !!call.callAttempt && call.callAttempt !== "TALKED";
  const attemptLabel = outNoAnswer ? (CALL_ATTEMPT_LABELS[call.callAttempt!] ?? "Не дозвонились") : null;
  const missedLook = kind.dir === "missed" || outNoAnswer;
  const expandable = call.kind === "OUT" && !outNoAnswer && (call.hasRecording || !!call.transcript || !!call.analysis);
  const name = call.client?.fullName ?? call.phone ?? "Номера нет";
  const analysis = call.analysis ?? null;
  const detailsId = `mfeed-${call.id}`;

  return (
    <>
      <div className="row callrow">
        <DirPlate dir={outNoAnswer ? "missed" : kind.dir} label={attemptLabel ?? kind.label} />
        <button
          type="button"
          className="t"
          style={{ textAlign: "left" }}
          onClick={expandable ? () => setOpen((v) => !v) : undefined}
          aria-expanded={expandable ? open : undefined}
          aria-controls={expandable ? detailsId : undefined}
          disabled={!expandable}
        >
          <span className="n">
            {call.client ? (
              <Link className="lk" to={`/clients/${call.client.shortId}`} onClick={(e) => e.stopPropagation()}>
                {name}
              </Link>
            ) : (
              name
            )}
          </span>
          <span className={missedLook ? "s crit" : "s"}>
            {attemptLabel ?? kind.label} · {exactDateTime(call.at)}
            {!outNoAnswer && call.durationSec ? ` · ${formatCallDuration(call.durationSec)}` : ""}
            {call.agentName ? ` · ${call.agentName}` : ""}
            {!call.client && call.kind !== "OUT" ? " · в базе нет" : ""}
            {analysis ? ` · балл ${analysis.score}` : ""}
          </span>
        </button>
        {/* Перезвонить можно и по клиенту, и по голому номеру: у входящего с
            неизвестным номером карточки ещё нет, а перезвонить надо именно ему. */}
        {/* Зелёный кружок с трубкой, без подписи (владелец 21.09.2026: «кнопку
            позвонить убрать надпись и сделать просто иконку зелёную с телефоном
            как было ранее»). Подпись «Позвонить» занимала треть строки и наезжала
            на длительность разговора — «2:07» обрезалось кнопкой почти в каждой
            строке. Класс `callbtn` — theme-2026-mobile-shell.css. */}
        <CallClientButton
          clientId={call.client?.id}
          phone={call.phone ?? ""}
          variant="icon"
          title="Позвонить через CRM"
          className="callbtn"
        />
      </div>
      {open && (
        <div className="card-s" id={detailsId} style={{ margin: "0 14px 12px" }}>
          <CallDetails
            interactionId={call.id}
            createdAt={call.at}
            hasRecording={call.hasRecording}
            canHear={call.canHear}
            transcript={call.transcript ?? null}
            transcriptRu={call.transcriptRu ?? null}
            analysis={analysis}
            // Единая лента (CallFeedRow) notes/outcome не отдаёт вовсе — только имя и
            // длительность, они уже собраны сервером под разными именами полей.
            recordingDurationSec={call.durationSec}
            agentName={call.agentName}
          />
        </div>
      )}
    </>
  );
}
