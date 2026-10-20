import { useState } from "react";
import { useCleanShell } from "../hooks/useCleanShell";
import { CleanCallsSummary, CallsInsightsDisclosure } from "../components/clean/CleanCallsSummary";
import { CButton } from "../components/clean/ui";
import { Link, useSearchParams } from "react-router-dom";
import { useSyncFiltersToUrl } from "../hooks/useUrlFilters";
import {
  CALL_ATTEMPT_LABELS,
  useCallInsights,
  useCalls,
  useCallsSummary,
  useIncomingCalls,
  useTelephonyDashboard,
  type CallRow,
  type IncomingCallRow,
} from "../hooks/useCalls";
import { MIN_ANALYZED_TRANSCRIPT_CHARS } from "@royal-home/shared";
import { useAgents } from "../hooks/useAgents";
import { useSettings } from "../hooks/useSettings";
import { LiveVoiceSessionsDesk, useCanSeeLiveVoiceSessions } from "../components/LiveVoiceSessions";
import { LiveVoiceListenDesk } from "../components/LiveVoiceListen";
import { useCan } from "../lib/permissions";
import { useMarkSectionSeen } from "../hooks/useCounters";
import { CallClientButton } from "../components/CallClientButton";
import { CallDetails, TranscriptionStatus, formatCallDuration, scoreTone } from "../components/CallDetails";
import { DialPadModal } from "../components/DialPad";
import { relativeTime } from "../lib/format";
// «Больше не звонить» вынесено в components/IncomingCallTools.tsx (мобильный
// редизайн 17.08.2026): его делят этот десктопный журнал и мобильный экран.
import { BlockCallerButton } from "../components/IncomingCallTools";
import { useNarrowScreen } from "../hooks/useNarrowScreen";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { MobileCallsAgent, MobileCallsSupervisor } from "../components/mobile/MobileCalls";
import { Pagination } from "../components/Pagination";
import { StatTile } from "../components/ui/StatTile";
import {
  IconIncoming,
  IconKeypad,
  IconMissed,
  IconOutgoing,
  IconPhone,
  IconScore,
} from "../components/proto/ProtoIcons";
import { ScreenTabs } from "../components/ScreenTabs";
import { InboxTabs } from "../components/SectionTabs";

/**
 * «Звонки» — как агентство разговаривает с клиентами.
 *
 * До этого раздела о работе агента можно было судить по счётчикам: сколько звонков,
 * сколько показов. Что происходило внутри разговора, не знал никто, кроме него самого.
 *
 * ОБЛИК — ЭТАЛОН «ROYAL HOME 2026» (перенос 09.09.2026). Разметка, имена классов и
 * порядок блоков дословно из `docs/pult/theme-2026/screens/calls.html` (ветка
 * `docs/pult-theme-07-09`): шапка `.pg-h`, срочное тихой строкой `.quiet`, плитки
 * `.tiles`, срезы `.seg` в `.hscroll`, журнал строками `.call-row`, страницы `.pager`.
 *
 * ОДИН ЖУРНАЛ ВМЕСТО ДВУХ. В макете срезы «Все / Входящие / Пропущенные / Мои /
 * Требуют внимания» — переключатели одного списка. Раньше на десктопе жили ДВЕ
 * независимые карточки со своими фильтрами и своей пагинацией (разговоры и журнал
 * входящих); ни одна функция при слиянии не потеряна — фильтры входящих (период,
 * оператор), номер переадресации, пометки, «больше не звонить» и «перезвонить»
 * просто переехали в тот срез, где на них смотрят. Мобильный экран так устроен с
 * 17.08.2026, теперь оба экрана отвечают на вопрос одинаково.
 */

/** Срезы журнала — те же, что у мобильного экрана (`MobileCallsSupervisor`). */
type Slice = "all" | "outgoing" | "problems" | "incoming" | "missed" | "unqualified";

/** Периоды журнала входящих. Числа — дни, ровно то, что понимает API (потолок 180). */
const INCOMING_PERIODS = [
  { days: 7, label: "Неделя" },
  { days: 30, label: "Месяц" },
  { days: 90, label: "Квартал" },
] as const;

/** Причина, по которой у разговора нет разбора. Порог общий с сервером. */
function missingAnalysisReason(call: CallRow): string {
  if (!call.transcript) return "Разговор не расшифрован";
  if (call.transcript.length < MIN_ANALYZED_TRANSCRIPT_CHARS) return "Слишком короткий разговор, разбор не делается";
  return "Разбор ещё готовится";
}

