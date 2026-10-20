import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CLIENT_STATUS_LABELS, REFUSAL_REASON_LABELS } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import { pluralizeRu, relativeTime } from "../lib/format";
import { INACTIVE_LEVEL_TONE } from "../components/InactiveLevelBadge";
import { trafficLightHref } from "../lib/trafficLightLink";
import { StatTile } from "../components/ui/StatTile";
import { TranscriptView } from "../components/TranscriptView";
import { useCounters } from "../hooks/useCounters";
import {
  useOversightSummary,
  useAgentsAtLimit,
  useOverdueTasks,
  useStalledClients,
  useInactiveClients,
  useLeadTransfers,
  useSilentAfterShowing,
  useRefusedHighScore,
  useTransferPairs,
  useSellerPropertyMissing,
  useEndlessNegotiations,
  useAgentLossSeries,
  useTrafficLightSummary,
  useShowingSurveyCalls,
  useShowingSurveyCall,
  useShowingSurveyRecordingUrl,
  type EventLogRow,
  type ShowingSurveyCallRow,
} from "../hooks/useOversight";
import { TeamTabs } from "../components/SectionTabs";
import { Pagination } from "../components/Pagination";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";

/** Плитка над сводкой прокручивает к своему срезу ниже на этом же экране —
 * маршрута с фильтром нет ни у одного из этих счётчиков, все они уже здесь. */
function scrollToSlice(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * «Контроль руководителя» (ТЗ «Путь покупателя», п. 32) — сводка по данным,
 * которые CRM уже копит. Ничего не считается заново отдельным джобом: это
 * витрина над существующими таблицами (см. apps/api/src/routes/oversight.ts).
 *
 * ОБЛИК: дословный перенос утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/oversight.html). Классы прототипные (`.scr`,
 * `.pg-h`, `.tiles`/`.tile`, `.sec`/`.sec-h`, `.card.tight`, `.quiet`,
 * `.chip`, `.pill`, `.loadbar`, `.state`, `.empty`), экран включает эталон
 * обёрткой `<div className="rh2 screens">`, стили из apps/web/src/theme-2026-proto.css.
 *
 * ОДИН ЭКРАН НА ОБЕ ШИРИНЫ. Прежде рядом жил `components/mobile/MobileOversight.tsx`
 * — те же 12 запросов и те же 11 срезов, только другая вёрстка. Именно на этой
 * паре файлов CRM дважды теряла данные: красные флаги антифрода 22.08.2026 и
 * четвёртый флаг 30.08.2026 уехали на прод только в десктопной версии, и
 * владелец их на телефоне не видел. Один файл на обе ширины закрывает этот
 * класс ошибок конструктивно: расходиться больше нечему. Прототип сам умеет
 * узкую раскладку (`.tiles` → 2 колонки, `.quiet` переносит текст).
 *
 * ВСЕ 11 СРЕЗОВ НА МЕСТЕ, порядок прототипа: просроченные задачи, агенты у
 * лимита, высокий скоринг без прогресса, тишина после показа, продавец без
 * объекта, вечные переговоры, отказ при хорошем скоринге, серия у одного
 * агента, журнал переводов в «Неактивные», журнал передач, маршруты передач.
 */

// «Назад» с карточки клиента должен вести сюда, а не в общий список «Клиенты»
// (жалоба владельца — audit §6).
const OVERSIGHT_BACK_STATE = { from: "/oversight", fromLabel: "Контроль руководителя" };

function ClientLink({ shortId, fullName }: { shortId: number; fullName: string }) {
  return (
    <Link className="lk" to={`/clients/${shortId}`} state={OVERSIGHT_BACK_STATE}>
      {fullName}
    </Link>
  );
}

function AgentLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link className="lk" to={`/team/${id}`}>
      {children}
    </Link>
  );
}

/** «Агент {имя}» ссылкой на карточку, если агент назначен — а не голым текстом. */
function AgentOrUnassigned({ agent }: { agent: { id: string; fullName: string } | null | undefined }) {
  return agent ? <AgentLink id={agent.id}>{agent.fullName}</AgentLink> : <>не назначен</>;
}

/** Каркас среза: заголовок, счётчик, пояснение и плотная карточка со строками. */
function Slice({
  id,
  title,
  note,
  hint,
  children,
}: {
  id?: string;
  title: string;
  note?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="sec" id={id}>
      <div className="sec-h">
        <h2>{title}</h2>
        {note !== undefined && <span className="note">{note}</span>}
      </div>
      {hint && <p className="state">{hint}</p>}
      <div className="card tight">{children}</div>
    </div>
  );
}

/**
 * Три состояния каждого среза тихими строками (правило договора §12). Отказ
 * запроса раньше не проверялся ни в одной секции десктопа: списки просто не
 * появлялись, а журналы застревали на «Загрузка…» навсегда.
 */
