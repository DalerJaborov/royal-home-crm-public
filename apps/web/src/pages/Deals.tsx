import { useCan, useIsReadOnly } from "../lib/permissions";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DndContext, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, Send } from "lucide-react";
import type { DealStage } from "@royal-home/shared";
import { useAnnulDeal, useDeals, useUpdateDeal } from "../hooks/useDeals";
import { useAgents } from "../hooks/useAgents";
import { useAuthStore } from "../store/auth";
import { daysSince, formatMoney, toTjs } from "../lib/format";
import { draggableGroupProps } from "../lib/a11y";
import { dushanbeDayKey, dushanbeFirstDayOfMonthKey } from "../lib/date";
import { useUsdToTjsRate } from "../hooks/useSettings";
import { usePaged } from "../hooks/usePaged";
import { useMobileUx } from "../hooks/useMobileUx";
import { useCleanShell } from "../hooks/useCleanShell";
import { CleanDealsApprovalRows, CleanDealsGuide, CleanDealsHeader, CleanDealsSummary } from "../components/clean/CleanDealsOverview";
import { cleanClientDetailScale } from "../components/clean/CleanClientDetailLayout";
import { useSyncFiltersToUrl } from "../hooks/useUrlFilters";
import { MobileDeals } from "../components/mobile/MobileDeals";
import { useMarkSectionSeen } from "../hooks/useCounters";
// ConfirmDialog здесь больше не нужен напрямую: подтверждение отмены/одобрения
// сделки стало общим компонентом DealStageConfirm (его же рисует мобильная доска).
import { DealStageConfirm } from "../components/DealStageConfirm";
import { DealSubmitModal } from "../components/DealSubmitModal";
import { DealRejectDialog } from "../components/DealRejectDialog";
import { DealAnnulDialog } from "../components/DealAnnulDialog";
import { DealDocumentsModal } from "../components/DealDocumentsModal";
import { showsArchivePayoutButton } from "../lib/dealArchivePayout";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { NewDealSheet } from "../components/NewDealSheet";
import type { Deal } from "../types";
import { dealSubmitCurrencyProps } from "../lib/dealSubmitCurrency";

// Только стадии активного пайплайна — сделка сюда попадает и уходит быстро, поэтому
// доска не растёт бесконечно. Завершённые и отменённые сделки копятся годами, для них —
// отдельные архивные секции с пагинацией ниже.
const BOARD_STAGES: { key: DealStage; label: string }[] = [
  { key: "NEGOTIATION", label: "Переговоры" },
  { key: "AGREEMENT_PENDING", label: "Согласование" },
  { key: "CONTRACT_SIGNED", label: "Договор подписан" },
];

/**
 * Текст пустой стадии — ОДНА КОРОТКАЯ СТРОКА (21.09.2026).
 *
 * Было по целому предложению на каждую стадию: «Сюда сделка попадает, когда с
 * клиентом договорились о конкретном объекте» и так далее. На телефоне три
 * пустые стадии подряд превращали экран в инструкцию, а не в доску — владелец:
 * «разделки сделки работают нервно и выглядят неправильно, экран мне не
 * нравится». Название стадии уже стоит заголовком над карточкой; второй раз
 * объяснять его словами не нужно.
 *
 * Строка остаётся (а не пропадает вовсе), чтобы пустая стадия читалась как
 * пустая, а не как не догрузившаяся, и чтобы зона для перетаскивания сохраняла
 * высоту: без неё карточку некуда было бы отпустить.
 */
const EMPTY_STAGE_HINT: Record<DealStage, string> = {
  NEGOTIATION: "Пока пусто",
  AGREEMENT_PENDING: "Пока пусто",
  CONTRACT_SIGNED: "Пока пусто",
  PENDING_APPROVAL: "Пока пусто",
  COMPLETED: "Пока пусто",
  CANCELLED: "Пока пусто",
};

// daysSince и usePaged переехали в lib/format.ts и hooks/usePaged.ts: мобильная
// доска (components/mobile/MobileDeals.tsx) считает возраст сделки и листает
// колонки той же парой функций — копии в двух файлах разошлись бы.

/** Потолок архива сделок в ответе GET /deals (routes/deals.ts). */
const ARCHIVE_LIMIT = 500;

