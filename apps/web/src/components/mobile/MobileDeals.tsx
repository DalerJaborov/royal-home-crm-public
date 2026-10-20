import { useState, type ReactNode } from "react";
import { DndContext, useDraggable, useDroppable, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, Send } from "lucide-react";
import type { DealStage } from "@royal-home/shared";
import { daysSince, formatMoney, pluralizeRu, toTjs } from "../../lib/format";
import { initialsFromName } from "../../lib/channelMeta";
import { draggableGroupProps } from "../../lib/a11y";
import { useUsdToTjsRate } from "../../hooks/useSettings";
import { usePaged } from "../../hooks/usePaged";
import { DealStageConfirm } from "../DealStageConfirm";
import { DealSubmitModal } from "../DealSubmitModal";
import { DealDocumentsModal } from "../DealDocumentsModal";
import type { Deal } from "../../types";
// Пилюля инициалов `.av` эталона (screens/deals.html, блок .only-narrow).
// Тон — из общей таблицы CRM: своя палитра «по коду первой буквы» давала
// одному человеку разный цвет в сделках и в чатах, а пустое имя роняло строку.
import { avatarTone } from "../../lib/avatarTone";
import { MhListScreen } from "./mh/MhList";
import { MhNoData } from "../home/mh/MhScreen";
import { dealSubmitCurrencyProps } from "../../lib/dealSubmitCurrency";

/**
 * Мобильные «Сделки» — облик второго артефакта владельца (`.rh2 .mh`,
 * MhListScreen из mh/MhList.tsx), не разметка ПК-эталона (`.rh2 .scr`,
 * `.pg-h`, `.card.tight`). Отдельного экрана сделок в макете c99db05f нет —
 * одет по договору вторых экранов, тем же приёмом, что уже стоит на
 * MobileChatsList.tsx, главной агента и «Моих звонках» (MobileCalls.tsx).
 *
 * ПЕРЕТАСКИВАНИЕ СТАДИЙ (dnd-kit, долгое нажатие 200 мс) НЕ ТРОГАЛОСЬ:
 * `useDraggable`/`useDroppable`, `listeners`/`attributes` навешаны на те же
 * элементы, что и раньше, — переоделась только разметка вокруг них. В макете
 * стадии переключаются лентой `.seg` (одна стадия на экране); здесь, как и в
 * прежнем облике, они остаются стопкой карточек: лента-переключатель оставила
 * бы на экране одну зону сброса, и перетащить сделку между стадиями стало бы
 * нечем.
 *
 * Логика и данные — целиком в pages/Deals.tsx (те же хуки, обработчики и
 * модальные окна): этот файл — только мобильная разметка.
 */