function SliceState({
  isLoading,
  isError,
  isEmpty,
  errorText,
  emptyText,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  errorText: string;
  emptyText: string;
  onRetry?: () => void;
}) {
  if (isLoading)
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Считаем срез
      </div>
    );
  if (isError)
    return (
      <div className="state err">
        <span className="dot crit" /> {errorText}{" "}
        {onRetry && (
          <button
            className="lk"
            type="button"
            style={{ color: "inherit", textDecoration: "underline" }}
            onClick={onRetry}
          >
            Повторить
          </button>
        )}
      </div>
    );
  if (isEmpty) return <p className="state">{emptyText}</p>;
  return null;
}

/**
 * ЛЕНТА СРЕЗА: «Показать ещё» ДОПИСЫВАЕТ строки, а не заменяет страницу
 * (решение владельца 15.09.2026 — списки растут лентой). Раньше кнопка с этой
 * подписью листала страницу целиком, а «Назад» был отдельной ссылкой; когда
 * последняя страница пустела (задачу закрыли, клиента забрали), пейджер
 * прятался вовсе, и человек оставался на пустом срезе без пути назад.
 *
 * Копим общим useAccumulatedPages, первая страница подписана вторым вызовом
 * того же хука данных (`head`) — при `page = 1` это тот же запрос. Строки
 * показываются из накопленного, а не из ответа текущей страницы: пока грузится
 * следующая, уже показанное не мигает «Считаем срез».
 */
type SliceQuery<D> = {
  data?: D;
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
};

function useSliceFeed<D extends { items: unknown[]; total: number; pageSize: number }>(
  page: number,
  current: SliceQuery<D>,
  head: SliceQuery<D>,
  resetKey: unknown = null
) {
  const items = useAccumulatedPages<D["items"][number]>(current.data?.items, page, resetKey, head.data?.items);
  return {
    items,
    // Подписи среза (число, пороги) — из любого свежего ответа, чтобы не мигали
    // на время подгрузки.
    data: current.data ?? head.data,
    // Пейджер — только по ответу ТЕКУЩЕЙ страницы: иначе по старым числам
    // «Показать ещё» перескочило бы через грузящуюся страницу.
    pagerData: current.data,
    isLoading: current.isLoading && items.length === 0,
    isError: current.isError,
    refetch: current.refetch,
  };
}

/** «Показаны N из T» и общая кнопка «Показать ещё» (components/Pagination.tsx). */
function SlicePager({
  page,
  pageSize,
  total,
  shown,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  shown: number;
  onPageChange: (p: number) => void;
}) {
  // Pagination рендерится всегда: страница за краем выдачи (последняя
  // опустела) возвращается им самим на последнюю живую.
  return (
    <>
      {total > pageSize && shown > 0 && (
        <p className="state">
          Показаны {shown} из {total}.
        </p>
      )}
      <Pagination variant="loadMore" page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} />
    </>
  );
}

/* ─────────────────────────────── 1. Просроченные задачи ────────────────────── */

/**
 * «Светофор неактивных — сейчас» (аудит 03.09.2026 ночь, п.7: у директора не
 * было ни одного экрана «весь светофор одним взглядом»). Числа ведут в
 * «Клиенты» с теми же фильтрами (workStatus=INACTIVE, inactiveLevel, agentId —
 * см. lib/trafficLightLink.ts) — 0 не ссылка, там нечего смотреть.
 */
function TrafficLightCount({ level, value, agentId }: { level: "RED" | "YELLOW" | "GREEN"; value: number; agentId?: string }) {
  if (value === 0) return <span className="meta">—</span>;
  return (
    <Link className={`chip ${INACTIVE_LEVEL_TONE[level]}`} to={trafficLightHref(level, agentId)}>
      {value}
    </Link>
  );
}

function TrafficLightSummary() {
  const { data, isLoading, isError, refetch } = useTrafficLightSummary();
  const agents = data?.agents ?? [];

  return (
    <Slice
      title="Светофор неактивных — сейчас"
      note={data ? `${data.totals.red + data.totals.yellow + data.totals.green} карточек` : undefined}
      hint="Кто сейчас в каком цвете: красный — ни разу не дозвонились, жёлтый — дозвонились, но встречи или показа не было, зелёный — встреча была. Число ведёт в отфильтрованный список клиентов."
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && agents.length === 0}
        errorText="Светофор не загрузился. Это сбой связи, а не «все зелёные»."
        emptyText="Неактивных клиентов нет ни у одного агента."
        onRetry={() => refetch()}
      />
      {data && agents.length > 0 && (
        <div className="quiet">
          <span className="txt">
            Всего: <TrafficLightCount level="RED" value={data.totals.red} /> красных ·{" "}
            <TrafficLightCount level="YELLOW" value={data.totals.yellow} /> жёлтых ·{" "}
            <TrafficLightCount level="GREEN" value={data.totals.green} /> зелёных
          </span>
        </div>
      )}
      {agents.map((a) => (
        <div className="row" key={a.agentId}>
          <div className="t">
            <b>
              <AgentLink id={a.agentId}>{a.agentName}</AgentLink>
            </b>
            <span>{a.total} неактивных</span>
          </div>
          <div className="act">
            <TrafficLightCount level="RED" value={a.red} agentId={a.agentId} />
            <TrafficLightCount level="YELLOW" value={a.yellow} agentId={a.agentId} />
            <TrafficLightCount level="GREEN" value={a.green} agentId={a.agentId} />
          </div>
        </div>
      ))}
    </Slice>
  );
}