export function Deals() {
  const role = useAuthStore((s) => s.agent?.role);
  const myId = useAuthStore((s) => s.agent?.id);
  const can = useCan();
  const readOnly = useIsReadOnly();
  const mobile = useMobileUx();
  const clean = useCleanShell();
  const [mobileStage, setMobileStage] = useState<DealStage | "APPROVAL">("NEGOTIATION");
  const navigate = useNavigate();
  const teamWide = can("deals.viewAll");
  // «Видеть все сделки» — не «двигать все сделки» (глубокая проверка 02.10.2026,
  // A3). Служба безопасности видит доску целиком, но ничего не меняет: сервер
  // отвечает 403 на запись в чужую сделку тому, у кого нет ни deals.complete, ни
  // clients.assign (foreignDealWriteDenied в apps/api/src/auth/middleware.ts).
  // Здесь то же правило, чтобы доска не предлагала перетаскивание, которое
  // откатится отказом.
  const writesForeign = !readOnly && (!teamWide || can("deals.complete") || can("clients.assign"));
  const canWriteDeal = (d: Deal) => !readOnly && (writesForeign || d.agentId === myId);
  // Фильтр по агенту — единственный честный из шторки макета «Фильтры»: сервер
  // умеет agentId и stage, но стадии на доске и так видны все разом колонками —
  // фильтр «одна стадия» свёл бы канбан к одному списку, а не сузил его.
  // «Срок» (просрочено/на неделе) в шаблоне тоже не переносим: у сделки есть
  // только возраст с момента начала, отдельного срока/дедлайна нет.
  const [searchParams, setSearchParams] = useSearchParams();
  // Плитка «сделок закрыто» на карточке сотрудника ведёт сюда с ?agentId=,
  // чтобы открыть доску сразу отфильтрованной на этого агента (владелец: один
  // клик от красного числа до виновника/карточки).
  const [filterAgentId, setFilterAgentId] = useState(() => searchParams.get("agentId") ?? "");
  const [showFilters, setShowFilters] = useState(false);
  const [showNewDeal, setShowNewDeal] = useState(false);
  const { data: deals, isLoading, error, refetch } = useDeals(filterAgentId ? { agentId: filterAgentId } : {});
  useSyncFiltersToUrl(searchParams, setSearchParams, { agentId: filterAgentId || undefined });
  const { data: agentsList } = useAgents({ enabled: teamWide });
  const updateDeal = useUpdateDeal();
  // Promise — чтобы окно «на закрытие» ждало ответа и не теряло суммы при отказе
  // (аудит 23.09.2026, №58). Пустой catch только помечает отказ обработанным для
  // тех, кто промис не ждёт (стрелки, перетаскивание): там отказ показывает
  // сам useUpdateDeal, откатывая карточку.
  const moveStage = (id: string, stage: DealStage, extra?: Record<string, unknown>) => {
    const done = updateDeal.mutateAsync({ id, body: { stage, ...extra } });
    done.catch(() => {});
    return done;
  };
  // Открытие раздела гасит красный счётчик в сайдбаре (у текущего агента).
  useMarkSectionSeen("deals");
  const [completedOpen, setCompletedOpen] = useState(false);
  const [cancelledOpen, setCancelledOpen] = useState(false);
  // «Отметить выплаченной» из архива «Завершённые» (ночная проверка 24.09.2026,
  // находка №206): DealDocumentsModal раньше открывался только из карточек трёх
  // стадий доски — из архивной строки и с телефона (тот же общий `archive` ниже)
  // до неё было не добраться никак. id сделки, чьё окно документов открыто из
  // архивной строки — не булев флаг, потому что строк много и окно у них одно на всех.
  const [archiveDocsDealId, setArchiveDocsDealId] = useState<string | null>(null);
  // Директор правит цифры уже отправленной на закрытие сделки на месте (19.08.2026,
  // просьба владельца) — не обязан гонять её через «на доработку» агенту и обратно.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  // «Аннулировать» закрытую сделку (C10, 02.10.2026) — из архива «Завершённые»,
  // общего для телефона и компьютера.
  const [annullingId, setAnnullingId] = useState<string | null>(null);
  const annulDeal = useAnnulDeal();
  const usdToTjs = useUsdToTjsRate();
  /**
   * Мышь и палец — разные сенсоры, и это не придирка.
   *
   * Один PointerSensor с `distance: 5` начинал перетаскивание, как только палец
   * сдвинулся на пять точек В ЛЮБУЮ сторону. На телефоне доска складывается в
   * стопку списков, и любая попытка ПРОЛИСТАТЬ её вниз читалась как «тащу
   * сделку»: страница не двигалась, а карточка уезжала за пальцем.
   *
   * Мышь — как было (сдвиг на 5 точек). Палец — долгое нажатие 200 мс с допуском
   * 8 точек: пролистывание уходит странице, перетаскивание начинается только
   * после осознанного удержания.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const board = (deals ?? []).filter((d) => d.stage !== "CANCELLED" && d.stage !== "COMPLETED" && d.stage !== "PENDING_APPROVAL");
  // «Ждут одобрения» — сделки, которые агент уже отправил на закрытие (указал
  // цену и комиссию суммой), но директор ещё не решил. Отдельный список, а не
  // колонка доски: доска — только активный пайплайн переговоров, а это уже
  // финальное решение руководителя, свежее сверху.
  const pendingApproval = useMemo(
    () => (deals ?? []).filter((d) => d.stage === "PENDING_APPROVAL").sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [deals]
  );
  const completed = useMemo(
    () =>
      (deals ?? [])
        .filter((d) => d.stage === "COMPLETED")
        .sort((a, b) => new Date(b.closedAt ?? b.startedAt).getTime() - new Date(a.closedAt ?? a.startedAt).getTime()),
    [deals]
  );
  const cancelled = useMemo(
    () =>
      (deals ?? [])
        .filter((d) => d.stage === "CANCELLED")
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [deals]
  );
  // Итог по разным валютам сводится к сомони: доски и архив содержат сделки и в
  // долларах (валюта объекта), их нельзя складывать с сомони как есть.
  const totalCommission = useMemo(
    () => completed.reduce((sum, d) => sum + toTjs(d.commissionAmount, d.currency, usdToTjs), 0),
    [completed, usdToTjs]
  );

  // Архив (закрытые + отменённые) сервер отдаёт не больше ARCHIVE_LIMIT строк
  // (routes/deals.ts, take: 500). Упёрлись в потолок — итог комиссий уже не «всего»,
  // и подпись говорит это прямо, а не занижает сумму молча (C16, 02.10.2026).
  const archiveTruncated = completed.length + cancelled.length >= ARCHIVE_LIMIT;

  const completedPage = usePaged(completed);
  const cancelledPage = usePaged(cancelled);

  /**
   * Блок «Месяц» шаблона — честная версия без выдуманного плана. В CRM нет
   * понятия «план на месяц» ни в одной таблице (проверено по всему репозиторию),
   * поэтому шкалу прогресса `.prog` не рисуем — заполнить её было бы нечем, а
   * рисовать пустую полосу нечестно. Показываем то, что есть по-настоящему:
   * сколько сделок закрыто в текущем месяце по Душанбе и на какую сумму.
   */
  const monthKey = dushanbeFirstDayOfMonthKey().slice(0, 7);
  const closedThisMonth = useMemo(
    () => completed.filter((d) => d.closedAt && dushanbeDayKey(d.closedAt).slice(0, 7) === monthKey),
    [completed, monthKey]
  );
  const closedThisMonthSum = useMemo(
    () => closedThisMonth.reduce((sum, d) => sum + toTjs(d.commissionAmount, d.currency, usdToTjs), 0),
    [closedThisMonth, usdToTjs]
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active: activeItem, over } = event;
    if (!over) return;
    const dealId = String(activeItem.id);
    const newStage = String(over.id) as DealStage;
    const deal = deals?.find((d) => d.id === dealId);
    if (!deal || deal.stage === newStage || !canWriteDeal(deal)) return;
    updateDeal.mutate({ id: dealId, body: { stage: newStage } });
  }

  const openClient = (id: string) => navigate(`/clients/${deals?.find((d) => d.id === id)?.client.shortId}`);

  // Сделки — не работа маркетинга и монтажёра (см. разбор ролей в Sidebar.tsx):
  // у них нет ни своих сделок, ни права deals.viewAll. Самозащита страницы — на
  // случай прямого перехода по URL, а не только скрытой ссылки в меню.
  if (role === "MARKETING" || role === "EDITOR") {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Сделки</h1>
              <p className="sub">Раздел недоступен этой роли.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const canComplete = !readOnly && can("deals.complete");
  // Кнопка «Выплачено» (Пачка 14, 11.09.2026) — то же право, что сервер проверяет
  // в routes/dealPayout.ts (finance.manage ИЛИ deals.setCommission). Вынесено в
  // lib/dealArchivePayout.ts (ночная проверка 24.09.2026, №206) — то же правило
  // теперь решает и видимость кнопки «Документы» в архивной строке ниже.
  const canPayout = showsArchivePayoutButton({
    financeManage: !readOnly && can("finance.manage"),
    dealsSetCommission: !readOnly && can("deals.setCommission"),
  });
  /**
   * ПРАВО СТАВИТЬ СУММУ КОМИССИИ — ОТДЕЛЬНО ОТ ПРАВА ЗАКРЫВАТЬ СДЕЛКУ (24.09.2026,
   * последняя доводка ночной проверки №159/М4). У менеджера есть deals.complete
   * («Одобрить» уже отправленную сделку — числа берутся из снапшота, новых сумм
   * он не вводит), но нет deals.setCommission — а кнопка «Изменить» в «Решить
   * сейчас» и кнопка «Закрыть сделку»/«Отправить на закрытие» в карточке (когда
   * canComplete открывал режим mode="complete" с вводом сумм) вели прямиком в
   * форму с деньгами и заканчивались 403 сервера: тупик, показанный как рабочая
   * кнопка. Обе гейтятся этим правом, а не canComplete.
   */
  const canSetCommission = !readOnly && can("deals.setCommission");
  // Деньги сделки — по finance.view, тем же приёмом, что в Reports.tsx/Sources.tsx
  // (ночная проверка 24.09.2026, №159/М4). Сервер уже отдаёт commissionAmount/
  // soldPrice как undefined тому, кому их не видно (routes/deals.ts) — здесь это
  // не путать с «денег нет»: подписи «не указана»/«без комиссии» и суммы «0»
  // подряд считались бы ложью на экране, поэтому денежный текст целиком скрыт.
  const seesMoney = can("finance.view");
  const editingDeal = canSetCommission ? pendingApproval.find((d) => d.id === editingId) ?? null : null;

  // Баннеры и архив собраны ОДИН раз на оба облика: тексты ошибок и правила
  // пагинации истории обязаны совпадать на телефоне и на десктопе. Разметка —
  // «тихие строки» эталона (screens/deals.html, блок «Состояния доски»):
  // .state со скелетоном, .state.err с точкой crit, .quiet.crit у отказа сервера.
  const banners = (
    <>
      {isLoading && !error && (
        <div className="card tight">
          <div className="state">
            <span className="sk w28" />
            <span className="sk w22" /> Загружаем сделки
          </div>
        </div>
      )}
      {/* Единое состояние ошибки вместо голого текста (приёмка 08.09, Q2 B-3). */}
      {error && (
        <div className="card tight">
          <div className="state err">
            <span className="dot crit" /> Доска не загрузилась.{" "}
            <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => refetch()}>
              Повторить
            </button>
          </div>
        </div>
      )}
      {/* Смена этапа откатывалась молча: сервер отвечает 409 («объект уже продан»,
          «завершённую нельзя вернуть») или 403 («закрыть может руководитель»), карточка
          прыгала обратно, и пользователь считал, что кнопка сломана. */}
      {updateDeal.isError && (
        <div className="card tight">
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">
              {updateDeal.error instanceof Error ? updateDeal.error.message : "Не удалось изменить этап сделки"}
            </span>
            <button className="lnk" type="button" onClick={() => updateDeal.reset()}>
              Понятно
            </button>
          </div>
        </div>
      )}
    </>
  );

  // «Решить сейчас» — полоса решений одной кнопкой прямо в строке (эталон
  // screens/deals.html). Те же три действия, что были: одобрить, поправить
  // цифры на месте, вернуть агенту на доработку.
  const solve = pendingApproval.length > 0 && (
    <div className="card tight" style={clean ? { border: 0, padding: 20 } : undefined}>
      <div className="sec-h">
        <h2>{clean ? "На согласовании" : "Решить сейчас"}</h2>
        <span className="note">
          {pendingApproval.length} на решении, {daysSince(pendingApproval[pendingApproval.length - 1].startedAt)} дн у самой старой
        </span>
      </div>
      <CleanDealsApprovalRows enabled={clean}>{pendingApproval.map((d) => (
        <div className="solve" key={d.id} style={clean ? { display: "flex", flexWrap: "wrap", gap: 12, border: 0, padding: "14px 0" } : undefined}>
          <span className="t" style={clean ? { minWidth: 0, flex: "1 1 280px", fontSize: 16, lineHeight: 1.6, overflowWrap: "anywhere" } : undefined}>
            <button className="lk" type="button" onClick={() => openClient(d.id)}>
              {d.client.fullName}
            </button>
            ,{" "}
            <button className="lk mut" type="button" onClick={() => openClient(d.id)}>
              {d.property.title}
            </button>
            {/* Одобряющий видит суммы ЭТОЙ сделки и без права на финансы (C15, решение
                владельца 02.10): «Одобрить» — денежное событие, вслепую его не нажимают.
                Сервер отдаёт суммы сделки «Ждёт одобрения» тому, кто вправе её одобрить. */}
            {seesMoney || canComplete ? (
              <>
                . Цена <b>{d.soldPrice ? formatMoney(d.soldPrice, d.currency) : "не указана"}</b>, комиссия{" "}
                <b>{d.commissionAmount ? formatMoney(d.commissionAmount, d.currency) : "не указана"}</b>.
              </>
            ) : (
              "."
            )}
          </span>
          <span className="acts" style={clean ? { flexWrap: "wrap", gap: 12 } : undefined}>
            {canComplete ? (
              <>
                <button className="pill sm" type="button" onClick={() => updateDeal.mutate({ id: d.id, body: { stage: "COMPLETED" } })}>
                  Одобрить
                </button>
                {/* «Изменить» ведёт в форму с суммами (PATCH commissionRealtorAmount/
                    commissionCompanyAmount на уже отправленной сделке) — тому, у кого
                    нет deals.setCommission, сервер ответит 403. Кнопка без прав вела
                    бы в тупик, поэтому её не видно вовсе, а не «показана и падает». */}
                {canSetCommission && (
                  <button className="lnk" type="button" title="Поправить цифры, не отправляя на доработку" onClick={() => setEditingId(d.id)}>
                    Изменить
                  </button>
                )}
                <button className="lnk" type="button" title="Отправить на доработку" onClick={() => setRejectingId(d.id)}>
                  Вернуть
                </button>
              </>
            ) : (
              <span className="chip mute">ждёт руководителя</span>
            )}
          </span>
        </div>
      ))}</CleanDealsApprovalRows>
      {editingDeal && (
        <DealSubmitModal
          listedPrice={editingDeal.property.price}
          currency={editingDeal.currency}
          mode="review"
          initial={{
            soldPrice: editingDeal.soldPrice,
            commissionRealtorAmount: editingDeal.commissionRealtorAmount,
            commissionCompanyAmount: editingDeal.commissionCompanyAmount,
          }}
          onSubmit={async (data) => {
            await updateDeal.mutateAsync({ id: editingDeal.id, body: data });
            setEditingId(null);
          }}
          onCancel={() => setEditingId(null)}
        />
      )}
      {rejectingId && canComplete && (
        <DealRejectDialog
          onConfirm={(body) => {
            updateDeal.mutate({ id: rejectingId, body });
            setRejectingId(null);
          }}
          onCancel={() => setRejectingId(null)}
        />
      )}
    </div>
  );

  const archive = (
    <>
      {completed.length > 0 && (
        <div className="card tight">
          <div className="sec-h">
            <h2>Завершённые сделки</h2>
            <span className="note">
              {completed.length}
              {seesMoney && (
                <>
                  , {archiveTruncated ? "комиссии по последним сделкам" : "комиссии всего"}{" "}
                  <span className="money">{formatMoney(totalCommission, "TJS")}</span>
                </>
              )}
            </span>
          </div>
          <div className="wrap">
            <button className="pill ghost sm" type="button" onClick={() => setCompletedOpen((v) => !v)} aria-expanded={completedOpen}>
              {completedOpen ? "Свернуть" : "Показать"}
            </button>
          </div>
          {completedOpen && (
            <div className="list" style={{ marginTop: "var(--s3)" }}>
              {completedPage.visible.map((d) => (
                <div className="row" key={d.id}>
                  <div className="t">
                    <b>
                      <button className="lk" type="button" onClick={() => openClient(d.id)}>
                        {d.client.fullName}
                      </button>
                    </b>
                    <span>{d.property.title}</span>
                  </div>
                  {/* Отказной лид: агентская часть комиссии делится 70/30, а не поровну —
                      это надо видеть в списке выплат, а не только в снапшоте сделки. */}
                  {d.refusedLeadSplit && (
                    <span className="chip mute" title="Отказной лид: 70% продавшему, 30% приведшему объект">
                      70/30
                    </span>
                  )}
                  <span className="meta">{formatMoney(d.property.price, d.property.currency)}</span>
                  {d.commissionAmount ? <span className="chip ok">+{formatMoney(d.commissionAmount, d.currency)}</span> : null}
                  {/* «Отметить выплаченной» — то же окно, что у карточек доски, тем же
                      правом, что проверяет сервер (routes/dealPayout.ts). Без этой
                      кнопки окно документов завершённой сделки было не открыть вовсе. */}
                  {canPayout && (
                    <button className="pill ghost sm" type="button" onClick={() => setArchiveDocsDealId(d.id)}>
                      Документы
                    </button>
                  )}
                  {/* Аннулировать — тем же правом, что одобряет закрытие (сервер:
                      routes/dealAnnul.ts, deals.complete). */}
                  {canComplete && (
                    <button
                      className="lnk"
                      type="button"
                      title="Сделка перестанет считаться продажей, объект вернётся в продажу"
                      onClick={() => {
                        annulDeal.reset();
                        setAnnullingId(d.id);
                      }}
                    >
                      Аннулировать
                    </button>
                  )}
                </div>
              ))}
              {completedPage.hasMore && (
                <p className="state">
                  и ещё {completed.length - completedPage.visible.length}.{" "}
                  <button className="lk" type="button" onClick={completedPage.showMore}>
                    Показать
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {cancelled.length > 0 && (
        <div className="card tight">
          <div className="sec-h">
            <h2>Отменённые сделки</h2>
            <span className="note">{cancelled.length}</span>
          </div>
          <div className="wrap">
            <button className="pill ghost sm" type="button" onClick={() => setCancelledOpen((v) => !v)} aria-expanded={cancelledOpen}>
              {cancelledOpen ? "Свернуть" : "Показать"}
            </button>
          </div>
          {cancelledOpen && (
            <div className="list" style={{ marginTop: "var(--s3)" }}>
              {cancelledPage.visible.map((d) => (
                <div className="row done" key={d.id}>
                  <div className="t">
                    <b>
                      <button className="lk" type="button" onClick={() => openClient(d.id)}>
                        {d.client.fullName}
                      </button>
                    </b>
                    <span>{d.property.title}</span>
                  </div>
                  {d.annulledAt && (
                    <span className="chip warn" title={d.annulReason ? `Причина: ${d.annulReason}` : undefined}>
                      аннулирована
                    </span>
                  )}
                  <span className="meta">{formatMoney(d.property.price, d.property.currency)}</span>
                </div>
              ))}
              {cancelledPage.hasMore && (
                <p className="state">
                  и ещё {cancelled.length - cancelledPage.visible.length}.{" "}
                  <button className="lk" type="button" onClick={cancelledPage.showMore}>
                    Показать
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {annullingId && canComplete && (
        <DealAnnulDialog
          clientName={completed.find((d) => d.id === annullingId)?.client.fullName ?? null}
          pending={annulDeal.isPending}
          error={annulDeal.error instanceof Error ? annulDeal.error.message : null}
          onConfirm={(reason) =>
            annulDeal.mutate({ id: annullingId, reason }, { onSuccess: () => setAnnullingId(null) })
          }
          onCancel={() => setAnnullingId(null)}
        />
      )}
      {archiveDocsDealId && (
        <DealDocumentsModal
          dealId={archiveDocsDealId}
          dealStage="COMPLETED"
          canPayout={canPayout}
          onClose={() => setArchiveDocsDealId(null)}
        />
      )}
    </>
  );

  const emptyBoard = !isLoading && !error && !!deals && board.length === 0 && pendingApproval.length === 0 && (
    <div className="card tight">
      <div className="empty">
        <span className="ic">
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M4 12h16M4 17h10" />
          </svg>
        </span>
        <p>На доске пока пусто. Сделка появляется здесь, когда с клиентом договорились о конкретном объекте.</p>
      </div>
    </div>
  );

  // «Месяц» и шторка «Фильтры» — один раз на оба облика (десктоп и телефон),
  // чтобы текст и правила фильтра не разошлись между файлами.
  const monthSection = (
    <div className="card tight">
      <div className="sec-h">
        <h2>Этот месяц</h2>
        <span className="note">плана продаж в CRM не заведено — здесь только факт</span>
      </div>
      {/* Пробел после числа — обычный текстовый, а не отступ у `<b>`: на узком
          экране строки складываются в один поток, и без него владелец 21.09.2026
          читал «0закрыто, 0в работе0ждут одобрения». */}
      {/* Явный зазор между тремя числами: в облике телефона (.rh2 .mh) у
          .prog-legend своего нет, и строка читалась «2 в работе0 ждут одобрения». */}
      <div className="prog-legend" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
        <span>
          <b>{closedThisMonth.length}</b> закрыто
          {seesMoney && (
            <>
              , <span className="money">{formatMoney(closedThisMonthSum, "TJS")}</span>
            </>
          )}
        </span>
        <span>
          <b>{board.length}</b> в работе
        </span>
        <span>
          <b>{pendingApproval.length}</b> ждут одобрения
        </span>
      </div>
    </div>
  );

  const filtersSheet = showFilters && (
    <Rh2Sheet
      title="Фильтры"
      onClose={() => setShowFilters(false)}
      ariaLabel="Фильтры сделок"
      footer={
        <>
          <button className="pill ghost" type="button" onClick={() => setFilterAgentId("")}>
            Сбросить
          </button>
          <button className="pill" type="button" onClick={() => setShowFilters(false)}>
            Показать{deals ? ` ${deals.length}` : ""}
          </button>
        </>
      }
    >
      {/* Стадия и срок из шаблона не перенесены: доска и так показывает все
          стадии разом колонками (сужать её до одной — терять функцию, а не
          фильтровать), а «просрочено/на неделе» у сделки посчитать нечем —
          своего срока у неё нет, только возраст с начала. */}
      <div className="sec-t" style={{ marginTop: 0 }}>
        Агент
      </div>
      <label className="field">
        <span className="lab">Кто ведёт</span>
        <span className="fld">
          <select value={filterAgentId} onChange={(e) => setFilterAgentId(e.target.value)} aria-label="Фильтр по агенту">
            <option value="">Все агенты</option>
            {agentsList?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </select>
        </span>
      </label>
    </Rh2Sheet>
  );

  // Мобильная доска — тот же язык эталона, но строками (screens/deals.html,
  // блок .only-narrow). Данные и обработчики — те же, что у десктопной доски.
  if (mobile && !clean) {
    return (
      <MobileDeals
        stages={BOARD_STAGES}
        board={board}
        ready={!!deals}
        teamWide={teamWide}
        canComplete={canComplete}
        canPayout={canPayout}
        canSetCommission={canSetCommission}
        canWriteDeal={canWriteDeal}
        canCreate={writesForeign}
        sensors={sensors}
        onDragEnd={handleDragEnd}
        onOpen={openClient}
        onMoveStage={moveStage}
        banners={banners}
        monthSection={monthSection}
        solve={solve}
        archive={archive}
        emptyBoard={emptyBoard}
        emptyStageHint={EMPTY_STAGE_HINT}
        onOpenFilters={() => setShowFilters(true)}
        onNewDeal={() => setShowNewDeal(true)}
        filtersSheet={
          <>
            {filtersSheet}
            {showNewDeal && writesForeign && <NewDealSheet onClose={() => setShowNewDeal(false)} />}
          </>
        }
      />
    );
  }

  return (
    <div className="rh2 screens">
      <div className={clean ? "scr clean-deals" : "scr"} style={clean ? cleanClientDetailScale : undefined}>
        <div className="pg-h">
          {clean ? <CleanDealsHeader teamWide={teamWide} filterName={filterAgentId ? agentsList?.find((agent) => agent.id === filterAgentId)?.fullName ?? "Выбранный агент" : undefined} onCreate={writesForeign ? () => setShowNewDeal(true) : null} onFilter={teamWide ? () => setShowFilters(true) : null} /> : <>
          <div>
            <h1>Сделки</h1>
            <p className="sub">
              {board.length} в работе{can("deals.viewAll") ? ", всей команды" : ", только ваши"}
              {pendingApproval.length > 0 ? `, ${pendingApproval.length} ждут одобрения` : ""}. Перетащите карточку между
              колонками, чтобы сменить этап.
            </p>
          </div></>}
        </div>

        {/* Вкладок «Продавцы / Покупатели» здесь больше нет (23.09.2026): у
            «Сделок» своя строка меню, а вкладки показывали счётчики клиентов
            («Продавцы 0, Покупатели 0» при двух сделках в работе) и уводили со
            страницы. */}

        {/* Пояснение про статус клиента и этап сделки жило ВТОРЫМ абзацем `.sub`
            в шапке, и шапка вырастала до 159px против 76 у эталона (замер
            docs/pult/theme-2026/reports/parity1440-measure.json): в макете
            `.pg-h` несёт ровно одну строку подписи. Текст никуда не делся — он
            переехал в тихую строку, которой эталон и объясняет такие вещи
            (`.card.tight` + `.quiet`, см. screens/comments.html).

            На телефоне прячем: TASKS.md 10.09 «с обзора прода глазами», п.5 —
            объяснение для новичков съедает место на каждом открытии экрана.
            DismissibleHint здесь не подходит (другая гарнитура/цвет, не
            вписывается в `.card.tight`+`.quiet` эталона), поэтому — «либо
            прятать» из задачи: класс `hint-onboard`, правило в
            theme-2026-mobile-density.css. На ПК блок остаётся как был. */}
        {clean ? <CleanDealsGuide canMove={board.some(canWriteDeal)} /> : <div className="card tight hint-onboard">
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Статус клиента (Новый, Горячий и так далее) это его «температура» интереса. Сделка появляется здесь
              только тогда, когда с клиентом уже договорились о конкретном объекте: статус клиента и этап сделки
              меняются независимо друг от друга.
            </span>
          </div>
          <div className="acts">
            {teamWide && (
              <button className="pill ghost" type="button" onClick={() => setShowFilters(true)}>
                Фильтры
              </button>
            )}
            {/* Шторка выбора клиента и объекта (NewDealSheet): до 23.09.2026 кнопка
                просто уводила в список клиентов, и агент не понимал, что дальше. */}
            {writesForeign && (
              <button className="pill ghost" type="button" onClick={() => setShowNewDeal(true)}>
                Новая сделка
              </button>
            )}
          </div>
        </div>}

        {banners}
        {/* Сводка месяца и «Решить сейчас» — в одном ряду на широком экране
            (`.cols2`, theme-royal-home-2026.css): обе невысокие сводки, порознь
            отодвигали доску на пол-экрана вниз. Доска `.kan` остаётся
            однорядной: четыре колонки стадий сами используют всю ширину.
            Ниже 1280 px порядок прежний, `.cols2` там обычный блок. */}
        {clean ? <>
          <CleanDealsSummary ready={!!deals && !error} activeCount={board.length} approvalCount={pendingApproval.length} closedCount={closedThisMonth.length} commissionTjs={closedThisMonthSum} seesMoney={seesMoney} />
          {solve}
        </> : <div className="cols2">
          {monthSection}
          {solve}
        </div>}

        {deals && (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            {clean && mobile && <div className="clean-mobile-stage-nav" role="group" aria-label="Стадии сделок">
              {BOARD_STAGES.map((stage) => <button type="button" key={stage.key} className="pill ghost" aria-pressed={mobileStage === stage.key} onClick={() => setMobileStage(stage.key)}>{stage.label} · {board.filter((deal) => deal.stage === stage.key).length}</button>)}
              <button type="button" className="pill ghost" aria-pressed={mobileStage === "APPROVAL"} onClick={() => setMobileStage("APPROVAL")}>На одобрение · {pendingApproval.length}</button>
            </div>}
            <div className={clean ? "clean-deals-board grid grid-cols-2 gap-4 min-[1180px]:grid-cols-4" : "kan"}>
              {BOARD_STAGES.filter((stage) => !clean || !mobile || stage.key === mobileStage).map((stage) => (
                <Column
                  clean={clean}
                  key={stage.key}
                  stage={stage.key}
                  label={stage.label}
                  deals={board.filter((d) => d.stage === stage.key)}
                  canComplete={canComplete}
                  canPayout={canPayout}
                  canSetCommission={canSetCommission}
                  canWriteDeal={canWriteDeal}
                  onOpen={openClient}
                  onMoveStage={moveStage}
                />
              ))}
              {/* Четвёртая колонка эталона — «Ждёт одобрения». Она НЕ зона сброса и
                  её карточки не таскаются: доска двигает только активный пайплайн,
                  а сюда сделка попадает формой «Отправить на закрытие». */}
              {(!clean || !mobile || mobileStage === "APPROVAL") && <div className="kan-col">
                <h3>
                  Ждёт одобрения<span className="n">{pendingApproval.length}</span>
                </h3>
                {pendingApproval.slice(0, 5).map((d) => (
                  <article className="dcard" key={d.id} tabIndex={0} onClick={() => openClient(d.id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openClient(d.id); } }}>
                    <span className="nm">{d.client.fullName}</span>
                    <span className="ob">{d.property.title}</span>
                    <span className="bt">
                      {seesMoney && (
                        <span className="money">{d.commissionAmount ? formatMoney(d.commissionAmount, d.currency) : "без комиссии"}</span>
                      )}
                      {canComplete ? (
                        <span className="act">
                          <button
                            className="pill ghost sm"
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateDeal.mutate({ id: d.id, body: { stage: "COMPLETED" } });
                            }}
                          >
                            Одобрить
                          </button>
                        </span>
                      ) : (
                        <span className="chip mute">ждёт руководителя</span>
                      )}
                    </span>
                  </article>
                ))}
                {pendingApproval.length === 0 && <p className="state">{EMPTY_STAGE_HINT.PENDING_APPROVAL}</p>}
                {pendingApproval.length > 5 && <p className="state">и ещё {pendingApproval.length - 5} выше, в полосе решений.</p>}
              </div>}
            </div>
          </DndContext>
        )}

        {emptyBoard}
        {archive}
        {filtersSheet}
        {showNewDeal && writesForeign && <NewDealSheet onClose={() => setShowNewDeal(false)} />}
      </div>
    </div>
  );
}

function Column({
  clean = false,
  stage,
  label,
  deals,
  canComplete,
  canPayout,
  canSetCommission,
  canWriteDeal,
  onOpen,
  onMoveStage,
}: {
  clean?: boolean;
  stage: DealStage;
  label: string;
  deals: Deal[];
  canComplete: boolean;
  canPayout: boolean;
  /** Право ставить сумму комиссии — отдельно от canComplete, иначе «Закрыть
   *  сделку» открывало бы форму с деньгами тому, кому сервер её не даст сохранить. */
  canSetCommission: boolean;
  /** Можно ли двигать и отменять эту сделку (A3, см. canWriteDeal в Deals). */
  canWriteDeal: (d: Deal) => boolean;
  onOpen: (id: string) => void;
  onMoveStage: (id: string, stage: DealStage, extra?: Record<string, unknown>) => void | Promise<unknown>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const usdToTjs = useUsdToTjsRate();
  // Тот же принцип, что и в общем итоге: колонка суммирует сделки в сомони.
  const total = deals.reduce((sum, d) => sum + toTjs(d.commissionAmount, d.currency, usdToTjs), 0);
  const { visible, hasMore, showMore } = usePaged(deals);

  return (
    // Подсветка зоны сброса — тем же приёмом, что «сегодня» в календаре эталона
    // (.cal .d.today): обводка токеном --ink, без своего цвета и своего класса.
    <div ref={setNodeRef} className={`kan-col${clean && isOver ? " clean-drop-target" : ""}`} style={isOver && !clean ? { outline: "2px solid var(--ink)" } : undefined}>
      <h3>
        {label}
        <span className="n">{deals.length}</span>
      </h3>
      {total > 0 && (
        <p className="state" style={{ padding: "0 0 var(--s3)" }}>
          комиссии <span className="money">{formatMoney(total, "TJS")}</span>
        </p>
      )}
      {visible.map((d) => (
        <DealCard
          clean={clean}
          key={d.id}
          deal={d}
          canComplete={canComplete}
          canPayout={canPayout}
          canSetCommission={canSetCommission}
          canWrite={canWriteDeal(d)}
          onOpen={() => onOpen(d.id)}
          onMoveStage={onMoveStage}
        />
      ))}
      {/* Пустая колонка объясняет, чем стадия наполняется, а при перетаскивании —
          что произойдёт, если отпустить. Обе строки — тихие, как в эталоне. */}
      {deals.length === 0 && <p className="state">{isOver ? "Отпустите, сделка перейдёт сюда" : EMPTY_STAGE_HINT[stage]}</p>}
      {hasMore && (
        <p className="state">
          и ещё {deals.length - visible.length}.{" "}
          <button className="lk" type="button" onClick={showMore}>
            Показать
          </button>
        </p>
      )}
    </div>
  );
}

function DealCard({
  clean = false,
  deal,
  canComplete,
  canPayout,
  canSetCommission,
  canWrite,
  onOpen,
  onMoveStage,
}: {
  clean?: boolean;
  deal: Deal;
  /** Двигать, отменять и закрывать эту сделку — только с правом записи (A3):
   *  служба безопасности видит чужую сделку, но не меняет её. */
  canWrite: boolean;
  /** Директор/админ закрывает сделку сам одним действием (19.08.2026), минуя
   *  отправку на согласование — решает режим формы, не видимость кнопки: кнопка
   *  «Отправить на закрытие» теперь открыта всем. */
  canComplete: boolean;
  /** Видимость кнопки «Выплачено» в окне документов (Пачка 14, 11.09.2026). */
  canPayout: boolean;
  /** Право ставить сумму комиссии — решает режим формы «Закрыть сделку» вместе
   *  с canComplete (24.09.2026): без него сервер отвечает 403 на введённые суммы,
   *  поэтому прямое закрытие с вводом денег доступно только при обоих правах. */
  canSetCommission: boolean;
  onOpen: () => void;
  onMoveStage: (id: string, stage: DealStage, extra?: Record<string, unknown>) => void | Promise<unknown>;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id, disabled: !canWrite });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.6 : undefined }
    : undefined;
  // Прямое закрытие с вводом сумм (mode="complete") требует ОБА права: закрывать
  // сделку и ставить комиссию. У менеджера (deals.complete есть, deals.setCommission
  // убрано 24.09.2026) без этого разбиения кнопка открывала форму денег и падала
  // 403 на сохранении — тупик, показанный как рабочая кнопка.
  const canCompleteWithMoney = canComplete && canSetCommission;

  // Перетаскивание удобно на десктопе, но на телефоне с ним сложно — эти
  // кнопки двигают сделку между соседними этапами по одному тапу, без drag.
  const stageIndex = BOARD_STAGES.findIndex((s) => s.key === deal.stage);
  const prevStage = stageIndex > 0 ? BOARD_STAGES[stageIndex - 1] : null;
  const nextStage = stageIndex < BOARD_STAGES.length - 1 ? BOARD_STAGES[stageIndex + 1] : null;
  // Confirm — у отмены реальные последствия (объект возвращается в продажу),
  // молча кликать рискованно. Отправка на закрытие — отдельная форма (submitting),
  // не голое подтверждение: там вводится цена и комиссия суммой.
  const [confirmAction, setConfirmAction] = useState<"cancel" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Документы сделки и «Выплачено» (Пачка 14, 11.09.2026) — своё окно, не форма.
  const [docsOpen, setDocsOpen] = useState(false);

  return (
    // Роль карточки — `group`, а не `role="button"` от dnd-kit: внутри стоят
    // настоящие кнопки, и роль кнопки делала их невидимыми для диктора
    // (axe nested-interactive). Разбор и что при этом сохраняется —
    // lib/a11y.ts.
    <>
    <article
      ref={setNodeRef}
      style={clean ? { ...style, border: 0, padding: 16, borderRadius: 18, overflowWrap: "anywhere" } : style}
      {...listeners}
      {...draggableGroupProps(attributes)}
      aria-label={`Сделка: ${deal.client.fullName}, ${deal.property.title}`}
      onClick={onOpen}
      className="dcard"
    >
      <span className="nm">{deal.client.fullName}</span>
      <span className="ob">{deal.property.title}</span>
      <span className="bt">
        <span className="money">{formatMoney(deal.property.price, deal.property.currency)}</span>
        <span className="chip mute">{daysSince(deal.startedAt)} дн</span>
      </span>
      {deal.commissionAmount ? (
        <span className="bt">
          <span className="ob">комиссия</span>
          <span className="chip ok">{formatMoney(deal.commissionAmount, deal.currency)}</span>
        </span>
      ) : null}
      {/* Документы сделки и факт выплаты комиссии (Пачка 14, 11.09.2026) — свой
          пункт подвала, не привязан к стадии: документы готовят заранее. */}
      <span className="bt">
        <button
          className="lnk"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDocsOpen(true);
          }}
        >
          документы
        </button>
      </span>
      {/* Подвал карточки: шаг назад, отмена, шаг вперёд или отправка на закрытие.
          Ни одна из этих кнопок в макете не нарисована, но без них сделку нельзя
          ни двигать без мыши, ни закрыть вообще — собраны из .lnk и .pill эталона.
          Без права записи в эту сделку (A3) подвала нет вовсе. */}
      {canWrite && (
      <span className="bt">
        <button
          className="lnk"
          type="button"
          disabled={!prevStage}
          onClick={(e) => {
            e.stopPropagation();
            if (prevStage) onMoveStage(deal.id, prevStage.key);
          }}
          title={prevStage ? `Вернуть на «${prevStage.label}»` : undefined}
          aria-label={prevStage ? `Вернуть на «${prevStage.label}»` : "Назад"}
          style={prevStage ? undefined : { visibility: "hidden" }}
        >
          <ChevronLeft className="i" aria-hidden="true" />
        </button>
        <button
          className="lnk"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmAction("cancel");
          }}
          title="Отменить сделку"
        >
          отменить
        </button>
        {nextStage ? (
          <button
            className="lnk"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoveStage(deal.id, nextStage.key);
            }}
            title={`Продвинуть на «${nextStage.label}»`}
            aria-label={`Продвинуть на «${nextStage.label}»`}
          >
            <ChevronRight className="i" aria-hidden="true" />
          </button>
        ) : (
          // Последний этап доски — раньше дальше пути не было вообще (стрелка гасла,
          // а зоны сброса для «Завершена» на доске не существует): сделку нельзя было
          // закрыть в CRM никаким способом. Теперь явная кнопка доступна ЛЮБОМУ агенту
          // (19.08.2026): он указывает фактическую цену и комиссию суммой. Дальше — по
          // роли: агент отправляет на одобрение директору; директор/админ
          // (canCompleteWithMoney) тем же окном закрывает сделку сам одним действием,
          // минуя согласование. Тот, у кого canComplete есть, а canSetCommission нет
          // (менеджер, 24.09.2026), тоже видит только «Отправить на закрытие» — иначе
          // форма приняла бы от него суммы и упала бы 403 при сохранении.
          <button
            className="lnk"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSubmitting(true);
            }}
            title={canCompleteWithMoney ? "Закрыть сделку" : "Отправить на закрытие"}
            aria-label={canCompleteWithMoney ? "Закрыть сделку" : "Отправить на закрытие"}
          >
            <Send className="i" aria-hidden="true" />
          </button>
        )}
      </span>
      )}
    </article>
    {/* Окна — СНАРУЖИ перетаскиваемой карточки (аудит 23.09.2026, №53): события
        React всплывают по дереву компонентов даже из портала, и клик по фону окна
        открывал клиента, а выделение текста в окне тащило карточку. */}
      {confirmAction && canWrite && (
        <DealStageConfirm
          action={confirmAction}
          onConfirm={() => {
            onMoveStage(deal.id, "CANCELLED");
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {submitting && canWrite && (
        <DealSubmitModal
          {...dealSubmitCurrencyProps(deal)}
          mode={canCompleteWithMoney ? "complete" : "submit"}
          onSubmit={async (data) => {
            await onMoveStage(deal.id, canCompleteWithMoney ? "COMPLETED" : "PENDING_APPROVAL", data);
            setSubmitting(false);
          }}
          onCancel={() => setSubmitting(false)}
        />
      )}
      {docsOpen && (
        <DealDocumentsModal
          dealId={deal.id}
          dealStage={deal.stage}
          canPayout={canPayout}
          onClose={() => setDocsOpen(false)}
        />
      )}
    </>
  );
}