/**
 * Строка разговора. Раскрывается целиком (владелец 15.08.2026: «сделай так, чтобы
 * кликабельный был разговор, а то там всего одна маленькая кнопочка справа»), но
 * роль кнопки обёртке НЕ даётся: внутри живут ссылки на карточки, а интерактивное
 * внутри кнопки — сломанная разметка для экранного диктора. С клавиатуры раскрывает
 * настоящая кнопка `.pill.ghost.sm` справа, она же несёт aria-expanded.
 */
function CallRowItem({ call, showAgent }: { call: CallRow; showAgent: boolean }) {
  const [open, setOpen] = useState(false);
  const analysis = call.analysis;
  const detailsId = `call-details-${call.id}`;
  // Недозвон через CRM (18.09.2026): станция разметила callAttempt, а разговора
  // не было — ни записи, ни расшифровки не будет никогда. Показываем как
  // недозвон, а не как разговор с «0:00» и вечным «разбор ещё готовится».
  const noAnswer = !!call.callAttempt && call.callAttempt !== "TALKED";
  const attemptLabel = noAnswer ? (CALL_ATTEMPT_LABELS[call.callAttempt!] ?? "Не дозвонились") : null;

  return (
    <>
      <div className="call-row">
        <span className={`dirn${noAnswer ? " miss" : ""}`} aria-label={noAnswer ? attemptLabel! : "Исходящий"}>
          {noAnswer ? <IconMissed /> : <IconOutgoing />}
        </span>
        <div className="t">
          {/* Внутри `<b>` только текст и ссылки: правило эталона
              `.call-row .t span{display:block}` разложило бы каждый <span>
              своей строкой, и «Собир Назаров и Далер Саидов» встало бы в три. */}
          <b>
            {showAgent && call.agent ? `${call.agent.fullName} и ` : ""}
            {call.client ? (
              <Link className="lk" to={`/clients/${call.client.shortId}`}>
                {call.client.fullName}
              </Link>
            ) : (
              "Клиент удалён"
            )}
          </b>
          <span>
            {relativeTime(call.createdAt)}
            {noAnswer ? `. ${attemptLabel}` : analysis ? `. ${analysis.summary}` : ""}
          </span>
        </div>
        {noAnswer ? (
          <span className="dur crit">не дошёл</span>
        ) : (
          <span className="dur">{formatCallDuration(call.durationSec)}</span>
        )}
        {!noAnswer &&
          (analysis ? (
            <span className={`score ${scoreTone(analysis.score)}`}>Балл {analysis.score}</span>
          ) : (
            <span className="chip mute">
              {call.transcriptionStage ? "Расшифровываем" : missingAnalysisReason(call)}
            </span>
          ))}
        {!noAnswer && analysis && !analysis.agreedNextStep && <span className="chip crit">Без договорённости</span>}
        <div className="acts">
          {noAnswer ? (
            // Разговора не было — вместо «разбора» сразу кнопка перезвонить
            // (то же действие, что у пропущенного входящего ниже).
            call.client && (
              <CallClientButton
                clientId={call.client.id}
                phone=""
                variant="full"
                label="Перезвонить"
                title="Перезвонить через CRM"
                className="pill sm"
              />
            )
          ) : (
            <button
              type="button"
              className="pill ghost sm"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={detailsId}
            >
              {open ? "Свернуть разбор" : "Открыть разбор"}
            </button>
          )}
        </div>
      </div>

      {open && !noAnswer && (
        <div className="card flat" id={detailsId} style={{ marginBottom: "var(--s3)" }}>
          {/* ЖИВОЙ СТАТУС ВМЕСТО СТАТИЧНОГО «ГОТОВИТСЯ» (владелец 15.08.2026):
              пока конвейер этим звонком занят — видно ЧТО именно происходит. */}
          {!analysis && call.transcriptionStage && (
            <TranscriptionStatus stage={call.transcriptionStage} progress={call.transcriptionProgress} />
          )}
          <CallDetails
            interactionId={call.id}
            createdAt={call.createdAt}
            hasRecording={call.hasRecording}
            // Плеер сам решает, рисоваться ли, по этому флагу (04.09.2026,
            // отдельное право calls.hearRecording — см. lib/callTranscripts.ts).
            // Текст (transcript/analysis ниже) не трогаем: агент по-прежнему
            // читает свой разговор.
            canHear={call.canHear}
            transcript={call.transcript}
            transcriptRu={call.transcriptRu}
            analysis={analysis}
            // notes/agentName здесь нигде в строке журнала не показаны (в отличие
            // от хронологии карточки клиента) — есть смысл вывести их внутри.
            notes={call.notes}
            recordingDurationSec={call.durationSec}
            agentName={call.agent?.fullName ?? null}
          />
        </div>
      )}
    </>
  );
}