function OverdueTasks() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useOverdueTasks(page), useOverdueTasks(1));

  return (
    <Slice
      id="slice-overdue-tasks"
      title="Просроченные задачи"
      note={data ? `${data.total} ${pluralizeRu(data.total, ["штука", "штуки", "штук"])}` : undefined}
      hint="Обещанный агентом следующий шаг, срок которого уже прошёл."
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Список просроченных задач не загрузился. Это сбой связи, а не «просрочек нет»."
        emptyText="Просроченных задач нет."
        onRetry={() => refetch()}
      />
      {items.map((row) => (
        <div className="quiet crit" key={row.id}>
          <span className="txt">
            <ClientLink shortId={row.client.shortId} fullName={row.client.fullName} />
            {row.client.workStatus === "INACTIVE" ? " (Неактивен)" : ""}: {row.nextAction}. Срок{" "}
            {row.nextActionDate ? relativeTime(row.nextActionDate) : "не указан"}. Агент{" "}
            {row.agent ? <AgentLink id={row.agent.id}>{row.agent.fullName}</AgentLink> : "—"}.
          </span>
          <Link className="pill ghost sm" to={`/clients/${row.client.shortId}`} state={OVERSIGHT_BACK_STATE}>
            Открыть
          </Link>
        </div>
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={items.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/* ─────────────────────────────── 2. Агенты у лимита ────────────────────────── */

function AgentsAtLimit() {
  const { data, isLoading, isError, refetch } = useAgentsAtLimit();
  const items = data?.items ?? [];
  const limit = data?.limit ?? 0;

  return (
    <Slice
      id="slice-agents-at-limit"
      title="Агенты у лимита лидов"
      note={data ? `${data.items.length} ${pluralizeRu(data.items.length, ["человек", "человека", "человек"])}` : undefined}
      hint={
        data
          ? `Активный портфель ${limit} из ${limit}: новые обычные лиды агенту не распределяются, пока он не закроет клиента.`
          : undefined
      }
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Не удалось проверить лимиты агентов. «Никто не у лимита» сейчас утверждать нельзя."
        emptyText="Никто не упирается в лимит."
        onRetry={() => refetch()}
      />
      {items.map((a) => {
        const share = limit > 0 ? Math.min(1, a.total / limit) : 0;
        const tone = a.total >= limit ? "loadbar full" : share >= 0.8 ? "loadbar near" : "loadbar";
        return (
          <div className="quiet" key={a.id}>
            <span className="txt">
              <AgentLink id={a.id}>{a.fullName}</AgentLink>
              {a.frozen ? " (заморожен)" : ""}. Портфель {a.total} из {limit}, из них своих сверх лимита: {a.own}.
            </span>
            <span className={tone} style={{ maxWidth: 120 }}>
              <span className="bar">
                <i style={{ "--v": share } as React.CSSProperties} />
              </span>
              <span className="n">
                {a.total} из {limit}
              </span>
            </span>
          </div>
        );
      })}
    </Slice>
  );
}

/* ────────────────────── 3. Высокий скоринг без прогресса ───────────────────── */

function StalledClients() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useStalledClients(page), useStalledClients(1));

  return (
    <Slice
      id="slice-stalled-clients"
      title="Высокий скоринг без прогресса"
      note={data ? `${data.total} ${pluralizeRu(data.total, ["клиент", "клиента", "клиентов"])}` : undefined}
      hint="Клиенты с высокой оценкой ИИ (вероятная сделка), с которыми не связывались больше трёх дней."
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Не удалось загрузить зависших горячих клиентов. Не считайте, что их нет."
        emptyText="Таких клиентов нет, все горячие лиды под контролем."
        onRetry={() => refetch()}
      />
      {items.map((c) => (
        <div className="quiet" key={c.id}>
          <span className="txt">
            <ClientLink shortId={c.shortId} fullName={c.fullName} />. {CLIENT_STATUS_LABELS[c.status]}. Последний контакт{" "}
            {relativeTime(c.lastContactAt)}. Агент <AgentOrUnassigned agent={c.assignedAgent} />.
          </span>
          <span className="chip warn">{c.aiScore}</span>
          <Link className="pill ghost sm" to={`/clients/${c.shortId}`} state={OVERSIGHT_BACK_STATE}>
            Открыть
          </Link>
        </div>
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={items.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/* ─────────────────────────── 4. Тишина после показа ────────────────────────── */

function SilentAfterShowing() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useSilentAfterShowing(page), useSilentAfterShowing(1));

  return (
    <Slice
      id="slice-silent-after-showing"
      title="Тишина после показа"
      note={data ? `${data.total} ${pluralizeRu(data.total, ["клиент", "клиента", "клиентов"])}` : undefined}
      hint={
        data
          ? `Показ проведён больше ${data.days} дней назад, а после него ни одного звонка или сообщения через CRM. Карточка ещё не закрыта.`
          : undefined
      }
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Список не загрузился. Это сбой связи, а не «тишины нет»."
        emptyText="Таких клиентов нет, после показов есть контакт."
        onRetry={() => refetch()}
      />
      {items.map((c) => (
        <div className="quiet warn" key={c.id}>
          <span className="txt">
            <ClientLink shortId={c.shortId} fullName={c.fullName} />
            {c.workStatus === "INACTIVE" ? " (Неактивен)" : ""}. С показа прошло: {relativeTime(c.lastContactAt)}. Агент{" "}
            <AgentOrUnassigned agent={c.assignedAgent} />.
          </span>
          <Link className="pill ghost sm" to={`/clients/${c.shortId}`} state={OVERSIGHT_BACK_STATE}>
            Открыть
          </Link>
        </div>
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={items.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/* ─────────────────────────── 5. Продавец без объекта ───────────────────────── */

/**
 * Жёлтый и красный флаг «Продавец без объекта» (Settings.sellerPropertyMissing*):
 * продавец принят в работу, а карточки объекта всё ещё нет. Красная строка уже
 * ушла в службу безопасности сама (lib/sellerPropertyMissingAntifraud.ts).
 */
function SellerPropertyMissing() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useSellerPropertyMissing(page), useSellerPropertyMissing(1));

  return (
    <Slice
      id="slice-seller-property-missing"
      title="Продавец без объекта"
      note={data ? `${data.total} ${pluralizeRu(data.total, ["карточка", "карточки", "карточек"])}` : undefined}
      hint={
        data
          ? `Принят в работу больше ${data.warnDays} дней назад, карточки объекта всё ещё нет. После ${data.criticalDays} дней это критично, карточка уходит в службу безопасности сама.`
          : undefined
      }
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Список не загрузился. Это сбой связи, а не «случаев нет»."
        emptyText="Таких случаев нет, у всех принятых продавцов есть карточка объекта."
        onRetry={() => refetch()}
      />
      {items.map((c) => (
        <div className={c.level === "CRITICAL" ? "quiet crit" : "quiet warn"} key={c.id}>
          <span className="txt">
            <ClientLink shortId={c.shortId} fullName={c.fullName} />. Принят {relativeTime(c.propertyAcceptedAt)},
            объекта нет.
            {c.level === "CRITICAL" ? " Ушёл в службу безопасности." : ""} Агент <AgentOrUnassigned agent={c.assignedAgent} />.
          </span>
          <span className={c.level === "CRITICAL" ? "chip crit" : "chip warn"}>{c.daysSince} дн</span>
          <Link className="pill ghost sm" to={`/clients/${c.shortId}`} state={OVERSIGHT_BACK_STATE}>
            Открыть
          </Link>
        </div>
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={items.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/* ────────────────────────────── 6. Вечные переговоры ───────────────────────── */

/**
 * Красный флаг «Вечные переговоры» (владелец 01.09.2026): ветка «Переговоры»
 * окна «Итог приёмки» повторилась подряд без выхода в другую ветку.
 */
function EndlessNegotiations() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useEndlessNegotiations(page), useEndlessNegotiations(1));

  return (
    <Slice
      id="slice-endless-negotiations"
      title="Вечные переговоры"
      note={data ? `${data.total} ${pluralizeRu(data.total, ["карточка", "карточки", "карточек"])}` : undefined}
      hint={
        data
          ? `Итог приёмки подряд получил исход «Переговоры» ${data.maxRounds} раза и больше, без выхода в другую ветку.`
          : undefined
      }
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Список не загрузился. Это сбой связи, а не «переговоров нет»."
        emptyText="Таких карточек нет, переговоры разрешаются."
        onRetry={() => refetch()}
      />
      {items.map((n) => (
        <div className="quiet warn" key={n.id}>
          <span className="txt">
            <ClientLink shortId={n.client.shortId} fullName={n.client.fullName} />
            {n.client.workStatus === "INACTIVE" ? " (Неактивен)" : ""}. {n.rounds}{" "}
            {pluralizeRu(n.rounds, ["круг", "круга", "кругов"])} переговоров. Ближайший срок{" "}
            {relativeTime(n.dueAt)}. Агент {n.agent ? <AgentLink id={n.agent.id}>{n.agent.fullName}</AgentLink> : "—"}.
          </span>
          <span className="chip crit">
            {n.rounds} {pluralizeRu(n.rounds, ["круг", "круга", "кругов"])}
          </span>
          <Link className="pill ghost sm" to={`/clients/${n.client.shortId}`} state={OVERSIGHT_BACK_STATE}>
            Открыть
          </Link>
        </div>
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={items.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/* ────────────────────── 7. Отказ при хорошем скоринге ──────────────────────── */

function RefusedHighScore() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useRefusedHighScore(page), useRefusedHighScore(1));

  return (
    <Slice
      id="slice-refused-high-score"
      title="Отказ при хорошем скоринге"
      note={data ? `${data.total} за ${data.windowDays} дней` : undefined}
      hint={
        data
          ? `Клиент отказался, пока оценка ИИ была не ниже ${data.threshold}. Служба безопасности эту карточку ещё не открывала.`
          : undefined
      }
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Список не загрузился. Это сбой связи, а не «отказов нет»."
        emptyText="Таких случаев нет."
        onRetry={() => refetch()}
      />
      {items.map((r) => (
        <div className="quiet crit" key={r.id}>
          <span className="txt">
            {r.client ? (
              <ClientLink shortId={r.client.shortId} fullName={r.client.fullName} />
            ) : (
              "Карточка удалена"
            )}
            . Причина: {r.client?.refusalReason ? REFUSAL_REASON_LABELS[r.client.refusalReason] : "не указана"}.{" "}
            {relativeTime(r.createdAt)}. Агент {r.agent ? <AgentLink id={r.agent.id}>{r.agent.fullName}</AgentLink> : "—"}.
          </span>
          <span className="chip warn">{r.client?.aiScore ?? "—"}</span>
          {r.client && (
            <Link className="pill ghost sm" to={`/clients/${r.client.shortId}`} state={OVERSIGHT_BACK_STATE}>
              Открыть
            </Link>
          )}
        </div>
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={items.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/* ───────────────────────── 8. Серия у одного агента ────────────────────────── */

/**
 * Красный флаг «Серия у одного агента» (владелец 01.09.2026): 3 и больше
 * переводов в «Неактивные» или прямых потерь у одного агента за 7 дней.
 * Список короткий (штат агентов), пагинации нет.
 */
function AgentLossSeries() {
  const { data, isLoading, isError, refetch } = useAgentLossSeries();
  const items = data?.items ?? [];

  return (
    <Slice
      id="slice-agent-loss-series"
      title="Серия у одного агента"
      note={data ? `${data.items.length} ${pluralizeRu(data.items.length, ["человек", "человека", "человек"])}` : undefined}
      hint={
        data
          ? `${data.threshold} перевода в «Неактивные» или прямых потери и больше у одного агента за последние ${data.windowDays} дней.`
          : undefined
      }
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Список не загрузился. Это сбой связи."
        emptyText="Серий не найдено."
        onRetry={() => refetch()}
      />
      {items.map((a) => (
        <div className="quiet warn" key={a.agentId}>
          <span className="txt">
            <AgentLink id={a.agentId}>{a.agentName}</AgentLink>. {a.count} {pluralizeRu(a.count, ["случай", "случая", "случаев"])} за
            неделю.
          </span>
          <span className="chip crit">
            {a.count} {pluralizeRu(a.count, ["случай", "случая", "случаев"])}
          </span>
          <Link className="pill ghost sm" to={`/team/${a.agentId}`}>
            Открыть
          </Link>
        </div>
      ))}
    </Slice>
  );
}

/* ───────────────────────────── 9 и 10. Журналы ─────────────────────────────── */

function EventLogSlice({
  id,
  title,
  hint,
  emptyText,
  rows,
  page,
  setPage,
  data,
  pagerData,
  isLoading,
  isError,
  onRetry,
}: {
  id?: string;
  title: string;
  hint: string;
  emptyText: string;
  rows: EventLogRow[];
  page: number;
  setPage: (p: number) => void;
  data?: { total: number; pageSize: number };
  pagerData?: { total: number; pageSize: number };
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  return (
    <Slice
      id={id}
      title={title}
      note={data ? `журнал, ${data.total} ${pluralizeRu(data.total, ["запись", "записи", "записей"])}` : undefined}
      hint={hint}
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && rows.length === 0}
        errorText="Журнал не загрузился. Записи не пропали, оборвалась связь."
        emptyText={emptyText}
        onRetry={onRetry}
      />
      {rows.map((row) => (
        <div className="quiet" key={row.id}>
          <span className="txt">
            <ClientLink shortId={row.client.shortId} fullName={row.client.fullName} />. {row.notes}. Агент{" "}
            {row.agent ? <AgentLink id={row.agent.id}>{row.agent.fullName}</AgentLink> : "—"}.
          </span>
          <span className="meta" style={{ fontSize: "var(--fs-12)", color: "var(--faint)" }}>
            {relativeTime(row.createdAt)}
          </span>
        </div>
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={rows.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/**
 * ЗВОНКИ-ОПРОСЫ ПОСЛЕ ПОКАЗА (антифрод, владелец 13.09.2026) — до сих пор
 * результат такого звонка (запись+расшифровка+находки record_concern, см.
 * lib/showingSurvey.ts, ai/liveVoiceSurveyPersona.ts) был виден ТОЛЬКО пуш-
 * уведомлением при найденном флаге. Здесь — полный разбор, включая звонки без
 * находок: карточке клиента этот результат по дизайну не показывается вовсе
 * (docs/post-viewing-survey-design-11-09.md), это единственное место, где его
 * видит директор.
 */
const RED_FLAG_LABELS: Record<string, string> = {
  personal_number: "просил личный номер в обход CRM",
  off_agency_deal: "сделка мимо агентства",
  price_mismatch: "цена не совпадает с тем, что клиенту говорили",
  no_commission_offer: "не предложил комиссию/услуги агентства",
  cant_recall: "не может вспомнить подробности показа",
  evasive: "уклоняется от прямых вопросов о показе",
};

function ShowingSurveyCalls() {
  const [page, setPage] = useState(1);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(
    page,
    useShowingSurveyCalls(page, onlyFlagged),
    useShowingSurveyCalls(1, onlyFlagged),
    onlyFlagged
  );
  const recording = useShowingSurveyRecordingUrl();
  const [playingId, setPlayingId] = useState<string | null>(null);
  // Запись играет в видимом плеере, а не в невидимом `new Audio()`: у того не
  // было ни паузы, ни стопа (аудит 23.09.2026, №45).
  const [player, setPlayer] = useState<{ id: string; url: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const listen = async (id: string) => {
    setPlayingId(id);
    try {
      const { url } = await recording.mutateAsync(id);
      setPlayer({ id, url });
    } catch {
      // Тихий отказ — запись необязательна, чтобы прочитать расшифровку и находки.
    } finally {
      setPlayingId(null);
    }
  };

  return (
    <Slice
      title="Звонки-опросы после показа"
      note={data ? `${data.total} ${pluralizeRu(data.total, ["звонок", "звонка", "звонков"])}` : undefined}
      hint="ИИ перезванивает клиенту после показа и проверяет слова агента — короткие находки уходят руководству сразу, полный разбор здесь. Агент к этой проверке доступа не имеет."
    >
      <label className="quiet" style={{ cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={onlyFlagged}
          onChange={(e) => {
            setOnlyFlagged(e.target.checked);
            setPage(1);
          }}
        />
        <span className="txt">Только с находками</span>
      </label>
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && items.length === 0}
        errorText="Список не загрузился. Это сбой связи, а не «звонков не было»."
        emptyText={onlyFlagged ? "Находок нет — все проверенные показы подтвердились." : "Звонков-опросов ещё не было."}
        onRetry={() => refetch()}
      />
      {items.map((row) => (
        <ShowingSurveyCallItem
          key={row.id}
          row={row}
          expanded={expandedId === row.id}
          onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
          onListen={() => void listen(row.id)}
          isPlaying={playingId === row.id}
          playerUrl={player?.id === row.id ? player.url : null}
          onClosePlayer={() => setPlayer(null)}
        />
      ))}
      {pagerData && (
        <SlicePager
          page={page}
          pageSize={pagerData.pageSize}
          total={pagerData.total}
          shown={items.length}
          onPageChange={setPage}
        />
      )}
    </Slice>
  );
}

/**
 * Одна строка списка — вынесена из `.map()` в отдельный компонент ради
 * `useShowingSurveyCall`: хук обязан звать каждый рендер поровну, а внутри
 * `.map()` число вызовов гуляло бы вместе с длиной страницы.
 *
 * 22.09.2026: «Подробнее» разворачивал `row.transcriptPreview` — сервер
 * обрезает его до 300 символов (`routes/oversight.ts`), хотя ручка полного
 * разбора (`GET /oversight/showing-survey-calls/:id`, хук
 * `useShowingSurveyCall`) уже существовала и не была подключена нигде.
 * Раздел по назначению — «здесь директор видит полный разбор» (doc-comment
 * `ShowingSurveyCalls` выше), а на серьёзной находке 300 символов часто режут
 * ответ клиента на середине, и единственный способ дослушать — «Прослушать»
 * всю запись целиком. Теперь разворот подгружает полный `transcript`, пока он
 * не пришёл — показывает превью, чтобы разворот не был пустым все время загрузки.
 */
function ShowingSurveyCallItem({
  row,
  expanded,
  onToggle,
  onListen,
  isPlaying,
  playerUrl,
  onClosePlayer,
}: {
  row: ShowingSurveyCallRow;
  expanded: boolean;
  onToggle: () => void;
  onListen: () => void;
  isPlaying: boolean;
  /** Запись этой строки в видимом плеере (аудит 23.09.2026, №45) — или null. */
  playerUrl: string | null;
  onClosePlayer: () => void;
}) {
  const detail = useShowingSurveyCall(expanded ? row.id : null);
  const transcript = detail.data?.transcript ?? row.transcriptPreview;

  return (
    <div className="quiet" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <span className="txt">
        {row.client ? <ClientLink shortId={row.client.shortId} fullName={row.client.fullName} /> : "Карточка удалена"}.
        Агент {row.agent ? <AgentLink id={row.agent.id}>{row.agent.fullName}</AgentLink> : "—"}.
        {row.property && ` Объект №${row.property.shortId}.`} {relativeTime(row.calledAt ?? row.createdAt)}
        {!row.calledAt && " (звонок ещё не состоялся)"}.
        {row.redFlags.length > 0 && (
          <>
            {" "}
            {row.redFlags.map((f, i) => (
              <span className="chip crit" key={i} style={{ marginRight: 4 }}>
                {RED_FLAG_LABELS[f.category] ?? f.category}
              </span>
            ))}
            {row.escalatedAt && <span className="chip warn">руководству отправлено</span>}
          </>
        )}
        {expanded && (
          <>
            <br />
            <span style={{ color: "var(--faint)" }}>
              {/* Исход разбора и дословная фраза клиента (17.09.2026): по ним
                  видно, на чём именно держится вывод, до чтения расшифровки. */}
              {row.outcomeLabel && (
                <>
                  Итог разговора: {row.outcomeLabel}.
                  <br />
                </>
              )}
              {row.quote && (
                <>
                  Дословно: «{row.quote}»
                  <br />
                </>
              )}
              {row.summary && !row.quote && (
                <>
                  {row.summary}
                  <br />
                </>
              )}
              {row.redFlags.map((f, i) => (
                <span key={i}>
                  «{RED_FLAG_LABELS[f.category] ?? f.category}»: {f.detail}
                  <br />
                </span>
              ))}
            </span>
          </>
        )}
      </span>
      {expanded && (
        // ВНЕ <span> ВЫШЕ НАРОЧНО: TranscriptView — блочная разметка (заголовок,
        // поиск, абзацы/реплики), а не строка текста, которую можно было
        // вложить в инлайновый <span> вместе с итогом/цитатой/красными флагами.
        <div style={{ width: "100%", marginTop: 8 }}>
          {transcript ? (
            <TranscriptView text={transcript} agentName={row.agent?.fullName ?? null} />
          ) : (
            <span style={{ color: "var(--faint)" }}>Расшифровки нет.</span>
          )}
          {detail.isLoading && <div className="note">Загружаю полный текст…</div>}
        </div>
      )}
      <button className="pill ghost sm" type="button" onClick={onToggle}>
        {expanded ? "Свернуть" : "Подробнее"}
      </button>
      {row.hasRecording && !playerUrl && (
        <button className="pill ghost sm" type="button" onClick={onListen} disabled={isPlaying}>
          {isPlaying ? "Загрузка…" : "Прослушать"}
        </button>
      )}
      {playerUrl && (
        <>
          <audio controls autoPlay preload="none" src={playerUrl} style={{ height: 34, maxWidth: 260 }} />
          <button className="pill ghost sm" type="button" onClick={onClosePlayer}>
            Закрыть запись
          </button>
        </>
      )}
    </div>
  );
}

function InactiveLog() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useInactiveClients(page), useInactiveClients(1));
  return (
    <EventLogSlice
      id="slice-inactive-log"
      title="Переводы в «Неактивные»"
      hint="Агент отметил, что клиент замолчал или отложил покупку. Слот в лимите освобождён, клиент не потерян."
      emptyText="Переводов в «Неактивные» пока не было."
      rows={items}
      page={page}
      setPage={setPage}
      data={data}
      pagerData={pagerData}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => refetch()}
    />
  );
}

function TransfersLog() {
  const [page, setPage] = useState(1);
  const { data, pagerData, items, isLoading, isError, refetch } = useSliceFeed(page, useLeadTransfers(page), useLeadTransfers(1));
  return (
    <EventLogSlice
      id="slice-transfers-log"
      title="Передачи между агентами"
      hint="Клиент ушёл от одного агента к другому: по решению агента или при уходе сотрудника."
      emptyText="Передач пока не было."
      rows={items}
      page={page}
      setPage={setPage}
      data={data}
      pagerData={pagerData}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => refetch()}
    />
  );
}

/* ───────────────────────── 11. Маршруты передач ────────────────────────────── */

function TransferPairs() {
  const { data, isLoading, isError, refetch } = useTransferPairs();
  const pairs = data?.pairs ?? [];

  return (
    <Slice
      title="Маршруты передач между агентами"
      note={data ? `за ${data.windowDays} дней` : undefined}
      hint={
        data
          ? `Топ пар «от кого, кому». Пара, повторившаяся ${data.frequentThreshold} раза и больше, отмечена. Смотреть ли внимательнее, решает руководитель.`
          : undefined
      }
    >
      <SliceState
        isLoading={isLoading}
        isError={isError}
        isEmpty={!!data && pairs.length === 0}
        errorText="Список не загрузился. Это сбой связи."
        emptyText="Передач за этот период не было."
        onRetry={() => refetch()}
      />
      {pairs.map((p, i) => (
        <div className="quiet" key={i}>
          <span className="txt">
            {p.from.fullName}, {p.to.fullName}
          </span>
          <span className={p.frequent ? "chip crit" : "chip"}>
            {/* pluralizeRu — «22 раза», а не «22 раз»: склонение по последней цифре. */}
            {p.count} {pluralizeRu(p.count, ["раз", "раза", "раз"])}
          </span>
        </div>
      ))}
    </Slice>
  );
}

/* ──────────────────────────────── Экран ────────────────────────────────────── */

export function Oversight() {
  const can = useCan();
  const canView = can("dashboard.analytics");
  const { data: summary, isError: summaryError, refetch: refetchSummary } = useOversightSummary(canView);
  // Вкладки раздела «Команда» (перенос меню 15.09.2026) — тот же набор и та же
  // логика подписи, что в pages/Team.tsx / lib/navigation.ts.
  const { data: sectionCounters } = useCounters();

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Контроль руководителя</h1>
              <p className="sub">Раздел доступен только руководству.</p>
            </div>
          </div>
          <TeamTabs />
        </div>
      </div>
    );
  }

  const sellerMissing = summary ? summary.sellerPropertyMissingWarn + summary.sellerPropertyMissingCritical : undefined;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Контроль руководителя</h1>
            <p className="sub">
              Сводка по тому, что уже есть в CRM: просрочки, лимиты, зависшие горячие лиды, переводы и передачи. Это не
              уведомления, а списки: смотреть можно спокойно.
            </p>
          </div>
          <div className="acts">
            <button className="pill ghost" type="button" onClick={() => refetchSummary()}>
              Обновить сводку
            </button>
          </div>
        </div>

        <TeamTabs />

        {/* Десять плиток: ровно те же счётчики, что были и на десктопе, и на
            телефоне. Прочерк значит «цифра не пришла», а не ноль. Каждая
            плитка — это уже посчитанный срез ниже на этом же экране: onClick
            прокручивает к нему, а не уходит на выдуманный маршрут с фильтром. */}
        <div className="tiles">
          <StatTile
            label="Просроченных задач"
            value={summary?.overdueTasks ?? "—"}
            line="сроки обещаны клиентам"
            critical={!!summary?.overdueTasks}
            onClick={() => scrollToSlice("slice-overdue-tasks")}
            title="Список просроченных задач ниже на этом экране"
          />
          <StatTile
            label="Агентов у лимита"
            value={summary?.agentsAtLimit ?? "—"}
            line="лиды им не распределяются"
            onClick={() => scrollToSlice("slice-agents-at-limit")}
            title="Список агентов у лимита ниже на этом экране"
          />
          <StatTile
            label="Горячих без прогресса"
            value={summary?.staleHotClients ?? "—"}
            line="нет контакта больше 3 дней"
            onClick={() => scrollToSlice("slice-stalled-clients")}
            title="Высокий скоринг без прогресса — список ниже на этом экране"
          />
          <StatTile
            label="Тишина после показа"
            value={summary?.silentAfterShowing ?? "—"}
            line={summary ? `показ был больше ${summary.silentAfterShowingDays} дней назад` : ""}
            onClick={() => scrollToSlice("slice-silent-after-showing")}
            title="Список клиентов без контакта после показа ниже на этом экране"
          />
          <StatTile
            label="Отказ при скоринге"
            value={summary?.refusedHighScore ?? "—"}
            line={summary ? `за ${summary.recentWindowDays} дней, мимо службы безопасности` : ""}
            onClick={() => scrollToSlice("slice-refused-high-score")}
            title="Список отказов при хорошем скоринге ниже на этом экране"
          />
          <StatTile
            label="Продавец без объекта"
            value={sellerMissing ?? "—"}
            line={
              summary
                ? `критично ${summary.sellerPropertyMissingCritical} (от ${summary.sellerPropertyMissingCriticalDays} дней, в службе безопасности), предупреждение ${summary.sellerPropertyMissingWarn} (от ${summary.sellerPropertyMissingWarnDays} дней)`
                : ""
            }
            onClick={() => scrollToSlice("slice-seller-property-missing")}
            title="Список продавцов без карточки объекта ниже на этом экране"
          />
          <StatTile
            label="Вечные переговоры"
            value={summary?.endlessNegotiations ?? "—"}
            line={summary ? `${summary.sellerNegotiationMaxRounds} кругов подряд и больше` : ""}
            onClick={() => scrollToSlice("slice-endless-negotiations")}
            title="Список карточек с зацикленными переговорами ниже на этом экране"
          />
          <StatTile
            label="Серия у агента"
            value={summary?.agentLossSeries ?? "—"}
            line={summary ? `${summary.agentLossSeriesThreshold} и больше за ${summary.agentLossSeriesWindowDays} дней` : ""}
            onClick={() => scrollToSlice("slice-agent-loss-series")}
            title="Список агентов с серией потерь ниже на этом экране"
          />
          <StatTile
            label="В «Неактивные»"
            value={summary?.recentInactive ?? "—"}
            line={summary ? `за ${summary.recentWindowDays} дней` : ""}
            onClick={() => scrollToSlice("slice-inactive-log")}
            title="Журнал переводов в «Неактивные» ниже на этом экране"
          />
          <StatTile
            label="Передач"
            value={summary?.recentTransfers ?? "—"}
            line={summary ? `за ${summary.recentWindowDays} дней` : ""}
            onClick={() => scrollToSlice("slice-transfers-log")}
            title="Журнал передач между агентами ниже на этом экране"
          />
        </div>

        {summaryError && (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" /> Итоги не загрузились. Прочерки в плитках это сбой связи, а не ноль.{" "}
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => refetchSummary()}
              >
                Повторить
              </button>
            </div>
          </div>
        )}

        <TrafficLightSummary />
        <OverdueTasks />
        <AgentsAtLimit />
        <StalledClients />
        <SilentAfterShowing />
        <SellerPropertyMissing />
        <EndlessNegotiations />
        <RefusedHighScore />
        <ShowingSurveyCalls />
        <AgentLossSeries />
        <InactiveLog />
        <TransfersLog />
        <TransferPairs />
      </div>
    </div>
  );
}
