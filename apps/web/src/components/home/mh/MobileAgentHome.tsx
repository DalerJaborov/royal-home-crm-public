import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeftRight, Calendar, CheckSquare, ChevronRight, Home as HomeIcon, MessageSquare, Phone } from "lucide-react";
import { useAuthStore } from "../../../store/auth";
import { usePendingAcceptAlert } from "../../../hooks/usePendingAccept";
import { useDashboardSummary } from "../../../hooks/useDashboard";
import { useCan } from "../../../lib/permissions";
import {
  useAcceptLead,
  useAcceptReactivationOffer,
  useClients,
  useConfirmDuplicateReview,
  useDeclineReactivationOffer,
  useDenyDuplicateReview,
  useDuplicateReviews,
  useReactivationOffers,
  isRequiresRelease,
  type DuplicateReviewItem,
  type ReactivationOffer,
} from "../../../hooks/useClients";
import { useSettings } from "../../../hooks/useSettings";
import { useCounters } from "../../../hooks/useCounters";
import { getIncomingLeadShownId, subscribeIncomingLeadShown } from "../../../lib/incomingLeadBus";
import { CallClientButton } from "../../CallClientButton";
import { SwipeRow } from "../../SwipeRow";
import { MutationError } from "../../MutationError";
import { focusReason } from "../../../lib/focusReason";
import { formatMoney, pluralizeRu, relativeTime } from "../../../lib/format";
import { dushanbeTime } from "../../../lib/date";
import { CLIENT_SOURCE_LABELS, clientDisplayName } from "../../../lib/clientFormat";
import { AVATAR_TONES } from "../../../lib/theme2026Person";
import {
  buildNoContact,
  buildPortfolio,
  buildShowings,
  daysSince,
  findGap,
  NO_CONTACT_DAYS,
} from "../../../lib/agentDay";
import { MhMoney, MhNoData, MhQuiet, MhScreen, MhSection, mmss, useSecondTick } from "./MhScreen";
import type { Client, Interaction } from "../../../types";
import type { DashboardSummary } from "../../../hooks/useDashboard";

type FirstCallDueItem = DashboardSummary["firstCallDue"][number];

/**
 * ГЛАВНАЯ АГЕНТА НА ТЕЛЕФОНЕ — разметка мобильного артефакта владельца,
 * дословно (docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html,
 * функция `renderHomeAgent`). Порядок секций взят у артефакта, а не у
 * пересказа задания: «Ждут вашего принятия» → «Мой фокус» → «Далее по
 * приоритету» → «Между встречами» → «Показы сегодня» → «Деньги».
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПК. Ничем по данным: те же хуки, что у
 * components/home/AgentHome.tsx (useDashboardSummary, useClients,
 * useReactivationOffers, useDuplicateReviews,
 * useSettings), и общий счёт дня — lib/agentDay.ts, чтобы «горит сейчас» на
 * ПК и на телефоне не разъехалось. Отличается только разметка: у владельца
 * два разных артефакта, и телефонный он 11.09 потребовал «точь-в-точь».
 * Разметка ПК (`tpl-home-agent`, белая карточка `.card.aib`) на телефоне
 * отвергнута — она и была той «белой коробкой с рамкой».
 *
 * ЧТО ВЗЯТО ИЗ АРТЕФАКТА ДОСЛОВНО: имена и вложенность классов (`.sec`,
 * `.sec-t`, `.card-s`, `.row`, `.av`, `.plate`, `.focus`, `.chip`, `.hint`,
 * `.chips`, `.money`, `.bar`, `.sw`), тексты заголовков и правых подписей,
 * обратный отсчёт у ждущих принятия заявок, смахивание строки в «Далее по
 * приоритету».
 *
 * ЧЕГО В АРТЕФАКТЕ НЕТ, А ЗДЕСЬ ЕСТЬ, И ПОЧЕМУ. Предложения реактивации и
 * вопрос «это ваш клиент?» — они стоят в тех же строках «ждут вашего
 * решения». Их нельзя просто не перенести: это ДЕЙСТВИЯ (принять карточку
 * обратно, подтвердить дубль), и без них лид не раздаётся дальше никому
 * (раздел L, правило 03.09.2026). Молча выронить их при переносе разметки —
 * ровно тот класс ошибки, из-за которого правило «ничего не терять»
 * появилось.
 *
 * ЧЕГО НЕТ И НЕ БУДЕТ: строки «Нет сети» из артефакта (у приложения свой
 * OfflineBanner в оболочке) и придуманных советов ИИ прозой — сервер такого
 * ответа не даёт, а выдумывать числа и фразы запрещено.
 */