/**
 * Входящий — звонок, который сделал сам клиент. Ни автора, ни разбора у него нет,
 * поэтому и строка другая: направление, кто принял, метки потерь и действия.
 *
 * «Перезвонить» стоит ТОЛЬКО у пропущенного (правило владельца): у состоявшегося
 * разговора перезванивать нечего, там есть карточка клиента.
 */
function IncomingRowItem({ call }: { call: IncomingCallRow }) {
  const needsQualifying = call.answered && !!call.client && !call.qualifiedAt;
  return (
    <div className="call-row">
      <span className={`dirn${call.answered ? "" : " miss"}`} aria-label={call.answered ? "Входящий" : "Пропущенный входящий"}>
        {call.answered ? <IconIncoming /> : <IconMissed />}
      </span>
      <div className="t">
        <b>
          {call.client ? (
            <Link className="lk" to={`/clients/${call.client.shortId}`}>
              {call.client.fullName}
            </Link>
          ) : (
            // Номер незнакомого звонившего — не телефон клиента из карточки:
            // маскирование решает сервер, здесь показывается то, что он прислал.
            call.phone
          )}
        </b>
        <span>
          {relativeTime(call.startedAt)}
          {call.answered
            ? `. Поговорили ${formatCallDuration(call.talkSeconds)}${
                call.answeredByName
                  ? `, принял ${call.answeredByName}`
                  : call.answeredBy
                    ? `, оператор ${call.answeredBy}`
                    : ""
              }`
            : ". До оператора не дозвонился"}
          {call.client ? "" : ". В базе нет"}
          {call.qualifiedBy ? `. Разобрал ${call.qualifiedBy.fullName}` : ""}
        </span>
      </div>
      {call.answered ? (
        <span className="dur">{formatCallDuration(call.talkSeconds)}</span>
      ) : (
        <span className="dur crit">не дошёл</span>
      )}
      {call.irrelevant && <span className="chip mute">не по делу</span>}
      {needsQualifying && <span className="chip warn">без разбора</span>}
      {!call.answered &&
        (call.callbackAgent ? (
          <span className="chip warn">перезвонит {call.callbackAgent.fullName}</span>
        ) : (
          <span className="chip crit">Никто не перезвонил</span>
        ))}
      {/* Бейдж «без перезвона» (Пачка 18, 12.09.2026) — только пропущенные старше
          missedCallbackHours рабочих часов без исходящего контакта; посчитано на
          бэке (см. routes/calls.ts), число часов не зашито в разметку. */}
      {call.missingCallback && (
        <span className="chip crit">без перезвона {call.missedCallbackHours}ч+</span>
      )}
      <div className="acts">
        {/* ПЕРЕЗВОНИТЬ ПРЯМО ОТСЮДА (владелец 11.08.2026: «как нам звонить
            обратно? или номер набрать?»). Правило звонка не дублируем: та же
            кнопка, что везде, — сперва через станцию (запись, хронология,
            разбор), tel: только запасным путём и с объяснением. */}
        {!call.answered && (
          <CallClientButton
            clientId={call.client?.id}
            phone={call.phone}
            variant="full"
            label="Перезвонить"
            title="Перезвонить через CRM"
            className="pill sm"
          />
        )}
        {call.client && (
          <Link className="pill ghost sm" to={`/clients/${call.client.shortId}`}>
            Открыть клиента
          </Link>
        )}
        <BlockCallerButton callId={call.id} known={!!call.client} />
      </div>
    </div>
  );
}

/**
 * «Показать ещё» вместо «Назад/Вперёд» (решение владельца 15.09.2026) — общий
 * components/Pagination.tsx (`loadMore`), а не своя копия: своя не возвращала
 * со страницы за краем выдачи. Список уже накоплен вызывающей стороной
 * (useAccumulatedPages), здесь только запрос следующей страницы.
 */
function Pager(props: { page: number; total: number; pageSize: number; onPageChange: (page: number) => void }) {
  return (
    <div style={{ marginTop: 16 }}>
      <Pagination variant="loadMore" {...props} />
    </div>
  );
}