export function MobileDeals({
  stages,
  board,
  ready,
  teamWide,
  canComplete,
  canPayout,
  canSetCommission,
  canWriteDeal,
  canCreate,
  sensors,
  onDragEnd,
  onOpen,
  onMoveStage,
  banners,
  monthSection,
  solve,
  archive,
  emptyBoard,
  emptyStageHint,
  onOpenFilters,
  onNewDeal,
  filtersSheet,
}: {
  /** BOARD_STAGES из pages/Deals.tsx — прокинуты пропсом, а не импортом, чтобы
   *  не заводить цикл модулей Deals ⇄ MobileDeals. */
  stages: { key: DealStage; label: string }[];
  board: Deal[];
  /** Данные пришли (deals !== undefined) — доску без данных не рисуем. */
  ready: boolean;
  /** deals.viewAll: у руководителя в подписи «всей команды», у агента «только ваши». */
  teamWide: boolean;
  /** Директор/админ закрывает сделку сам одним действием — режим формы, не видимость кнопки. */
  canComplete: boolean;
  /** Видимость кнопки «Выплачено» в окне документов (Пачка 14, 11.09.2026). */
  canPayout: boolean;
  /** Право ставить сумму комиссии — вместе с canComplete решает режим формы
   *  «Закрыть сделку» (24.09.2026): без него форма приняла бы суммы и упала бы
   *  403 сервера при сохранении. См. pages/Deals.tsx::DealCard. */
  canSetCommission: boolean;
  /** Можно ли двигать и отменять эту сделку (глубокая проверка 02.10.2026, A3):
   *  служба безопасности видит все сделки, но ничего не меняет. См. pages/Deals.tsx. */
  canWriteDeal: (d: Deal) => boolean;
  /** Кнопка «Новая сделка» — по тому же правилу записи. */
  canCreate: boolean;
  sensors: SensorDescriptor<SensorOptions>[];
  onDragEnd: (event: DragEndEvent) => void;
  onOpen: (id: string) => void;
  onMoveStage: (id: string, stage: DealStage, extra?: Record<string, unknown>) => void | Promise<unknown>;
  /** Загрузка, ошибка доски и отказ сервера — собраны один раз в pages/Deals.tsx. */
  banners: ReactNode;
  /** Блок «Этот месяц» эталона — без выдуманного плана, честный факт закрытых сделок. */
  monthSection: ReactNode;
  /** Полоса «Решить сейчас» — та же, что на десктопе: одобрить, изменить, вернуть. */
  solve: ReactNode;
  /** Завершённые и отменённые сделки: в макете их нет, но история и «Показать ещё»
   *  обязаны жить и на телефоне. */
  archive: ReactNode;
  /** Пустая доска — блок `.empty` эталона, общий на оба облика. */
  emptyBoard: ReactNode;
  emptyStageHint: Record<DealStage, string>;
  /** Открыть шторку «Фильтры» — сама шторка (та же, что на десктопе) прокинута отдельно. */
  onOpenFilters: () => void;
  /** «Новая сделка» — шторка выбора клиента и объекта (NewDealSheet, см. Deals.tsx). */
  onNewDeal: () => void;
  filtersSheet: ReactNode;
}) {
  const n = board.length;
  return (
    <MhListScreen title="Сделки" count={n || null}>
      {/* Вкладок «Продавцы / Покупатели» здесь нет (23.09.2026): они считали
          клиентов, а не сделки, и уводили с экрана. См. pages/Deals.tsx. */}

      <div className="sec" style={{ marginTop: 6 }}>
        {/* ОДНА СТРОКА ВМЕСТО АБЗАЦА (21.09.2026). Здесь стояло объяснение на
            четыре строки — про перетаскивание, про «температуру» клиента и про
            то, когда сделка вообще появляется. Инструкцию читают один раз, а
            место она занимает каждый раз, и на телефоне доска начиналась ниже
            сгиба. Владелец: «экран мне не нравится», «убрать лишние тексты». */}
        <div className="hint">
          {n} {pluralizeRu(n, ["сделка", "сделки", "сделок"])} в работе{teamWide ? ", всей команды" : ", только ваши"}.
        </div>
        <div className="chips">
          {teamWide && (
            <button className="btn ghost sm" type="button" onClick={onOpenFilters}>
              Фильтры
            </button>
          )}
          {canCreate && (
            <button className="btn pill sm" type="button" onClick={onNewDeal}>
              Новая сделка
            </button>
          )}
        </div>
      </div>

      {banners}
      {monthSection}
      {solve}
      {/* ЗАКРЫТЫЕ СДЕЛКИ ПОДНЯТЫ НАД ДОСКОЙ (21.09.2026). Владелец: «заходишь в
          сделки — законченные, закрытые в самом низу, мелкий шрифт, и надо
          поискать, ещё постараться, где это найти». На телефоне доска — это три
          стадии со списками и кнопками, то есть несколько экранов прокрутки;
          архив, стоявший после неё, находили не все. Секция свёрнута (кнопка
          «Показать»), поэтому наверху она занимает одну строку и активную
          работу не заслоняет. */}
      {archive}

      {ready && (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          {stages.map((stage) => (
            <MobileStageColumn
              key={stage.key}
              stages={stages}
              stage={stage.key}
              label={stage.label}
              deals={board.filter((d) => d.stage === stage.key)}
              canComplete={canComplete}
              canPayout={canPayout}
              canSetCommission={canSetCommission}
              canWriteDeal={canWriteDeal}
              onOpen={onOpen}
              onMoveStage={onMoveStage}
              emptyHint={emptyStageHint[stage.key]}
            />
          ))}
        </DndContext>
      )}

      {emptyBoard}
      {filtersSheet}
    </MhListScreen>
  );
}