export function MobileAgentHome() {
  const agent = useAuthStore((s) => s.agent);
  const navigate = useNavigate();
  const can = useCan();
  const { data, isLoading, isError, error, refetch } = useDashboardSummary();
  // Тот же серверный фильтр и тот же ключ кэша, что у PendingLeadsRows на ПК
  // и у IncomingLeadWindow: общий кэш, а не второй список.
  const { data: pendingPage } = useClients({ pageSize: 20, pendingAcceptance: true });
  /**
   * СТО ПОЛНЫХ КАРТОЧЕК РАДИ ОДНОЙ СТРОКИ (исправлено 19.09.2026).
   *
   * Здесь стояло `useClients({ pageSize: 100 })`, а весь результат нужен ровно
   * для одной подсказки в секции «Между встречами» — `noContact[0]`, клиент,
   * который дольше всех без контакта. Сотня карточек клиента — самый тяжёлый
   * ответ этого API, и он приезжал на КАЖДОЕ открытие главной, на мобильном
   * интернете, вместе с шестью другими запросами этого же экрана.
   *
   * Сервер умеет сортировать по давности последнего контакта сам
   * (`contact_asc`, CLIENT_SORTS), поэтому нужные карточки — в первых строках.
   * Берём короткую страницу: 30 вместо 100 с запасом на те, что отсеет
   * buildPortfolio (непринятые, закрытые, неактивные).
   */
  const { data: clientsPage } = useClients({ pageSize: 30, sort: "contact_asc" });
  const { data: settings } = useSettings();
  // Тот же счётчик сделок, что уже показывает значок раздела в меню — запрос
  // общий и закэширован, лишнего похода в сеть плитка не добавляет.
  const { data: counters } = useCounters();
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  // «обновлено 13:05» — момент открытия экрана, снят один раз при монтировании.
  const [openedAt] = useState(() => new Date());

  const tasks = useMemo(() => data?.tasksToday ?? [], [data]);
  const [focus, ...rest] = tasks;
  /**
   * СРОК ПЕРВОГО ЗВОНКА (задание 17.09.2026, «клиент теряется, если вовремя не
   * позвонить»): сервер уже отдаёт только непрозвоненные принятые карточки,
   * отсортированные по dueAt (routes/dashboard.ts) — самая срочная первой.
   * Она занимает «Мой фокус» (вытесняя обычную задачу дня, см. ниже), остальные
   * идут в «Далее по приоритету» тем же порядком.
   */
  const firstCallDue = useMemo(() => data?.firstCallDue ?? [], [data]);
  const [urgentCall, ...restCalls] = firstCallDue;
  /** «Вам назначил руководитель» (23.09.2026) — без тех, что уже стоят строкой
   *  срока первого звонка: одна карточка, одна строка. */
  const supervisorAssigned = useMemo(() => {
    const dueIds = new Set(firstCallDue.map((c) => c.id));
    return (data?.assignedBySupervisor ?? []).filter((c) => !dueIds.has(c.id));
  }, [data, firstCallDue]);
  // Сроки первого звонка — тоже дела на сегодня (23.09.2026): «Сначала сделайте
  // это: позвонить, осталось 6:02» стояло под крупным «0, на сегодня всё сделано».
  const todayCount = tasks.length + firstCallDue.length;
  const callTick = useSecondTick(firstCallDue.length > 0);
  const clients = useMemo(() => clientsPage?.items ?? [], [clientsPage]);
  const portfolio = useMemo(() => buildPortfolio(clients, Date.now()), [clients]);
  const noContact = useMemo(() => buildNoContact(portfolio, Date.now()), [portfolio]);
  const showings = useMemo(() => buildShowings(tasks), [tasks]);
  const gap = useMemo(() => findGap(showings, Date.now()), [showings]);

  /* Требований-окон здесь больше нет: механизм обязательных окон удалён
     13.09.2026 (владелец: «вообще убери»). Остались обычные задачи. */
  // useMemo, а не голое `?? []`: значение читает `visiblePending` ниже своим
  // useMemo, и без стабильной ссылки тот пересчитывался бы на каждый рендер
  // (react-hooks/exhaustive-deps, поймано сборкой при добавлении гейта
  // полноэкранного окна 15.09.2026).
  const pending = useMemo(() => pendingPage?.items ?? [], [pendingPage]);
  const shownTasks = rest.slice(0, 3);
  const overflow = rest.length - shownTasks.length;

  // Таймеры принятия — второе правило тревоги владельца. Хук считает,
  // просрочен ли какой-то лид, и сам перезапускает расчёт ровно к моменту
  // следующего срока (свой `setTimeout` внутри хука).
  const pendingAlert = usePendingAcceptAlert(pending, settings?.leadAcceptMinutes ?? null);
  const monthName = new Date().toLocaleDateString("ru-RU", { month: "long", timeZone: "Asia/Dushanbe" });
  const plan = data?.kpis.commissionPlan ?? 0;
  const commission = data?.kpis.commissionMonth ?? 0;
  const ownScope = data?.kpis.commissionScope === "own";
  const pct = plan > 0 ? Math.min(100, Math.round((commission / plan) * 100)) : 0;

  const pendingTotal = pendingPage?.total ?? pending.length;

  // Лид, который прямо сейчас занимает полноэкранное «Входящий лид»
  // (IncomingLeadWindow, смонтировано в AppLayout поверх всех разделов) — его
  // не дублируем строкой здесь (владелец 15.09.2026). Секция сама пропадает
  // из главной, когда после вычета этого лида ждать больше нечего, и сама
  // появляется снова, если лидов несколько сразу или полноэкранное почему-то
  // не поднялось — см. lib/incomingLeadBus.ts.
  const shownLeadId = useSyncExternalStore(subscribeIncomingLeadShown, getIncomingLeadShownId, getIncomingLeadShownId);
  const { data: reactivationOffers } = useReactivationOffers();
  const { data: duplicateReviews } = useDuplicateReviews();
  const offerItems = reactivationOffers ?? [];
  const reviewItems = duplicateReviews ?? [];
  const visiblePending = useMemo(
    () => pending.filter((c) => c.id !== shownLeadId),
    [pending, shownLeadId]
  );
  const suppressedByFullscreen = shownLeadId !== null && pending.some((c) => c.id === shownLeadId) ? 1 : 0;
  const adjustedPendingTotal = Math.max(0, pendingTotal - suppressedByFullscreen);
  const showPendingSection = adjustedPendingTotal + offerItems.length + reviewItems.length > 0;

  // Быстрые кнопки под шапкой (макет c99db05f, quickRow('AGENT')): то, что
  // агент открывает каждый день и чего нет в нижнем меню — «Клиенты» и
  // «Чаты» туда не попадают, они уже вкладки (lib/navigation.ts, `nav2`
  // и `chats`).
  //
  // 15.09.2026, владелец: «Показы» и «Задачи» вели в ОДНО место (/calendar) —
  // две плитки из четырёх открывали один экран. «Показы» заменены на
  // «Сделки» (/deals): свой раздел, агенту нужен ежедневно, в нижнем меню
  // его нет. Сами показы никуда не делись — секция «Показы сегодня» ниже
  // на этом же экране.
  //
  // Счётчик — только если число реально приходит в данных, которые экран
  // уже получил: «Задачи» берут tasks.length, тот же, что в большой цифре
  // сверху, «Сделки» — counters.deals, тот же счётчик, что показывает значок
  // раздела в меню. Для «Объекты» и «Звонки» такого числа в этом экране нет
  // — выдумывать запрещено, плитки идут без счётчика.
  type QuickItem = {
    key: string;
    label: string;
    icon: typeof HomeIcon;
    tone: "aqua" | "lav" | "lime" | "sky";
    to: string;
    count: number | null;
  };
  const quickItems: QuickItem[] = [
    { key: "properties", label: "Объекты", icon: HomeIcon, tone: "aqua", to: "/properties", count: null },
    can("calls.transcripts") || can("calls.ownTranscripts")
      ? { key: "calls", label: "Звонки", icon: Phone, tone: "lav", to: "/calls", count: null }
      : null,
    { key: "deals", label: "Сделки", icon: ArrowLeftRight, tone: "lime", to: "/deals", count: counters?.deals || null },
    { key: "tasks", label: "Задачи", icon: CheckSquare, tone: "sky", to: "/calendar", count: tasks.length || null },
  ].filter((item): item is QuickItem => item !== null);

  return (
    <MhScreen greeting={`Салом${firstName ? `, ${firstName}` : ""}`}>
      <section className="sec" style={{ marginTop: 6 }}>
        <div className="quick">
          {quickItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className="q"
              onClick={() => navigate(item.to)}
            >
              <span className="wr">
                <span className={`plate ${item.tone}`} aria-hidden="true">
                  <item.icon className="i" />
                </span>
                {item.count ? <span className="cnt2">{item.count}</span> : null}
              </span>
              <b>{item.label}</b>
            </button>
          ))}
        </div>
      </section>

      {/* ЗНАК ИИ УБРАН С ГЛАВНОЙ АГЕНТА (14.09.2026 и 15.09.2026, владелец:
          «ИИ лицо, который мы создавали, надо полностью удалить везде и с
          настроек, оно не очень оказалось удобным и полезным»). Раньше
          здесь стоял знак (12.09, `AiHeroMark`) — крупное число дел на
          сегодня и подпись остаются на его месте, дыры не будет; счётчик-
          пилюля ждущих принятия (другое число, не то же самое, что дел на
          сегодня) переехал в подпись, а не пропал.

          Тревога («время принять лид вышло») считает `usePendingAcceptAlert`
          выше — с 15.09.2026 это чистый локальный расчёт с таймером, без
          шины настроения и без звука: оба были частью удалённого знака ИИ и
          удалены вместе с ним. */}
      <section className="sec" style={{ marginTop: 6 }}>
        <div className="card-s big">
          <div className="ai-hero" data-tone={pendingAlert ? "crit" : todayCount === 0 && pendingTotal === 0 ? "ok" : undefined}>
            <div className="ai-hero-txt">
              <div className="ai-hero-num">{todayCount}</div>
              <div className="ai-hero-lbl">
                {todayCount === 0 ? "на сегодня всё сделано" : "дел на сегодня"}
                {pendingTotal > 0
                  ? ` · ${pendingTotal} ${pluralizeRu(pendingTotal, ["заявка ждёт", "заявки ждут", "заявок ждут"])} принятия`
                  : ""}
              </div>
            </div>
          </div>
        </div>
      </section>

      {showPendingSection && (
        <PendingSection
          pending={visiblePending}
          offerItems={offerItems}
          reviewItems={reviewItems}
          // `data.total`, а не `pending.length` — `pendingPage` ограничен
          // pageSize=20 (предел запроса виджета), а ждущих в базе может быть
          // больше; без честного total секция молча теряла хвост сверх
          // двадцати и подписывала его так, будто ждущих ровно столько,
          // сколько поместилось на экране. Уже без того лида, который занял
          // полноэкранное окно (adjustedPendingTotal, см. выше).
          pendingTotal={adjustedPendingTotal}
          leadAcceptMinutes={settings?.leadAcceptMinutes ?? null}
        />
      )}

      {supervisorAssigned.length > 0 && (
        <MhSection title="Вам назначил руководитель" first={!showPendingSection}>
          <div className="card-s">
            {supervisorAssigned.slice(0, 3).map((c) => (
              <SupervisorAssignedRow key={c.id} item={c} />
            ))}
          </div>
        </MhSection>
      )}

      <MhSection
        title="Мой фокус"
        // Секция «Ждут вашего принятия» выше не всегда рисуется (полноэкранное
        // окно уже забрало единственного лида) — тогда «Мой фокус» становится
        // первой секцией под шапкой и обязан взять её отступ (макет: 6px, а
        // не стандартные 22px, см. MhSection.first).
        first={!showPendingSection && supervisorAssigned.length === 0}
        note={`обновлено ${dushanbeTime(openedAt)}`}
      >
        {urgentCall ? (
          // Срок первого звонка вытесняет обычную задачу дня из «Мой фокус» —
          // не позвонить вовремя стоит агенту лида, обычная задача подождёт
          // одну строку (см. restCalls/tasks ниже в «Далее по приоритету»).
          <FirstCallFocusCard item={urgentCall} now={callTick} />
        ) : isLoading ? (
          <MhNoData>Загружаем задачи на сегодня…</MhNoData>
        ) : isError ? (
          /* Отказ сводки НЕЛЬЗЯ выдавать за «на сегодня всё сделано». */
          <div className="card-s">
            <MhQuiet tone="crit">
              {error instanceof Error ? error.message : "Сводка не загрузилась, проверьте соединение."}{" "}
              <button type="button" className="btn ghost sm" onClick={() => refetch()}>
                Повторить
              </button>
            </MhQuiet>
          </div>
        ) : focus ? (
          <FocusCard task={focus} />
        ) : (
          <MhNoData tone="ok">Горящего нет. Новые заявки встают сюда сами, сверху.</MhNoData>
        )}
      </MhSection>

      <MhSection title="Далее по приоритету" note="свайп строки">
        {restCalls.length + shownTasks.length === 0 ? (
          <MhNoData tone="ok">Больше дел на сегодня нет.</MhNoData>
        ) : (
          <div className="card-s">
            {/* Остальные непрозвоненные карточки — тем же порядком (по dueAt),
                сразу под самой срочной, что уже заняла «Мой фокус» выше. */}
            {restCalls.map((c) => (
              <CallDueRow key={c.id} item={c} now={callTick} />
            ))}
            {shownTasks.map((task, i) => (
              <TaskSwipeRow key={task.id} task={task} tone={i} />
            ))}
            {overflow > 0 && (
              <button type="button" className="row morerow" onClick={() => navigate("/calendar")}>
                <span className="t">
                  <span className="n">Показать ещё ({overflow}) в календаре</span>
                </span>
              </button>
            )}
          </div>
        )}
      </MhSection>

      <MhSection
        title="Между встречами"
        note={gap ? `с ${dushanbeTime(new Date(gap.from))} до ${dushanbeTime(new Date(gap.to))}` : "когда появится окно"}
      >
        {noContact[0] ? (
          <div className="card-s">
            <p className="hint">
              {clientDisplayName(noContact[0].fullName)} {daysSince(noContact[0].lastContactAt, Date.now())}{" "}
              {pluralizeRu(daysSince(noContact[0].lastContactAt, Date.now()), ["день", "дня", "дней"])} без контакта.
              Короткий звонок сегодня дешевле, чем новый лид завтра.
            </p>
            <div className="chips">
              <CallClientButton
                clientId={noContact[0].id}
                phone={noContact[0].phone}
                variant="full"
                className="btn soft sm"
                label={`Позвонить: ${clientDisplayName(noContact[0].fullName).split(" ")[0]}`}
                stopPropagation={false}
              />
              <button
                type="button"
                className="btn soft sm"
                onClick={() => navigate(`/clients/${noContact[0].shortId}`)}
              >
                <MessageSquare className="i" aria-hidden="true" /> Открыть карточку
              </button>
            </div>
          </div>
        ) : (
          <MhNoData tone="ok">
            Все ваши клиенты на связи: никто не молчит дольше {NO_CONTACT_DAYS} дней.
          </MhNoData>
        )}
      </MhSection>

      <MhSection title="Показы сегодня" note={showings.length}>
        {showings.length === 0 ? (
          <MhNoData>Показов на сегодня нет.</MhNoData>
        ) : (
          <div className="card-s">
            {showings.map((s) => (
              <button
                type="button"
                className="row"
                key={s.id}
                onClick={() =>
                  s.property?.shortId
                    ? navigate(`/properties/${s.property.shortId}`)
                    : s.client?.shortId
                      ? navigate(`/clients/${s.client.shortId}`)
                      : navigate("/calendar")
                }
              >
                <span className="plate lime" aria-hidden="true">
                  <Calendar className="i" />
                </span>
                <span className="t" style={{ textAlign: "left" }}>
                  <span className="n">
                    {dushanbeTime(s.nextActionDate!)}
                    {s.property?.title ? ` · ${s.property.title}` : ""}
                  </span>
                  <span className="s">{s.client?.fullName ?? s.nextAction ?? ""}</span>
                </span>
                <ChevronRight className="i" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </MhSection>

      <MhSection title="Деньги" note={monthName}>
        {data ? (
          <MhMoney
            amount={formatMoney(commission, "TJS")}
            sub={
              plan <= 0
                ? `${ownScope ? "комиссия" : "комиссия агентства"} за месяц · план не задан`
                : ownScope
                  ? // Процент агенту не показываем: в числителе его комиссия, в
                    // знаменателе план ВСЕГО агентства — полоса не заполнится
                    // в принципе (то же правило, что на ПК).
                    `комиссия за месяц · вклад в общий план ${formatMoney(plan, "TJS")}`
                  : `комиссия агентства · план ${formatMoney(plan, "TJS")} · ${pct} %`
            }
            percent={plan > 0 && !ownScope ? pct : null}
          />
        ) : (
          <MhNoData>Нет данных: сводка по деньгам не загрузилась.</MhNoData>
        )}
      </MhSection>
    </MhScreen>
  );
}

// ─── Ждут вашего принятия ────────────────────────────────────────────────────

/**
 * Секция «Ждут вашего принятия» с обратным отсчётом.
 *
 * ЧТО ИМЕННО ОТСЧИТЫВАЕТ ТАЙМЕР. В артефакте это просто цифра, у нас — срок,
 * после которого сервер переназначит заявку другому агенту
 * (Настройки → `leadAcceptMinutes`, services/leads/reassignment.ts). Пока
 * настройки не приехали, вместо отсчёта показывается, сколько заявка уже
 * ждёт: подставлять «15 минут по умолчанию» нельзя — у компании может стоять
 * другое число, и агент увидел бы неверный срок.
 */
function PendingSection({
  pending,
  offerItems,
  reviewItems,
  pendingTotal,
  leadAcceptMinutes,
}: {
  /** Уже без лида, занятого полноэкранным окном — см. `visiblePending` в
   *  MobileAgentHome и lib/incomingLeadBus.ts. */
  pending: Client[];
  offerItems: ReactivationOffer[];
  reviewItems: DuplicateReviewItem[];
  /** Честный счёт ждущих (`data.total` с сервера, за вычетом лида в
   *  полноэкранном окне) — может быть больше, чем `pending.length`, если
   *  ждущих больше предела запроса виджета (20). */
  pendingTotal: number;
  leadAcceptMinutes: number | null;
}) {
  const navigate = useNavigate();
  const total = pendingTotal + offerItems.length + reviewItems.length;
  // Сколько ждущих карточек не поместилось на экран виджета — те, что сервер
  // честно посчитал, но не прислал в пределах pageSize=20.
  const hiddenPending = Math.max(0, pendingTotal - pending.length);
  // Один интервал на всю секцию, и только пока есть что отсчитывать.
  const now = useSecondTick(pending.length > 0 && leadAcceptMinutes !== null);

  // Родитель уже решил, показывать ли секцию вообще (showPendingSection) —
  // здесь запасной выход на случай рассинхрона пропсов, а не основная ветка.
  if (total === 0) return null;

  return (
    <MhSection title="Ждут вашего принятия" note={`${total} · таймер идёт`} first>
      <div className="card-s">
        {pending.map((c, i) => (
          <PendingRow key={c.id} client={c} tone={i} now={now} leadAcceptMinutes={leadAcceptMinutes} />
        ))}
        {offerItems.map((o) => (
          <ReactivationRow key={o.id} offer={o} />
        ))}
        {reviewItems.map((r) => (
          <DuplicateRow key={r.id} review={r} />
        ))}
        {hiddenPending > 0 && (
          <button type="button" className="row morerow" onClick={() => navigate("/clients")}>
            <span className="t">
              <span className="n">Показать ещё ({hiddenPending}) в клиентах</span>
            </span>
          </button>
        )}
      </div>
    </MhSection>
  );
}

/** Чем заявка интересна: канал и что человек ищет — вторая строка артефакта. */
function leadHint(c: Client): string {
  const parts = [CLIENT_SOURCE_LABELS[c.source]];
  if (c.desiredRooms) parts.push(`${c.desiredRooms}-комн`);
  if (c.desiredDistrict?.name) parts.push(c.desiredDistrict.name);
  return parts.filter(Boolean).join(" · ");
}

function PendingRow({
  client: c,
  tone,
  now,
  leadAcceptMinutes,
}: {
  client: Client;
  tone: number;
  now: number;
  leadAcceptMinutes: number | null;
}) {
  const navigate = useNavigate();
  const acceptLead = useAcceptLead(c.id);
  const escalated = !c.acceptedAt && !!c.escalatedAt;
  const left = leadAcceptMinutes !== null ? Date.parse(c.assignedAt) + leadAcceptMinutes * 60_000 - now : null;
  const expired = left !== null && left <= 0;

  return (
    <>
    <div className="row">
      <span className="av" style={AVATAR_TONES[tone % AVATAR_TONES.length]} aria-hidden="true">
        {c.fullName?.[0]?.toUpperCase() ?? "?"}
      </span>
      <button
        type="button"
        className="t"
        style={{ textAlign: "left" }}
        onClick={() => navigate(`/clients/${c.shortId}`)}
      >
        <span className="n">{c.fullName}</span>
        <span className={expired || escalated ? "s crit" : "s warn"}>
          {left === null ? (
            `ждёт ${relativeTime(c.assignedAt)}`
          ) : expired ? (
            "время вышло, примите сейчас"
          ) : (
            <span className="timer">{mmss(left)}</span>
          )}
          {escalated ? " · никто не принял" : ` · ${leadHint(c)}`}
        </span>
        {/* «Почему лид ваш» — та же строка сервера, что в окне приёма и на ПК. */}
        {c.leadReason && <span className="s">{c.leadReason.text}</span>}
      </button>
      <button
        type="button"
        className="btn pill sm"
        data-endpoint="POST /api/v1/clients/:id/accept"
        disabled={acceptLead.isPending}
        onClick={(e) => {
          e.stopPropagation();
          acceptLead.mutate(undefined, {
            onError: (err) => {
              if (isRequiresRelease(err)) navigate(`/clients/${c.shortId}`);
            },
          });
        }}
      >
        {acceptLead.isPending ? "Принятие…" : "Принять"}
      </button>
    </div>
    {acceptLead.isError && (
      <div style={{ padding: "0 14px 12px" }}>
        <MutationError mutation={acceptLead} fallback="Не удалось принять лид" variant="rh2" />
      </div>
    )}
    </>
  );
}

/** Прежний клиент написал снова — вернуть карточку себе (разбор 31.08.2026, п.12). */
function ReactivationRow({ offer: o }: { offer: ReactivationOffer }) {
  const navigate = useNavigate();
  const accept = useAcceptReactivationOffer(o.id);
  const decline = useDeclineReactivationOffer(o.id);
  const busy = accept.isPending || decline.isPending;
  return (
    <div className="row">
      <span className="av aqua" aria-hidden="true">
        {o.fullName?.[0]?.toUpperCase() ?? "?"}
      </span>
      <button
        type="button"
        className="t"
        style={{ textAlign: "left" }}
        onClick={() => navigate(`/clients/${o.shortId}`)}
      >
        <span className="n">{o.fullName}</span>
        <span className="s">написал снова, вернуть карточку себе?</span>
      </button>
      <button
        type="button"
        className="btn pill sm"
        data-endpoint="POST /api/v1/clients/reactivation-offers/:id/accept"
        disabled={busy}
        onClick={() => accept.mutate()}
      >
        {accept.isPending ? "Принятие…" : "Принять"}
      </button>
      <button
        type="button"
        className="btn ghost sm"
        data-endpoint="POST /api/v1/clients/reactivation-offers/:id/decline"
        disabled={busy}
        onClick={() => decline.mutate()}
      >
        {decline.isPending ? "…" : "Отклонить"}
      </button>
    </div>
  );
}

/** «Это ваш клиент?» — пока не ответят, похожая заявка не раздаётся никому. */
function DuplicateRow({ review: r }: { review: DuplicateReviewItem }) {
  const navigate = useNavigate();
  const confirm = useConfirmDuplicateReview(r.id);
  const deny = useDenyDuplicateReview(r.id);
  const busy = confirm.isPending || deny.isPending;
  return (
    <div className="row">
      <span className="av pink" aria-hidden="true">
        {r.fullName?.[0]?.toUpperCase() ?? "?"}
      </span>
      <button
        type="button"
        className="t"
        style={{ textAlign: "left" }}
        onClick={() => r.duplicateReviewOfClient && navigate(`/clients/${r.duplicateReviewOfClient.shortId}`)}
      >
        <span className="n">{r.fullName}</span>
        <span className="s warn">похоже на «{r.duplicateReviewOfClient?.fullName ?? "?"}» — тот же человек?</span>
      </button>
      <button
        type="button"
        className="btn pill sm"
        data-endpoint="POST /api/v1/clients/duplicate-reviews/:id/confirm"
        disabled={busy}
        onClick={() => confirm.mutate()}
      >
        {confirm.isPending ? "…" : "Да, мой"}
      </button>
      <button
        type="button"
        className="btn ghost sm"
        data-endpoint="POST /api/v1/clients/duplicate-reviews/:id/deny"
        disabled={busy}
        onClick={() => deny.mutate()}
      >
        {deny.isPending ? "…" : "Другой"}
      </button>
    </div>
  );
}

// ─── Мой фокус ───────────────────────────────────────────────────────────────

/**
 * Срок первого звонка (задание 17.09.2026) — та же карточка `.focus`, что и
 * FocusCard ниже, но с текстом и отсчётом про сам звонок, а не про задачу дня.
 * Кнопка — тот же CallClientButton/useCallClient, что и «Позвонить» на
 * карточке клиента (pages/ClientDetail.tsx) — второй копии вызова нет.
 */
function FirstCallFocusCard({ item, now }: { item: FirstCallDueItem; now: number }) {
  const navigate = useNavigate();
  const left = Date.parse(item.dueAt) - now;
  const expired = left <= 0;
  const canCall = !!item.phone;
  return (
    <div className="card-s big focus">
      <div className="eyebrow">Сначала сделайте это</div>
      <div className="who">
        <span className="av pink" style={{ width: 48, height: 48, fontSize: 19 }} aria-hidden="true">
          {item.fullName?.[0]?.toUpperCase() ?? "?"}
        </span>
        <div>
          <div className="n">Позвонить {item.fullName}</div>
          <div className={expired ? "s crit" : "s warn"}>
            {expired ? (
              "срок вышел, звоните сейчас"
            ) : (
              <>
                осталось <span className="timer">{mmss(left)}</span> · иначе минус к Royal Score
              </>
            )}
          </div>
        </div>
      </div>
      <div className="acts">
        {canCall && (
          <CallClientButton
            clientId={item.id}
            phone={item.phone}
            variant="full"
            className="btn pill"
            label="Позвонить"
            stopPropagation={false}
          />
        )}
        <button type="button" className="btn soft" onClick={() => navigate(`/clients/${item.shortId}`)}>
          <MessageSquare className="i" aria-hidden="true" /> Открыть карточку
        </button>
      </div>
    </div>
  );
}

/** Карточка `.focus` артефакта: кто, почему сейчас и две кнопки действия. */
function FocusCard({ task }: { task: Interaction }) {
  const navigate = useNavigate();
  const client = task.client;
  const canCall = !!client?.id && !!client.phone;
  return (
    <div className="card-s big focus">
      <div className="eyebrow">Сначала сделайте это</div>
      <div className="who">
        <span
          className="av pink"
          style={{ width: 48, height: 48, fontSize: 19 }}
          aria-hidden="true"
        >
          {client?.fullName?.[0]?.toUpperCase() ?? "?"}
        </span>
        <div>
          <div className="n">{client?.fullName ?? "Клиент"}</div>
          <div className="s">{task.property?.title ?? task.nextAction ?? "Ждёт ответа"}</div>
        </div>
        {client?.status === "HOT" && (
          <span className="chip crit" style={{ marginLeft: "auto" }}>
            горячий
          </span>
        )}
      </div>
      <p className="why">{focusReason(task)}</p>
      <div className="acts">
        {canCall && (
          <CallClientButton
            clientId={client!.id}
            phone={client!.phone ?? ""}
            variant="full"
            className="btn pill"
            label="Позвонить"
            stopPropagation={false}
          />
        )}
        {client?.shortId != null && (
          <button
            type="button"
            className="btn soft"
            data-endpoint="GET /api/v1/clients"
            onClick={() => navigate(`/clients/${client.shortId}`)}
          >
            <MessageSquare className="i" aria-hidden="true" /> Написать
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Далее по приоритету ─────────────────────────────────────────────────────

/** Непрозвоненная карточка ниже самой срочной (та уже заняла «Мой фокус»
 *  выше) — тот же отсчёт и та же кнопка звонка, компактной строкой. */
type SupervisorAssignedItem = NonNullable<DashboardSummary["assignedBySupervisor"]>[number];

/** Клиент, которого назначил руководитель: принят сразу, ждёт звонка агента. */
function SupervisorAssignedRow({ item }: { item: SupervisorAssignedItem }) {
  const navigate = useNavigate();
  const canCall = !!item.phone; // маска номера звонку не мешает — номер берёт сервер (аудит №54)
  return (
    <div className="row">
      <span className="av" aria-hidden="true">
        {item.fullName?.[0]?.toUpperCase() ?? "?"}
      </span>
      <button type="button" className="t" style={{ textAlign: "left" }} onClick={() => navigate(`/clients/${item.shortId}`)}>
        <span className="n">{item.fullName}</span>
        <span className="s">{item.byName ? `назначил(а) ${item.byName}` : "назначил руководитель"} · позвоните клиенту</span>
      </button>
      {canCall && <CallClientButton clientId={item.id} phone={item.phone} variant="icon" className="ico" title="Позвонить через CRM" />}
    </div>
  );
}

function CallDueRow({ item, now }: { item: FirstCallDueItem; now: number }) {
  const navigate = useNavigate();
  const left = Date.parse(item.dueAt) - now;
  const expired = left <= 0;
  const canCall = !!item.phone;
  return (
    <div className="row">
      <span className="av pink" aria-hidden="true">
        {item.fullName?.[0]?.toUpperCase() ?? "?"}
      </span>
      <button type="button" className="t" style={{ textAlign: "left" }} onClick={() => navigate(`/clients/${item.shortId}`)}>
        <span className="n">{item.fullName}</span>
        <span className={expired ? "s crit" : "s warn"}>
          {expired ? "срок вышел, звоните сейчас" : <>осталось <span className="timer">{mmss(left)}</span></>}
        </span>
      </button>
      {canCall && <CallClientButton clientId={item.id} phone={item.phone} variant="icon" className="ico" title="Позвонить через CRM" />}
    </div>
  );
}

/**
 * Строка задачи со смахиванием — `swipeRow(item,'task')` артефакта.
 *
 * Жест не звонит сам: он нажимает настоящую CallClientButton внутри строки,
 * поэтому правило «сначала через CRM» остаётся в одном месте (тот же приём,
 * что в списке клиентов и на ПК-Главной).
 */
function TaskSwipeRow({ task, tone }: { task: Interaction; tone: number }) {
  const navigate = useNavigate();
  const rowRef = useRef<HTMLDivElement>(null);
  const client = task.client;
  const canCall = !!client?.id && !!client.phone;
  const open = client?.shortId != null ? () => navigate(`/clients/${client.shortId}`) : () => {};
  return (
    <SwipeRow
      onOpen={open}
      onCall={canCall ? () => rowRef.current?.querySelector<HTMLButtonElement>("[data-call-button]")?.click() : null}
    >
      <div className="row" ref={rowRef}>
        <span className="av" style={AVATAR_TONES[tone % AVATAR_TONES.length]} aria-hidden="true">
          {(client?.fullName ?? task.nextAction ?? "?")[0]?.toUpperCase()}
        </span>
        <button type="button" className="t" style={{ textAlign: "left" }} onClick={open}>
          <span className="n">{task.property?.title ?? task.nextAction ?? "Задача"}</span>
          <span className="s">
            {client?.fullName ?? "Клиент"}
            {task.nextActionDate ? ` · к ${dushanbeTime(task.nextActionDate)}` : ""}
          </span>
        </button>
        {client?.id && (
          <CallClientButton
            clientId={client.id}
            phone={client.phone ?? ""}
            variant="icon"
            className="ico"
            title="Позвонить через CRM"
          />
        )}
      </div>
    </SwipeRow>
  );
}