export function Calls() {
  const can = useCan();
  /**
   * ДВА РАЗНЫХ РАЗДЕЛА ПОД ОДНИМ АДРЕСОМ.
   *
   * Администрация (calls.transcripts) видит разговоры всей команды: сводку, ночной
   * разбор, журнал входящих и фильтр по сотруднику. Агент (calls.ownTranscripts)
   * видит ТОЛЬКО свои разговоры — запись, расшифровку и совет по ним (владелец
   * 15.08.2026). Всё, что рассказывает о работе других людей, ему не показывается и
   * не запрашивается: эти маршруты ответили бы 403 и оставили экран в вечной
   * загрузке.
   */
  const supervisor = can("calls.transcripts");
  const canSeeLiveVoice = useCanSeeLiveVoiceSessions();
  const allowed = supervisor || can("calls.ownTranscripts");
  // Открытие раздела гасит красный счётчик в сайдбаре (у текущего агента).
  useMarkSectionSeen("calls");
  // Полоса «Обращения» — тот же набор, что на Сообщениях/Комментариях/Телефонии
  // (docs/archive/menu-wave2-brief-15-09.md). Хук зовём до ранних return (правило хуков).
  // < lg — мобильные экраны по прототипу (vCalls у руководства, vMyCalls у агента);
  // порог тот же, что у мобильной ветки «Сообщений».
  const narrow = useNarrowScreen();
  const clean = useCleanShell();
  const [searchParams, setSearchParams] = useSearchParams();
  /**
   * Срез читается из адреса (`?slice=missed` и т.п.) — так плитки «Телефонии» и
   * главной директора ведут не на голый журнал, а сразу в нужный срез (задание
   * 15.09.2026). Неизвестное/отсутствующее значение — как раньше, срез «Все».
   */
  const sliceFromUrl = (value: string | null): Slice =>
    value === "outgoing" || value === "problems" || value === "incoming" || value === "missed" || value === "unqualified" ? value : "all";
  const [slice, setSlice] = useState<Slice>(() => sliceFromUrl(searchParams.get("slice")));
  const [page, setPage] = useState(1);
  const [incomingPage, setIncomingPage] = useState(1);
  // ?agentId= — плитка «Звонков за неделю»/«Пропустил звонков» карточки сотрудника
  // (TeamMemberDetail.tsx) ведёт сюда сразу отфильтрованной на этого агента.
  const [agentId, setAgentId] = useState<string>(() => searchParams.get("agentId") ?? "");
  const [days, setDays] = useState<number>(30);
  const [operator, setOperator] = useState("");
  const [dialOpen, setDialOpen] = useState(false);
  // «Без перезвона» (Пачка 18, 12.09.2026) — сужает журнал входящих до пропущенных,
  // по которым до сих пор нет исходящего контакта (см. missingCallback на бэке).
  const [noCallbackOnly, setNoCallbackOnly] = useState(false);
  // Поиск по имени/номеру — «как в телефоне» (18.09.2026). Сервер не умеет искать
  // по журналу, поэтому ищем в уже загруженной странице, тем же приёмом, что
  // мобильная лента агента (MobileCallsAgent, hooks/useCalls.ts).
  const [q, setQ] = useState("");

  const callsSlice = slice === "all" || slice === "outgoing" || slice === "problems";

  // На узком экране данные запрашивают сами мобильные компоненты (те же хуки и
  // ключи кэша) — здесь запросы выключены, чтобы не ходить в сеть дважды.
  const desktop = allowed && !narrow;
  const { data, isLoading, error, refetch } = useCalls(
    { agentId: agentId || undefined, problems: slice === "problems", page },
    { enabled: desktop && callsSlice }
  );
  const { data: summary, isError: summaryFailed, isLoading: summaryLoading, refetch: retrySummary } = useCallsSummary(30, { enabled: supervisor && !narrow });
  const { data: insights } = useCallInsights({ enabled: supervisor && !narrow });
  const { data: agents } = useAgents({ enabled: supervisor && !narrow });
  // Плитки «Сегодня» — данные станции, а не месячная сводка (эталон, тайл со
  // средним баллом остаётся месячным: разбор разговоров за сутки — редкость).
  const { data: dashboard, isError: dashboardFailed, isLoading: dashboardLoading, refetch: retryDashboard } = useTelephonyDashboard({ enabled: supervisor && !narrow });
  // Входящие опрашиваются всегда, когда раздел открыт администрации: их счётчики
  // стоят на плитках и на самих срезах, а не только внутри своего среза.
  const {
    data: incoming,
    isLoading: incomingLoading,
    error: incomingError,
    refetch: refetchIncoming,
  } = useIncomingCalls(
    {
      missed: slice === "missed",
      unqualified: slice === "unqualified",
      noCallback: noCallbackOnly,
      operator: operator || undefined,
      days,
      page: incomingPage,
    },
    { enabled: supervisor && !narrow }
  );
  // Раздел «Звонки» открыт только администрации, а ей сервер отдаёт полный объект
  // настроек (см. routes/settings.ts, toPublicSettings) — отдельный запрос не нужен.
  const { data: settings } = useSettings();

  // Мягкая подгрузка вместо страниц (решение владельца 15.09.2026): оба журнала —
  // «Все/Проблемные» и «Входящие» — копят страницы в ленту, каждый сбрасывается
  // своим набором условий (срез журнала звонков не влияет на входящие и наоборот).
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: callsHead } = useCalls(
    { agentId: agentId || undefined, problems: slice === "problems", page: 1 },
    { enabled: desktop && callsSlice && page > 1 }
  );
  const { data: incomingHead } = useIncomingCalls(
    {
      missed: slice === "missed",
      unqualified: slice === "unqualified",
      noCallback: noCallbackOnly,
      operator: operator || undefined,
      days,
      page: 1,
    },
    { enabled: supervisor && !narrow && incomingPage > 1 }
  );
  const callsFeed = useAccumulatedPages(data?.items, page, `${agentId}:${slice === "problems"}`, callsHead?.items);
  const incomingFeed = useAccumulatedPages(
    incoming?.items,
    incomingPage,
    `${slice}:${noCallbackOnly}:${operator}:${days}`,
    incomingHead?.items
  );
  const needle = q.trim().toLowerCase();
  const visibleCallsFeed = needle
    ? callsFeed.filter(
        (c) => (c.client?.fullName ?? "").toLowerCase().includes(needle) || (c.agent?.fullName ?? "").toLowerCase().includes(needle)
      )
    : callsFeed;
  const visibleIncomingFeed = needle
    ? incomingFeed.filter(
        (c) => (c.client?.fullName ?? "").toLowerCase().includes(needle) || (c.phone ?? "").toLowerCase().includes(needle)
      )
    : incomingFeed;
  const forwardPhone = settings?.incomingForwardPhone?.trim() || null;
  // Операторы — те сотрудники, у кого есть внутренний номер: только они могут
  // оказаться в `answeredBy`, и предлагать в фильтре остальных значит предлагать
  // заведомо пустой результат.
  const withExtension = (agents ?? []).filter((a) => a.sipExtension);

  const pickSlice = (next: Slice) => {
    setSlice(next);
    setPage(1);
    setIncomingPage(1);
  };

  // Плитки «Сегодня» ведут в журнал ниже: переключают срез и прокручивают к нему.
  const goToSlice = (next: Slice) => {
    pickSlice(next);
    document.getElementById("call-log")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };

  // MobileCallsSupervisor owns these URL keys on a phone. The retained
  // desktop state must not erase its selected slice after a mobile click.
  useSyncFiltersToUrl(searchParams, setSearchParams, narrow ? {} : {
    slice: slice === "all" ? undefined : slice,
    agentId: agentId || undefined,
  });

  if (!allowed) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Звонки</h1>
              <p className="sub">Записи и расшифровки разговоров доступны только администрации.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Мобильные ветки — свои экраны прототипа; десктоп ниже не тронут.
  if (narrow) {
    return supervisor ? <MobileCallsSupervisor /> : <MobileCallsAgent />;
  }

  const missedNobody = incoming?.items.filter((c) => !c.answered && !c.callbackAgent).length ?? 0;
  const listError = callsSlice ? error : incomingError;
  const listLoading = callsSlice ? isLoading : incomingLoading;
  const retry = callsSlice ? refetch : refetchIncoming;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className={clean ? "flex items-start justify-between gap-5" : "pg-h"}>
          <div>
            <h1 className={clean ? "!text-[28px] !leading-tight !mb-2" : undefined}>{supervisor ? "Звонки" : "Мои звонки"}</h1>
            <p className={clean ? "text-[16px] text-gray-500" : "sub"}>
              {clean ? "Журнал, записи и разбор разговоров с клиентами." : supervisor
                ? "Разговоры с клиентами: запись, расшифровка и разбор качества. Разговоры коллег видит администрация."
                : "Ваши разговоры с клиентами: запись, расшифровка и совет по каждому. Разговоры коллег доступны только администрации."}
            </p>
          </div>
          {/* Наборщик в шапке — по эталону. Право то же, что у «Телефонии»
              (calls.transcripts): агенту он не показывается, у него набор живёт
              на мобильном экране, как решил владелец 17.08.2026. */}
          {supervisor && (
            <div className="acts">
              {clean ? <CButton onClick={() => setDialOpen(true)}><IconKeypad />Набрать номер</CButton> : <button type="button" className="pill ghost" onClick={() => setDialOpen(true)}>
                <IconKeypad />
                Набрать номер
              </button>}
            </div>
          )}
        </div>

        <InboxTabs />

        {/* Идущие сейчас разговоры робота: слушать вживую. Блока нет, пока на линии пусто.
            Права проверяет сам блок (те же три, что у записи разговора робота). */}
        {supervisor && <LiveVoiceListenDesk />}

        {/* Срочное тихой строкой, не карточкой (память 03.09). */}
        {!clean && supervisor && (missedNobody > 0 || (summary?.steps && summary.steps.agreedNextStep < 50)) && (
          <div className="card tight">
            {missedNobody > 0 && (
              <div className="quiet crit">
                <span className="dot crit" />
                <span className="txt">
                  {missedNobody === 1
                    ? "Один пропущенный звонок остался без ответа: никто не перезвонил."
                    : `${missedNobody} пропущенных звонков остались без ответа: никто не перезвонил.`}
                </span>
                <button type="button" className="lnk" onClick={() => pickSlice("missed")}>
                  Посмотреть
                </button>
              </div>
            )}
            {summary?.steps && summary.steps.agreedNextStep < 50 && (
              <div className="quiet warn">
                <span className="dot warn" />
                <span className="txt">
                  Договорённостью о следующем шаге заканчивается только {summary.steps.agreedNextStep}% разговоров.
                </span>
                <button type="button" className="lnk" onClick={() => pickSlice("problems")}>
                  Посмотреть
                </button>
              </div>
            )}
          </div>
        )}

        {/* «Сегодня» — по эталону: живые счётчики станции (5с опрос), а не месячная
            сводка. Средний балл остаётся месячным — разбор за одни сутки почти
            ничего не значит, столько разговоров за день не разбирается. */}
        {supervisor && (clean ? <CleanCallsSummary activeSlice={slice} failed={summaryFailed || dashboardFailed} loading={summaryLoading || dashboardLoading} retry={() => Promise.allSettled([retrySummary(), retryDashboard()])} unreturnedOnPage={missedNobody} today={dashboard?.today} averageScore={summary?.averageScore} agreedNextStep={summary?.steps?.agreedNextStep} onSlice={goToSlice} /> : <>
            <div className="sec-h">
              <h2>Сегодня</h2>
              <span className="note">данные станции, обновляются сами</span>
            </div>
            <div className="tiles">
              <StatTile
                label="Входящих"
            dot="ok"
                value={dashboard ? dashboard.today.incoming : "…"}
                line="с начала суток по Душанбе"
                onClick={() => goToSlice("incoming")}
                title="Журнал входящих звонков"
              />
              <StatTile
                label="Исходящих"
            dot="ok"
                value={dashboard ? dashboard.today.outgoing : "…"}
                line="агенты звонили сами"
                onClick={() => goToSlice("all")}
                title="Все разговоры журналом"
              />
              <StatTile
                label="Пропущено"
            dot={dashboard && dashboard.today.missed > 0 ? "crit" : "ok"}
                value={dashboard ? dashboard.today.missed : "…"}
                line={missedNobody > 0 ? "по части никто не перезвонил" : "срез «Пропущенные» ниже"}
                critical={missedNobody > 0}
                onClick={() => goToSlice("missed")}
                title="Пропущенные звонки"
              />
              <StatTile
                label="Средний балл"
            dot={summary?.averageScore == null ? undefined : summary.averageScore >= 70 ? "ok" : "warn"}
                value={summary?.averageScore ?? "…"}
                line={
                  summary?.steps
                    ? `за месяц, договорённость в ${summary.steps.agreedNextStep} из 100`
                    : "разобранных разговоров пока нет"
                }
                onClick={() => goToSlice("problems")}
                title="Разговоры, требующие внимания"
              />
            </div>
          </>
        )}

        {/* Ночной разбор. Отвечает не на «сколько», а на «что с этим делать» — то,
            чего цифры сводки сказать не могут. Считается раз в сутки, поэтому стоит
            отдельным блоком, а не пересчитывается при каждом заходе. */}
        {supervisor && insights && (insights.weaknesses.length > 0 || insights.actions.length > 0) && (
          <CallsInsightsDisclosure clean={clean}>
            <div className="sec-h">
              <h2>Разбор разговоров</h2>
              <span className="note">
                за {insights.days} дней, {insights.calls} звонков
              </span>
            </div>
            <div className="card">
              {insights.weaknesses.length > 0 && (
                <>
                  <div className="sec-t">Где теряем клиентов</div>
                  <p style={{ fontSize: "var(--fs-15)", color: "var(--body)", textWrap: "pretty" }}>
                    {insights.weaknesses.join(" · ")}
                  </p>
                </>
              )}
              {insights.actions.length > 0 && (
                <>
                  <div className="sec-t">Что сделать</div>
                  <p style={{ fontSize: "var(--fs-15)", color: "var(--body)", textWrap: "pretty" }}>
                    {insights.actions.join(" · ")}
                  </p>
                </>
              )}
              {insights.strengths.length > 0 && (
                <>
                  <div className="sec-t">Что получается</div>
                  <p style={{ fontSize: "var(--fs-15)", color: "var(--body)", textWrap: "pretty" }}>
                    {insights.strengths.join(" · ")}
                  </p>
                </>
              )}
              {insights.demand.length > 0 && (
                <>
                  <div className="sec-t">Что спрашивает рынок</div>
                  <p style={{ fontSize: "var(--fs-15)", color: "var(--body)", textWrap: "pretty" }}>
                    {insights.demand.join(" · ")}
                  </p>
                </>
              )}
              {summary && summary.objections.length > 0 && (
                <>
                  <div className="sec-t">Что чаще всего мешает клиентам</div>
                  <p style={{ fontSize: "var(--fs-15)", color: "var(--body)", textWrap: "pretty" }}>
                    {summary.objections.slice(0, 5).map((o) => `${o.text} (${o.count})`).join(" · ")}
                  </p>
                </>
              )}
            </div>
          </CallsInsightsDisclosure>
        )}

        <div className={clean ? "card !p-5 [&_.inp]:!text-[16px] [&_.seg_button]:!text-[14px] [&_.note]:!text-[14px] [&_.call-row_.t_b]:!text-[16px] [&_.call-row_.t_span]:!text-[14px] [&_.call-row_.pill]:!text-[14px]" : "card"} id="call-log">
          {clean && <h2 className="!mb-4 !text-[18px]">Журнал звонков</h2>}
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Срезы звонков">
              <button
                type="button"
                role="tab"
                aria-selected={slice === "all" || slice === "outgoing"}
                onClick={() => pickSlice("all")}
              >
                {supervisor ? (slice === "outgoing" ? "Исходящие" : "Все") : "Мои"} {data && callsSlice && <span className="n">{data.total}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={slice === "problems"}
                onClick={() => pickSlice("problems")}
              >
                Требуют внимания
              </button>
              {/* Журнал входящих — это работа операторов и потери агентства целиком;
                  агенту он не показывается и не запрашивается (сервер ответил бы 403). */}
              {supervisor && (
                <>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={slice === "incoming"}
                    onClick={() => pickSlice("incoming")}
                  >
                    Входящие {incoming && <span className="n">{incoming.periodTotal}</span>}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={slice === "missed"}
                    onClick={() => pickSlice("missed")}
                  >
                    Пропущенные {incoming && incoming.missed > 0 && <span className="n">{incoming.missed}</span>}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={slice === "unqualified"}
                    onClick={() => pickSlice("unqualified")}
                  >
                    Без разбора{" "}
                    {incoming && incoming.unqualified > 0 && <span className="n">{incoming.unqualified}</span>}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className={clean ? "filters !gap-3 !items-center" : "filters"} style={{ marginTop: 16 }}>
            {/* Выбор сотрудника — только у того, кому открыты чужие разговоры.
                Агенту он показывал бы список коллег, любой выбор в котором сервер
                всё равно перепишет на него самого. */}
            {supervisor && callsSlice && (
              <label className="field" style={{ minWidth: 200 }}>
                <span className="vh">Сотрудник</span>
                <select
                  className="inp"
                  style={{ maxWidth: "none" }}
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

            {/* Период и оператор — те же два вопроса, что задают списку разговоров
                («как работает конкретный человек» и «что было за период»): у
                входящих их когда-то не было вовсе, журнал всегда показывал 30 дней. */}
            {!callsSlice && (
              <>
                <label className="field" style={{ minWidth: 160 }}>
                  <span className="vh">Период</span>
                  <select
                    className="inp"
                    style={{ maxWidth: "none" }}
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
                  <label className="field" style={{ minWidth: 200 }}>
                    <span className="vh">Оператор</span>
                    <select
                      className="inp"
                      style={{ maxWidth: "none" }}
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
                {/* «Без перезвона» — сужает журнал до пропущенных без исходящего
                    контакта дольше порога (Settings.missedCallbackHours, бэк уже
                    посчитал who). См. lib/telephony/missedCallEscalation.ts. */}
                <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={noCallbackOnly}
                    onChange={(e) => {
                      setNoCallbackOnly(e.target.checked);
                      setIncomingPage(1);
                    }}
                  />
                  <span>Без перезвона</span>
                </label>
              </>
            )}

            {/* Поиск по уже загруженной странице (18.09.2026) — тот же приём,
                что у мобильной ленты агента: серверного поиска по журналу нет. */}
            <label className="field" style={{ minWidth: 220 }}>
              <span className="vh">{clean && callsSlice ? "Клиент или сотрудник среди загруженных" : "Имя клиента или номер"}</span>
              <input
                className="inp"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={clean ? (callsSlice ? "Клиент или сотрудник" : "Клиент или номер") : "Имя клиента или номер"}
              />
            </label>

            <span className="spacer" />
            {callsSlice
              ? data && (
                  <span className="note">
                    {needle
                      ? `Нашли ${visibleCallsFeed.length} из ${callsFeed.length} загруженных`
                      : `Показаны ${data.items.length} разговоров из ${data.total}`}
                  </span>
                )
              : incoming && (
                  <span className="note">
                    {needle
                      ? `Нашли ${visibleIncomingFeed.length} из ${incomingFeed.length} загруженных`
                      : `Показаны ${incoming.items.length} звонков из ${incoming.total}`}
                  </span>
                )}
          </div>

          {clean && <p className="mb-3 text-[14px] text-gray-500">Поиск по загруженным звонкам. Чтобы искать дальше, нажмите «Показать ещё».</p>}

          {/* Номер переадресации показывается ИМЕННО ЗДЕСЬ: это единственное место,
              где смотрят на пропущенные и задаются вопросом, куда они делись. */}
          {!callsSlice && forwardPhone && (
            <div className="quiet">
              <span className="dot" />
              <span className="txt">
                Когда оператор недоступен, станция уводит звонок на <b>{forwardPhone}</b>: часть пропущенных здесь
                могла быть принята там.
              </span>
            </div>
          )}

          {/* Единое состояние ошибки вместо вечно пустого экрана (приёмка 08.09). */}
          {listError && (
            <div className="state err">
              <span className="dot crit" />
              Журнал разговоров не загрузился. Это сбой связи, а не тишина в эфире.
              <button
                type="button"
                className="lnk"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => retry()}
              >
                Повторить
              </button>
            </div>
          )}

          {listLoading && !listError && (
            <div className="state">
              <span className="sk av" />
              <span className="sk w40" />
              <span className="sk w22" />
              Загружаем разговоры
            </div>
          )}

          {callsSlice && data && data.items.length === 0 && (
            <div className="empty">
              <span className="ic">
                <IconPhone />
              </span>
              <p>
                {slice === "problems"
                  ? "Проблемных разговоров нет: все заканчивались договорённостью о следующем шаге."
                  : "За выбранный период разговоров нет. Позвоните клиенту из карточки, и звонок появится здесь."}
              </p>
            </div>
          )}

          {!callsSlice && incoming && incoming.items.length === 0 && (
            <div className="empty">
              <span className="ic">
                <IconPhone />
              </span>
              <p>
                {slice === "unqualified"
                  ? "Все разговоры разобраны: у каждого указан тип обращения."
                  : slice === "missed"
                    ? "За выбранный период оператор ответил на все звонки."
                    : "Здесь появятся звонки, которые клиенты сделали сами на номер агентства."}
              </p>
            </div>
          )}

          {needle && (callsSlice ? visibleCallsFeed : visibleIncomingFeed).length === 0 && (
            <div className="empty">
              <span className="ic">
                <IconPhone />
              </span>
              <p>Никого не нашли среди загруженных звонков. Проверьте написание или подгрузите ещё страниц.</p>
            </div>
          )}

          <div className="list" style={{ marginTop: 8 }}>
            {callsSlice
              ? visibleCallsFeed.map((call) => <CallRowItem key={call.id} call={call} showAgent={supervisor} />)
              : visibleIncomingFeed.map((call) => <IncomingRowItem key={call.id} call={call} />)}
          </div>

          {callsSlice
            ? data && <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPageChange={setPage} />
            : incoming && (
                <Pager
                  page={incoming.page}
                  total={incoming.total}
                  pageSize={incoming.pageSize}
                  onPageChange={setIncomingPage}
                />
              )}
        </div>

        {/* Сервер отдаёт список только при ДВУХ правах (аудит №6): supervisor их не гарантирует. */}
        {supervisor && canSeeLiveVoice && <LiveVoiceSessionsDesk />}

        {dialOpen && <DialPadModal onClose={() => setDialOpen(false)} />}
      </div>
    </div>
  );
}