/** Стадия — карточка `.card-s` макета с заголовком секции `.sec-t` и списком строк. */
function MobileStageColumn({
  stages,
  stage,
  label,
  deals,
  canComplete,
  canPayout,
  canSetCommission,
  canWriteDeal,
  onOpen,
  onMoveStage,
  emptyHint,
}: {
  stages: { key: DealStage; label: string }[];
  stage: DealStage;
  label: string;
  deals: Deal[];
  canComplete: boolean;
  canPayout: boolean;
  canSetCommission: boolean;
  canWriteDeal: (d: Deal) => boolean;
  onOpen: (id: string) => void;
  onMoveStage: (id: string, stage: DealStage, extra?: Record<string, unknown>) => void | Promise<unknown>;
  emptyHint: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const usdToTjs = useUsdToTjsRate();
  // Суммируем в сомони — сделки бывают и в долларах (валюта объекта), см. toTjs.
  const total = deals.reduce((sum, d) => sum + toTjs(d.commissionAmount, d.currency, usdToTjs), 0);
  const { visible, hasMore, showMore } = usePaged(deals);

  return (
    <div className="sec">
      <div className="sec-t">
        <h2>{label}</h2>
        <span className="cnt">
          {deals.length}
          {total > 0 ? `, комиссии ${formatMoney(total, "TJS")}` : ""}
        </span>
      </div>
      <div ref={setNodeRef} className="card-s" style={isOver ? { outline: "2px solid var(--ink)" } : undefined}>
        {deals.length === 0 ? (
          <MhNoData tone={isOver ? "ok" : undefined}>{isOver ? "Отпустите, сделка перейдёт сюда" : emptyHint}</MhNoData>
        ) : (
          <div className="list">
            {visible.map((d) => (
              <MobileDealRow
                key={d.id}
                stages={stages}
                deal={d}
                canComplete={canComplete}
                canPayout={canPayout}
                canSetCommission={canSetCommission}
                canWrite={canWriteDeal(d)}
                onOpen={() => onOpen(d.id)}
                onMoveStage={onMoveStage}
              />
            ))}
          </div>
        )}
        {hasMore && (
          <button type="button" className="row morerow" onClick={showMore}>
            <span className="t">
              <span className="n">Показать ещё ({deals.length - visible.length})</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Строка сделки — `.row` эталона: пилюля инициалов, имя и объект, сумма справа. */
function MobileDealRow({
  stages,
  deal,
  canComplete,
  canPayout,
  canSetCommission,
  canWrite,
  onOpen,
  onMoveStage,
}: {
  stages: { key: DealStage; label: string }[];
  deal: Deal;
  /** Двигать, отменять и закрывать — только с правом записи (A3). */
  canWrite: boolean;
  canComplete: boolean;
  /** Видимость кнопки «Выплачено» в окне документов (Пачка 14, 11.09.2026). */
  canPayout: boolean;
  /** Право ставить сумму комиссии — вместе с canComplete решает режим формы
   *  «Закрыть сделку» (24.09.2026). См. pages/Deals.tsx::DealCard. */
  canSetCommission: boolean;
  onOpen: () => void;
  onMoveStage: (id: string, stage: DealStage, extra?: Record<string, unknown>) => void | Promise<unknown>;
}) {
  // Прямое закрытие с вводом сумм требует ОБА права — см. doc-comment у
  // одноимённой переменной в pages/Deals.tsx::DealCard.
  const canCompleteWithMoney = canComplete && canSetCommission;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id, disabled: !canWrite });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.6 : undefined }
    : undefined;

  const stageIndex = stages.findIndex((s) => s.key === deal.stage);
  const prevStage = stageIndex > 0 ? stages[stageIndex - 1] : null;
  const nextStage = stageIndex >= 0 && stageIndex < stages.length - 1 ? stages[stageIndex + 1] : null;
  // Отмена возвращает объект в продажу — молча не кликается. Отправка на закрытие —
  // отдельная форма (submitting): цена и комиссия суммой, не голое подтверждение.
  const [confirmAction, setConfirmAction] = useState<"cancel" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Документы сделки и «Выплачено» (Пачка 14, 11.09.2026) — то же окно, что и на
  // десктопе (DealDocumentsModal), только с телефона открывается своей кнопкой.
  const [docsOpen, setDocsOpen] = useState(false);

  return (
    // Роль строки — `group`, а не `role="button"` от dnd-kit: внутри стоят
    // настоящие кнопки (открыть карточку, шаг по стадиям, закрытие), и роль
    // кнопки делала их невидимыми для диктора — axe nested-interactive, 16
    // узлов. Разбор — lib/a11y.ts.
    <>
    <div
      ref={setNodeRef}
      // Перенос строки (23.09.2026): кнопки «документы / отменить / ›» стояли
      // в той же строке, что имя, и на 390 px от «Умед Собиров» оставалось
      // «Умед Со». Теперь они уходят второй строкой под имя.
      style={{ ...style, flexWrap: "wrap" }}
      {...listeners}
      {...draggableGroupProps(attributes)}
      aria-label={`Сделка: ${deal.client.fullName}, ${deal.property.title}`}
      className="row"
    >
      <span className="av" style={avatarTone(deal.client.fullName)} aria-hidden="true">
        {initialsFromName(deal.client.fullName)}
      </span>
      {/* Явная подпись, куда ведёт нажатие (21.09.2026). Владелец: «при нажатии
          кнопки сделка куда-то ведёт». Ведёт она в карточку клиента — своего
          экрана у сделки в CRM нет вовсе, — и до этой подписи узнать об этом
          можно было только нажав. */}
      <button
        type="button"
        className="t"
        style={{ textAlign: "left" }}
        onClick={onOpen}
        title={`Открыть карточку клиента: ${deal.client.fullName}`}
        aria-label={`Открыть карточку клиента: ${deal.client.fullName}`}
      >
        <span className="n">{deal.client.fullName}</span>
        <span className="s">
          {deal.property.title} · {formatMoney(deal.property.price, deal.property.currency)} · {daysSince(deal.startedAt)} дн
          {deal.commissionAmount ? `, комиссия ${formatMoney(deal.commissionAmount, deal.currency)}` : ""}
        </span>
      </button>
      {/* Шаг по стадиям и закрытие сделки: в макете строки этих кнопок нет, но без
          них сделку с телефона не сдвинуть одним касанием и не закрыть вовсе. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          justifyContent: "flex-end",
          flexBasis: "100%",
        }}
      >
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
        {canWrite && prevStage && (
          <button
            className="lnk"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMoveStage(deal.id, prevStage.key);
            }}
            title={`Вернуть на «${prevStage.label}»`}
            aria-label={`Вернуть на «${prevStage.label}»`}
          >
            <ChevronLeft className="i" aria-hidden="true" />
          </button>
        )}
        {canWrite && (
        <button
          className="lnk"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmAction("cancel");
          }}
        >
          отменить
        </button>
        )}
        {!canWrite ? null : nextStage ? (
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
          // Последний этап: без этой кнопки сделку на телефоне было бы не отправить
          // на закрытие вообще — зоны сброса «Завершена» на доске нет.
          <button
            className="btn pill sm"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSubmitting(true);
            }}
            title={canCompleteWithMoney ? "Закрыть сделку" : "Отправить на закрытие"}
          >
            <Send className="i" aria-hidden="true" />
            {canCompleteWithMoney ? "Закрыть" : "На закрытие"}
          </button>
        )}
      </div>
    </div>
    {/* Окна — СНАРУЖИ перетаскиваемой карточки (аудит 23.09.2026, №53): события
        React всплывают по дереву компонентов даже из портала, и клик по фону окна
        открывал клиента, а выделение текста в окне тащило карточку. */}
      {confirmAction && (
        <DealStageConfirm
          action={confirmAction}
          onConfirm={() => {
            onMoveStage(deal.id, "CANCELLED");
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {submitting && (
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
