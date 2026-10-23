import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Trash2, Receipt, CheckCircle2, ClipboardList, BarChart3 } from "lucide-react";
import { useCan } from "../lib/permissions";
import { useExpenseArchive, useRestoreExpense } from "../hooks/useFinance";
import {
  useProperties,
  usePropertyTrash,
  useRestoreProperty,
  usePermanentDeleteProperty,
} from "../hooks/useProperties";
import {
  useClients,
  useClientTrash,
  useRestoreClient,
  usePermanentDeleteClient,
} from "../hooks/useClients";
import { useAuditLog } from "../hooks/useAuditLog";
import {
  useApproveDeleteRequest,
  useApprovePropertyDeleteRequest,
  useApprovePropertyCountDispute,
  useDeleteRequests,
  usePropertyCountDisputes,
  usePropertyDeleteRequests,
  useRejectDeleteRequest,
  useRejectPropertyDeleteRequest,
  useRejectPropertyCountDispute,
} from "../hooks/useDeleteRequests";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { EXPENSE_CATEGORY_LABELS } from "@royal-home/shared";
import { formatMoney, relativeTime } from "../lib/format";
// Подписи и разбор записей аудита живут в lib/audit.ts.
import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, auditEntityLink, auditEntityName } from "../lib/audit";
import { VoiceNotePlayer } from "../components/VoiceNotePlayer";
import { initials } from "../lib/theme2026Person";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { Pagination } from "../components/Pagination";
import { SettingsTabs } from "../components/SectionTabs";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { Rh2EmptyState } from "../components/rh2/Rh2EmptyState";
import { PropertyChangeRequestsInbox } from "../components/PropertyChangeRequestsInbox";

/**
 * «Архив и корзина».
 *
 * ОБЛИК: дословный перенос утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/archive.html). Классы прототипные (`.scr`,
 * `.pg-h`, `.quiet`, `.bins`, `.card`, `.sec-h.stack`, `.list`/`.row`,
 * `.pill`/`.chip`, `.trio`, `.filters`/`.field`/`.inp`, `.pager`, `.sheet`),
 * экран включает эталон обёрткой `<div className="rh2 screens">`, стили из
 * apps/web/src/theme-2026-proto.css.
 *
 * ОДИН ЭКРАН НА ОБЕ ШИРИНЫ. Прежде рядом жил `components/mobile/MobileArchive.tsx`
 * — те же шесть запросов, те же данные, только другая вёрстка; своей логики у
 * него не было. Прототип сам умеет узкую раскладку: `.bins` становится
 * колонкой, `.row` переносит действия на свою строку, `.only-wide` прячет
 * второстепенные подписи. Файл удалён, разметка живёт здесь.
 *
 * ЧТО СОХРАНЕНО СВЕРХ ПРОТОТИПА (в прототипе нарисовано не всё, что умеет
 * раздел; перечислено в docs/pult/theme-2026/reports/port-archive.md):
 *  · заявки на удаление ОБЪЕКТОВ (в прототипе одна очередь на оба вида);
 *  · голосовая заметка к заявке (VoiceNotePlayer);
 *  · подтверждение «Удалить навсегда» через ConfirmDialog;
 *  · списки проданных объектов и архивных клиентов;
 *  · пагинация обеих корзин и журнала действий;
 *  · разделение «список пуст» и «список не загрузился» во всех шести списках.
 */

/** Три корзины прототипа — они же переключатель того, какой список показан. */
type Bin = "properties" | "clients" | "expenses";

/**
 * Число на корзине (решение владельца 09.09.2026, docs/theme-2026-missing.md §7):
 * корзины остаются переключателем, но у переключателя дырка — пока не нажмёшь, не
 * знаешь, есть ли там что-то. Счётчик закрывает дырку, ничего не пряча.
 *
 * Берётся из уже загруженных данных экрана, второго запроса нет. Три состояния, а
 * не два: пусто пока идёт загрузка, «—» когда выдачи нет вовсе (нет права на
 * раздел или запрос отказал), и только при пришедших данных — само число. Ноль
 * вместо «—» был бы враньём: «корзина пуста» и «я не знаю, что в корзине» это
 * разные вещи, а решение по ним человек принимает одно и то же.
 */
function binCount(loading: boolean, value: number | undefined): string {
  if (loading) return "";
  return value === undefined ? "—" : String(value);
}

/** Плитка ведёт не по маршруту, а к разделу этого же экрана (владелец, 15.09.2026). */
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Шторка отказа по заявке (прототип: «Отказ по заявке: шторка, а не модалка.
 * Причина обязательна»). Одна на обе очереди: устройство у них одинаковое, а
 * две копии разъехались бы.
 */
function RejectSheet({
  title,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  title: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  // Общий корпус окон CRM, а не своя разметка: у ручной шторки не было ловушки
  // фокуса — Tab уходил в список под подложкой, а после закрытия фокус пропадал.
  return (
    <Rh2Sheet
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button className="pill ghost" type="button" onClick={onCancel}>
            Отмена
          </button>
          <button className="pill" type="button" disabled={!note.trim() || pending} onClick={() => onSubmit(note.trim())}>
            Отправить отказ
          </button>
        </>
      }
    >
      <p className="sub" style={{ fontSize: "var(--fs-14)", color: "var(--muted)" }}>
        Причину увидит агент, который просил удалить.
      </p>
      <div className={note.trim() ? "fld" : "fld bad"} style={{ marginTop: 16 }}>
        <span className="lab">Почему заявка отклонена</span>
        <textarea
          autoFocus
          rows={3}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Например: карточка не дубль, у клиента другой номер"
        />
        {/* Причина видимым текстом, а не подсказкой при наведении:
            выключенная кнопка без объяснения читается как «нет прав». */}
        <span className="msg">{error ?? "Без причины отказ не уйдёт."}</span>
      </div>
    </Rh2Sheet>
  );
}

/**
 * ЗАЯВКИ АГЕНТОВ НА УДАЛЕНИЕ КЛИЕНТА (владелец 30.08.2026).
 *
 * Живут в «Архиве», а не отдельным пунктом меню: это вход в Корзину, которая уже
 * на этой странице. Видит их тот, кто и удаляет сам, — право `clients.delete`.
 */
function DeleteRequestsQueue() {
  const can = useCan();
  const canDeleteClients = can("archive.view") && can("clients.delete");
  const { data, isLoading, isError, refetch } = useDeleteRequests(canDeleteClients);
  const requests = data?.items ?? [];
  const approveRequest = useApproveDeleteRequest();
  const rejectRequest = useRejectDeleteRequest();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function handleApprove(id: string) {
    setDecisionError(null);
    try {
      await approveRequest.mutateAsync({ id });
    } catch (err) {
      // Живой случай: у клиента есть незакрытая сделка — сервер отвечает 409,
      // и причину надо показать словами, а не молча оставить заявку на месте.
      setDecisionError(err instanceof Error ? err.message : "Не удалось удалить клиента");
    }
  }

  async function handleReject(id: string, note: string) {
    setDecisionError(null);
    try {
      await rejectRequest.mutateAsync({ id, decisionNote: note });
      setRejecting(null);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "Не удалось отклонить заявку");
    }
  }

  if (!canDeleteClients) return null;

  return (
    <section className="card" id="delete-requests">
      <div className="sec-h stack">
        <h2>Заявки на удаление от агентов</h2>
        <span className="note">Одобрение одной кнопкой, решение видно агенту сразу</span>
      </div>

      {decisionError && !rejecting && (
        <div className="state err">
          <span className="dot crit" />
          {decisionError}
        </div>
      )}

      {isLoading && (
        <div className="state">
          <span className="sk av" />
          <span className="sk w28" />
          <span className="sk w22" /> Загружаем заявки
        </div>
      )}

      {isError && (
        <Rh2ErrorState
          message="Не удалось загрузить очередь заявок. Это не значит, что заявок нет — попробуйте ещё раз."
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && requests.length === 0 && (
        <Rh2EmptyState icon={Trash2} title="Заявок на удаление клиентов нет." />
      )}

      {requests.length > 0 && (
        <div className="list">
          {requests.map((r) => (
            <div className="row" key={r.id}>
              <span className="av" style={{ background: "var(--pink)", color: "var(--pink-ink)" }}>
                {initials(r.client.fullName)}
              </span>
              <div className="t">
                <b>
                  <Link className="lk" to={`/clients/${r.client.shortId}`}>
                    {r.client.fullName}
                  </Link>
                </b>
                <span>
                  {r.reasonLabel}
                  {r.comment ? `. «${r.comment}»` : ""}
                  {r.requestedBy ? `. Просит ${r.requestedBy.fullName}` : ""}, {relativeTime(r.createdAt)}
                </span>
                {r.commentVoiceUrl && <VoiceNotePlayer url={r.commentVoiceUrl} className="h-8 max-w-[240px] mt-1" />}
              </div>
              <span className="meta only-wide">клиент</span>
              <div className="act">
                <button className="pill sm" type="button" disabled={approveRequest.isPending} onClick={() => void handleApprove(r.id)}>
                  Удалить в корзину
                </button>
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => {
                    setRejecting(r.id);
                    setDecisionError(null);
                  }}
                >
                  Отклонить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {rejecting && (
        <RejectSheet
          title="Отклонить заявку"
          pending={rejectRequest.isPending}
          error={decisionError}
          onCancel={() => {
            setRejecting(null);
            setDecisionError(null);
          }}
          onSubmit={(note) => void handleReject(rejecting, note)}
        />
      )}
    </section>
  );
}

/**
 * ЗАЯВКИ АГЕНТОВ НА ПЕРЕСМОТР ЧИСЛА ОБЪЕКТОВ (владелец 06.09.2026, разбор слепых
 * зон п.3) — третья очередь на этом экране, устроенная как две выше: агент не
 * может исправить число, которое услышал ИИ, он только предлагает своё и
 * объясняет почему; решает руководитель с правом `clients.merge` — тот же круг,
 * что уже разбирает споры о дублях клиентов.
 *
 * Почему рядом с заявками на удаление, а не на карточке клиента: руководитель
 * разбирает очередь, а не обходит карточки. Заявка, живущая только там, где её
 * подали, ждала бы, пока кто-нибудь случайно откроет ту карточку.
 */
function PropertyCountDisputesQueue() {
  const can = useCan();
  const canDecide = can("archive.view") && can("clients.merge");
  const { data, isLoading, isError, refetch } = usePropertyCountDisputes(canDecide);
  const requests = data?.items ?? [];
  const approveRequest = useApprovePropertyCountDispute();
  const rejectRequest = useRejectPropertyCountDispute();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function handleApprove(id: string) {
    setDecisionError(null);
    try {
      await approveRequest.mutateAsync({ id });
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "Не удалось принять число агента");
    }
  }

  async function handleReject(id: string, note: string) {
    setDecisionError(null);
    try {
      await rejectRequest.mutateAsync({ id, decisionNote: note });
      setRejecting(null);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "Не удалось отклонить заявку");
    }
  }

  if (!canDecide) return null;

  return (
    <section className="card" id="property-count-disputes">
      <div className="sec-h stack">
        <h2>Заявки на пересмотр числа объектов</h2>
        <span className="note">Число слышит ИИ из разговоров — менять его может только руководитель</span>
      </div>

      {decisionError && !rejecting && (
        <div className="state err">
          <span className="dot crit" />
          {decisionError}
        </div>
      )}

      {isLoading && (
        <div className="state">
          <span className="sk av" />
          <span className="sk w28" />
          <span className="sk w22" /> Загружаем заявки
        </div>
      )}

      {isError && (
        <Rh2ErrorState
          message="Не удалось загрузить очередь заявок. Это не значит, что заявок нет — попробуйте ещё раз."
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && requests.length === 0 && (
        <Rh2EmptyState icon={BarChart3} title="Споров о числе объектов нет." />
      )}

      {requests.length > 0 && (
        <div className="list">
          {requests.map((r) => (
            <div className="row" key={r.id}>
              <span className="av" style={{ background: "var(--blue)", color: "var(--blue-ink)" }}>
                {initials(r.client.fullName)}
              </span>
              <div className="t">
                <b>
                  <Link className="lk" to={`/clients/${r.client.shortId}`}>
                    {r.client.fullName}
                  </Link>
                </b>
                <span>
                  {r.role === "SELLER" ? "Продажа" : "Покупка"}: ИИ насчитал {r.aiCount}, агент предлагает {r.proposedCount}.
                  {` «${r.reason}»`}
                  {r.requestedBy ? `. Просит ${r.requestedBy.fullName}` : ""}, {relativeTime(r.createdAt)}
                </span>
              </div>
              <span className="chip only-wide">
                {r.aiCount} → {r.proposedCount}
              </span>
              <div className="act">
                {/* Подписи с ЧИСЛАМИ, а не «Принять число агента»/«Оставить число ИИ»:
                    два таких длинных ярлыка не помещаются в строку на телефоне
                    (замерено: 322 px на 271 доступных, строка уезжала вбок — `.act`
                    в прототипе не переносится). Числа короче слов и заодно
                    возвращают то, что прячет `only-wide`-чип на узком экране.
                    Полная формулировка остаётся в aria-label — для чтения вслух. */}
                <button
                  className="pill sm"
                  type="button"
                  disabled={approveRequest.isPending}
                  aria-label={`Принять число агента: ${r.proposedCount}`}
                  onClick={() => void handleApprove(r.id)}
                >
                  Принять {r.proposedCount}
                </button>
                <button
                  className="pill ghost sm"
                  type="button"
                  aria-label={`Оставить число ИИ: ${r.aiCount}`}
                  onClick={() => {
                    setRejecting(r.id);
                    setDecisionError(null);
                  }}
                >
                  Оставить {r.aiCount}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {rejecting && (
        <RejectSheet
          title="Оставить число ИИ"
          pending={rejectRequest.isPending}
          error={decisionError}
          onCancel={() => {
            setRejecting(null);
            setDecisionError(null);
          }}
          onSubmit={(note) => void handleReject(rejecting, note)}
        />
      )}
    </section>
  );
}

/**
 * ЗАЯВКИ АГЕНТОВ НА УДАЛЕНИЕ ОБЪЕКТА (31.08.2026) — зеркало очереди выше, то же
 * место и то же устройство, только для карточек объектов. Право `properties.delete`.
 */
function PropertyDeleteRequestsQueue() {
  const can = useCan();
  const canDeleteProperties = can("archive.view") && can("properties.delete");
  const { data, isLoading, isError, refetch } = usePropertyDeleteRequests(canDeleteProperties);
  const requests = data?.items ?? [];
  const approveRequest = useApprovePropertyDeleteRequest();
  const rejectRequest = useRejectPropertyDeleteRequest();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function handleApprove(id: string) {
    setDecisionError(null);
    try {
      await approveRequest.mutateAsync({ id });
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "Не удалось удалить объект");
    }
  }

  async function handleReject(id: string, note: string) {
    setDecisionError(null);
    try {
      await rejectRequest.mutateAsync({ id, decisionNote: note });
      setRejecting(null);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "Не удалось отклонить заявку");
    }
  }

  if (!canDeleteProperties) return null;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Заявки на удаление объектов от агентов</h2>
        <span className="note">Одобрение одной кнопкой, решение видно агенту сразу</span>
      </div>

      {decisionError && !rejecting && (
        <div className="state err">
          <span className="dot crit" />
          {decisionError}
        </div>
      )}

      {isLoading && (
        <div className="state">
          <span className="sk av" />
          <span className="sk w28" />
          <span className="sk w22" /> Загружаем заявки
        </div>
      )}

      {isError && (
        <Rh2ErrorState
          message="Не удалось загрузить очередь заявок. Это не значит, что заявок нет — попробуйте ещё раз."
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && requests.length === 0 && (
        <Rh2EmptyState icon={Trash2} title="Заявок на удаление объектов нет." />
      )}

      {requests.length > 0 && (
        <div className="list">
          {requests.map((r) => (
            <div className="row" key={r.id}>
              <span className="av" style={{ background: "var(--lime)", color: "var(--lime-ink)" }}>
                {initials(r.property.title)}
              </span>
              <div className="t">
                <b>
                  <Link className="lk" to={`/properties/${r.property.shortId}`}>
                    {r.property.title}
                  </Link>
                </b>
                <span>
                  {r.reasonLabel}
                  {r.comment ? `. «${r.comment}»` : ""}. {formatMoney(r.property.price, r.property.currency)}
                  {r.requestedBy ? `. Просит ${r.requestedBy.fullName}` : ""}, {relativeTime(r.createdAt)}
                </span>
                {r.commentVoiceUrl && <VoiceNotePlayer url={r.commentVoiceUrl} className="h-8 max-w-[240px] mt-1" />}
                {r.dossier && r.dossier.lines.length > 0 && (
                  <div className={`quiet${r.dossier.hasConcerns ? " warn" : ""}`} style={{ marginTop: 6 }}>
                    <span className={`dot${r.dossier.hasConcerns ? " warn" : ""}`} />
                    <span className="txt">{r.dossier.lines.join(" ")}</span>
                  </div>
                )}
              </div>
              <span className="meta only-wide">объект</span>
              <div className="act">
                <button className="pill sm" type="button" disabled={approveRequest.isPending} onClick={() => void handleApprove(r.id)}>
                  Удалить в корзину
                </button>
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => {
                    setRejecting(r.id);
                    setDecisionError(null);
                  }}
                >
                  Отклонить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {rejecting && (
        <RejectSheet
          title="Отклонить заявку"
          pending={rejectRequest.isPending}
          error={decisionError}
          onCancel={() => {
            setRejecting(null);
            setDecisionError(null);
          }}
          onSubmit={(note) => void handleReject(rejecting, note)}
        />
      )}
    </section>
  );
}

export function Archive() {
  const can = useCan();
  const canView = can("archive.view");
  const canPurgeProperties = can("properties.purge");
  const canPurgeClients = can("clients.purge");
  const canDeleteClients = can("clients.delete");
  const canDeleteProperties = can("properties.delete");

  const [bin, setBin] = useState<Bin>("properties");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Все запросы раздела ждут права на сам раздел: без этого шесть запросов
  // уходили в 403 и повторялись каждые 25 секунд глобальным опросом.
  const {
    data: deletedExpenses,
    isLoading: expensesLoading,
    isError: expensesError,
    refetch: refetchExpensesTrash,
  } = useExpenseArchive({ from: from || undefined, to: to || undefined }, canView && can("finance.view"));
  const restoreExpense = useRestoreExpense();

  /**
   * «Проданные» и «Архивные клиенты» — лентой с «Показать ещё» (02.10.2026).
   * Раньше приезжала только первая страница из двадцати, а плитка над ними
   * показывала полное число: «57 проданных» и двадцать строк без продолжения.
   */
  const [soldPage, setSoldPage] = useState(1);
  const [archivedPage, setArchivedPage] = useState(1);
  const {
    data: soldProperties,
    isFetching: soldFetching,
    isLoading: soldLoading,
    isError: soldError,
    refetch: refetchSold,
  } = useProperties({ status: "SOLD", page: soldPage }, canView);
  const { data: soldHead } = useProperties({ status: "SOLD", page: 1 }, canView && soldPage > 1);
  const soldItems = useAccumulatedPages(soldProperties?.items, soldPage, null, soldHead?.items);
  const {
    data: archivedClients,
    isFetching: archivedFetching,
    isLoading: archivedLoading,
    isError: archivedError,
    refetch: refetchArchivedClients,
  } = useClients({ status: "ARCHIVED", page: archivedPage }, canView);
  const { data: archivedHead } = useClients({ status: "ARCHIVED", page: 1 }, canView && archivedPage > 1);
  const archivedItems = useAccumulatedPages(archivedClients?.items, archivedPage, null, archivedHead?.items);

  const [auditPage, setAuditPage] = useState(1);
  const {
    data: auditLog,
    isFetching: auditFetching,
    isLoading: auditLoading,
    isError: auditError,
    refetch: refetchAuditLog,
  } = useAuditLog(auditPage, canView && can("auditLog.view"));
  // Свежая первая страница, пока пролистано дальше неё (аудит №38,
  // useAccumulatedPages): без неё новые записи журнала не появлялись наверху.
  const { data: auditHead } = useAuditLog(1, canView && can("auditLog.view") && auditPage > 1);
  const auditItems = useAccumulatedPages(auditLog?.items, auditPage, null, auditHead?.items);

  const [propertyPage, setPropertyPage] = useState(1);
  const [clientPage, setClientPage] = useState(1);
  const {
    data: propertyTrashPage,
    isFetching: propertyTrashFetching,
    isLoading: propertyTrashLoading,
    isError: propertyTrashError,
    refetch: refetchPropertyTrash,
  } = usePropertyTrash(propertyPage, canView);
  // Мягкая подгрузка вместо страниц (решение владельца 15.09.2026): у корзины
  // нет своих фильтров — сбрасывать накопленное нечем, кроме роста страницы.
  const { data: propertyTrashHead } = usePropertyTrash(1, canView && propertyPage > 1);
  /**
   * Восстановленные и стёртые навсегда — прячем из ленты сразу (02.10.2026).
   * После действия перечитываются только открытая и первая страницы; средние
   * накопленные остаются прежними, и строка висела бы до ухода с экрана.
   * Идентификаторы уникальны во всех таблицах, поэтому набор один на обе корзины.
   */
  const [goneIds, setGoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const markGone = (id: string) => setGoneIds((prev) => new Set(prev).add(id));
  const propertyTrashAll = useAccumulatedPages(propertyTrashPage?.items, propertyPage, null, propertyTrashHead?.items);
  const propertyTrash = useMemo(() => propertyTrashAll.filter((p) => !goneIds.has(p.id)), [propertyTrashAll, goneIds]);
  const propertyTrashTotal = propertyTrashPage?.total ?? 0;
  const restoreProperty = useRestoreProperty();
  const permanentDeleteProperty = usePermanentDeleteProperty();

  const {
    data: clientTrashPage,
    isFetching: clientTrashFetching,
    isLoading: clientTrashLoading,
    isError: clientTrashError,
    refetch: refetchClientTrash,
  } = useClientTrash(clientPage, canView);
  const { data: clientTrashHead } = useClientTrash(1, canView && clientPage > 1);
  const clientTrashAll = useAccumulatedPages(clientTrashPage?.items, clientPage, null, clientTrashHead?.items);
  const clientTrash = useMemo(() => clientTrashAll.filter((c) => !goneIds.has(c.id)), [clientTrashAll, goneIds]);
  const clientTrashTotal = clientTrashPage?.total ?? 0;
  const restoreClient = useRestoreClient();
  const permanentDeleteClient = usePermanentDeleteClient();

  // Тихая строка наверху: сколько заявок ждёт решения. Считается по тем же
  // очередям, что и разделы ниже, второго запроса нет.
  const { data: clientRequests } = useDeleteRequests(canView && canDeleteClients);
  const { data: propertyRequests } = usePropertyDeleteRequests(canView && canDeleteProperties);
  const pendingRequests = (clientRequests?.items.length ?? 0) + (propertyRequests?.items.length ?? 0);

  const [confirmPurge, setConfirmPurge] = useState<{ kind: "property" | "client"; id: string; name: string } | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  async function handlePurgeConfirm() {
    if (!confirmPurge) return;
    setPurgeError(null);
    try {
      if (confirmPurge.kind === "property") await permanentDeleteProperty.mutateAsync(confirmPurge.id);
      else await permanentDeleteClient.mutateAsync(confirmPurge.id);
      markGone(confirmPurge.id);
      setConfirmPurge(null);
    } catch (err) {
      setPurgeError(err instanceof Error ? err.message : "Не удалось удалить навсегда");
      setConfirmPurge(null);
    }
  }

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Архив и корзина</h1>
              <p className="sub">Раздел доступен только директору и администратору.</p>
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
            <h1>Архив и корзина</h1>
            {/* На странице два похожих на вид раздела, и разницу между ними надо
                назвать словами: «архив» и «корзина» звучат синонимами, а ведут
                себя по-разному. */}
            <p className="sub">
              Архив: то, что отработало само. Корзина: то, что удалил человек, оттуда можно вернуть. Физически ничего
              не пропадает, пока не сотрут из корзины.
            </p>
          </div>
        </div>

        <SettingsTabs />

        {/* Срочное тихой строкой, а не карточкой-уведомлением (правило владельца §1). */}
        {(pendingRequests > 0 || purgeError) && (
          <div className="card tight">
            {pendingRequests > 0 && (
              <div className="quiet warn">
                <span className="dot warn" />
                <span className="txt">
                  {pendingRequests === 1 ? "Одна заявка на удаление ждёт" : `Заявок на удаление ждёт решения: ${pendingRequests}`}.
                </span>
                <a className="lnk" href="#delete-requests">
                  Посмотреть
                </a>
              </div>
            )}
            {purgeError && (
              <div className="quiet crit">
                <span className="dot crit" />
                <span className="txt">{purgeError}</span>
              </div>
            )}
          </div>
        )}

        {/* Три корзины: они же переключатель того, какой список показан ниже. */}
        <div className="bins" role="group" aria-label="Что показывать" id="bins-section">
          <button
            type="button"
            aria-pressed={bin === "properties"}
            onClick={() => (bin === "properties" ? refetchPropertyTrash() : setBin("properties"))}
          >
            <span className="hd">
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="17" rx="3" />
                <path d="M3 9h18" />
              </svg>
              Объекты
            </span>
            <b>{binCount(propertyTrashLoading, propertyTrashPage?.total)}</b>
            <small>в корзине объектов</small>
          </button>
          <button
            type="button"
            aria-pressed={bin === "clients"}
            onClick={() => (bin === "clients" ? refetchClientTrash() : setBin("clients"))}
          >
            <span className="hd">
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
              Клиенты
            </span>
            <b>{binCount(clientTrashLoading, clientTrashPage?.total)}</b>
            <small>в корзине клиентов</small>
          </button>
          <button
            type="button"
            aria-pressed={bin === "expenses"}
            onClick={() => (bin === "expenses" ? refetchExpensesTrash() : setBin("expenses"))}
          >
            <span className="hd">
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h18v12H3z" />
                <path d="M3 11h18" />
              </svg>
              Расходы
            </span>
            {/* У расходов постраничной выдачи нет: сервер отдаёт весь список за
                период, поэтому число это его длина, а не `total`. Без права
                `finance.view` запрос не уходит вовсе и здесь честное «—». */}
            <b>{binCount(expensesLoading, deletedExpenses?.length)}</b>
            <small>за выбранный период</small>
          </button>
        </div>

        <DeleteRequestsQueue />
        <PropertyDeleteRequestsQueue />
        <PropertyChangeRequestsInbox />
        <PropertyCountDisputesQueue />

        {bin === "properties" && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Корзина: объекты</h2>
              <span className="note">Вернуть можно всегда, стереть навсегда нельзя отменить</span>
            </div>

            {propertyTrashLoading && (
              <div className="state">
                <span className="sk av" />
                <span className="sk w28" />
                <span className="sk w22" /> Загружаем корзину
              </div>
            )}

            {propertyTrashError && (
              <Rh2ErrorState
                message="Не удалось загрузить корзину объектов. Она не пустая, просто пока не загрузилась — попробуйте ещё раз."
                onRetry={() => refetchPropertyTrash()}
              />
            )}

            {!propertyTrashLoading && !propertyTrashError && propertyTrash?.length === 0 && (
              <Rh2EmptyState icon={Trash2} title="Корзина объектов пуста." />
            )}

            {propertyTrash && propertyTrash.length > 0 && (
              <div className="list">
                {propertyTrash.map((p) => (
                  <div className="row" key={p.id}>
                    {/* Превью: решать «восстановить или стереть навсегда» вслепую
                        нельзя, вспомнить объект по названию нечем. */}
                    <span className="av" style={{ background: "var(--track)", color: "var(--muted)", overflow: "hidden" }}>
                      {p.photos?.[0] ? (
                        <img
                          src={p.photos[0].thumbUrl}
                          alt=""
                          loading="lazy"
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="5" width="18" height="14" rx="3" />
                          <circle cx="9" cy="10" r="2" />
                          <path d="m5 18 5-5 4 4 2-2 3 3" />
                        </svg>
                      )}
                    </span>
                    <div className="t">
                      <b>
                        <Link className="lk" to={`/properties/${p.shortId}`}>
                          {p.title}
                        </Link>
                      </b>
                      <span>
                        {formatMoney(p.price, p.currency)}
                        {p.deletedBy ? `. Удалил ${p.deletedBy.fullName}` : ""}
                        {p.deletedAt ? `, ${relativeTime(p.deletedAt)}` : ""}
                      </span>
                    </div>
                    <div className="act">
                      <button
                        className="pill ghost sm"
                        type="button"
                        disabled={restoreProperty.isPending}
                        onClick={() => restoreProperty.mutate(p.id, { onSuccess: () => markGone(p.id) })}
                      >
                        Восстановить
                      </button>
                      {canPurgeProperties && (
                        <button
                          className="pill ghost sm"
                          type="button"
                          onClick={() => setConfirmPurge({ kind: "property", id: p.id, name: p.title })}
                        >
                          Стереть навсегда
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="quiet" style={{ marginTop: 12 }}>
              <span className="dot" />
              <span className="txt">Фотографии и видео стираются вместе с карточкой. Отменить это нельзя.</span>
            </div>

            {propertyTrashPage && (
              <Pagination
                variant="loadMore"
                loading={propertyTrashFetching}
                page={propertyPage}
                pageSize={propertyTrashPage.pageSize}
                total={propertyTrashTotal}
                onPageChange={setPropertyPage}
              />
            )}
          </section>
        )}

        {bin === "clients" && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Корзина: клиенты</h2>
              <span className="note">Вернуть можно всегда, стереть навсегда нельзя отменить</span>
            </div>

            {clientTrashLoading && (
              <div className="state">
                <span className="sk av" />
                <span className="sk w28" />
                <span className="sk w22" /> Загружаем корзину
              </div>
            )}

            {clientTrashError && (
              <Rh2ErrorState
                message="Не удалось загрузить корзину клиентов. Удалённые карточки на месте — попробуйте ещё раз."
                onRetry={() => refetchClientTrash()}
              />
            )}

            {!clientTrashLoading && !clientTrashError && clientTrash?.length === 0 && (
              <Rh2EmptyState icon={Trash2} title="Корзина клиентов пуста." />
            )}

            {clientTrash && clientTrash.length > 0 && (
              <div className="list">
                {clientTrash.map((c) => (
                  <div className="row" key={c.id}>
                    <span className="av" style={{ background: "var(--track)", color: "var(--muted)" }}>
                      {initials(c.fullName)}
                    </span>
                    <div className="t">
                      <b>
                        <Link className="lk" to={`/clients/${c.shortId}`}>
                          {c.fullName}
                        </Link>
                      </b>
                      <span>
                        {c.phone}
                        {c.deletedBy ? `. Удалил ${c.deletedBy.fullName}` : ""}
                        {c.deletedAt ? `, ${relativeTime(c.deletedAt)}` : ""}
                      </span>
                    </div>
                    <div className="act">
                      <button
                        className="pill ghost sm"
                        type="button"
                        disabled={restoreClient.isPending}
                        onClick={() => restoreClient.mutate(c.id, { onSuccess: () => markGone(c.id) })}
                      >
                        Восстановить
                      </button>
                      {canPurgeClients && (
                        <button
                          className="pill ghost sm"
                          type="button"
                          onClick={() => setConfirmPurge({ kind: "client", id: c.id, name: c.fullName })}
                        >
                          Стереть навсегда
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {clientTrashPage && (
              <Pagination
                variant="loadMore"
                loading={clientTrashFetching}
                page={clientPage}
                pageSize={clientTrashPage.pageSize}
                total={clientTrashTotal}
                onPageChange={setClientPage}
              />
            )}
          </section>
        )}

        {bin === "expenses" && (
          <section className="card">
            <div className="sec-h stack">
              <h2>Удалённые расходы</h2>
              <span className="note">Восстановить можно любой</span>
            </div>

            <div className="filters">
              <label className="field">
                <span className="lab">Период с</span>
                <input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="field">
                <span className="lab">по</span>
                <input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <span className="spacer" />
              <span className="note" style={{ fontSize: "var(--fs-13)", color: "var(--faint)" }}>
                {deletedExpenses ? `Показаны ${deletedExpenses.length}` : ""}
              </span>
            </div>

            {expensesLoading && (
              <div className="state">
                <span className="sk w28" />
                <span className="sk w22" /> Загружаем расходы
              </div>
            )}

            {/* Честная причина (26.08.2026): без права запрос вообще не уходит
                (enabled=false), так что isError здесь — отказ сети или сервера. */}
            {expensesError && (
              <Rh2ErrorState
                message="Не удалось загрузить удалённые расходы. Попробуйте ещё раз."
                onRetry={() => refetchExpensesTrash()}
              />
            )}

            {!expensesLoading && !expensesError && deletedExpenses?.length === 0 && (
              <Rh2EmptyState
                icon={Receipt}
                title={from || to ? "За выбранный период ничего не удалено." : "Удалённых расходов нет."}
              />
            )}

            {deletedExpenses && deletedExpenses.length > 0 && (
              <div className="list" style={{ marginTop: 8 }}>
                {deletedExpenses.map((e) => (
                  <div className="row" key={e.id}>
                    <div className="t">
                      <b>
                        {EXPENSE_CATEGORY_LABELS[e.category]}, {formatMoney(e.amount, e.currency)}
                      </b>
                      <span>
                        {e.note ?? "без заметки"}
                        {e.agent ? `, ${e.agent.fullName}` : ""}
                        {e.deletedAt ? `. Удалено ${relativeTime(e.deletedAt)}` : ""}
                      </span>
                    </div>
                    <div className="act">
                      <button
                        className="pill ghost sm"
                        type="button"
                        disabled={restoreExpense.isPending}
                        onClick={() => restoreExpense.mutate(e.id)}
                      >
                        Восстановить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ============ Архив: отработало само ============ */}
        <section className="card">
          <div className="sec-h stack">
            <h2>Архив</h2>
            <span className="note">Проданные объекты, закрытые клиенты, скрытые расходы</span>
          </div>
          <div className="trio">
            {/* Плитки ведут не по маршруту: markup `.trio .n` (b + span) — свой,
                отдельный от эталонной StatTile (`.hd`/`b`/`small`), поэтому кликабельным
                делаем сам тег, а класс `n` не трогаем (владелец, 15.09.2026). */}
            <button type="button" className="n" onClick={() => scrollToSection("sold-properties-section")} title="Проданные объекты — список ниже">
              <b>{soldProperties?.total ?? "—"}</b>
              <span>проданных объектов</span>
            </button>
            <button type="button" className="n" onClick={() => scrollToSection("archived-clients-section")} title="Архивные клиенты — список ниже">
              <b>{archivedClients?.total ?? "—"}</b>
              <span>архивных клиентов</span>
            </button>
            <button
              type="button"
              className="n"
              onClick={() => {
                setBin("expenses");
                scrollToSection("bins-section");
              }}
              title="Открыть корзину «Расходы»"
            >
              <b>{deletedExpenses?.length ?? "—"}</b>
              <span>удалённых расходов</span>
            </button>
          </div>

          <div className="sec-t" id="sold-properties-section">Проданные объекты</div>
          {soldLoading && (
            <div className="state">
              <span className="sk w28" />
              <span className="sk w22" /> Загружаем проданные
            </div>
          )}
          {soldError && (
            <Rh2ErrorState
              message="Не удалось загрузить список проданных. Попробуйте ещё раз."
              onRetry={() => refetchSold()}
            />
          )}
          {!soldLoading && !soldError && soldProperties?.items.length === 0 && (
            <Rh2EmptyState icon={CheckCircle2} title="Проданных объектов нет." />
          )}
          {soldItems.length > 0 && (
            <div className="list">
              {soldItems.map((p) => (
                <div className="row" key={p.id}>
                  <div className="t">
                    <b>
                      <Link className="lk" to={`/properties/${p.shortId}`}>
                        {p.title}
                      </Link>
                    </b>
                  </div>
                  <span className="meta">{formatMoney(p.price, p.currency)}</span>
                </div>
              ))}
            </div>
          )}
          {soldProperties && (
            <Pagination
              variant="loadMore"
              loading={soldFetching}
              page={soldPage}
              pageSize={soldProperties.pageSize}
              total={soldProperties.total}
              onPageChange={setSoldPage}
            />
          )}

          <div className="sec-t" id="archived-clients-section">Архивные клиенты</div>
          {archivedLoading && (
            <div className="state">
              <span className="sk w28" />
              <span className="sk w22" /> Загружаем архивных клиентов
            </div>
          )}
          {archivedError && (
            <Rh2ErrorState
              message="Не удалось загрузить архивных клиентов. Попробуйте ещё раз."
              onRetry={() => refetchArchivedClients()}
            />
          )}
          {!archivedLoading && !archivedError && archivedClients?.items.length === 0 && (
            <Rh2EmptyState icon={CheckCircle2} title="Архивных клиентов нет." />
          )}
          {archivedItems.length > 0 && (
            <div className="list">
              {archivedItems.map((c) => (
                <div className="row" key={c.id}>
                  <div className="t">
                    <b>
                      <Link className="lk" to={`/clients/${c.shortId}`}>
                        {c.fullName}
                      </Link>
                    </b>
                  </div>
                  <span className="meta">{c.phone}</span>
                </div>
              ))}
            </div>
          )}
          {archivedClients && (
            <Pagination
              variant="loadMore"
              loading={archivedFetching}
              page={archivedPage}
              pageSize={archivedClients.pageSize}
              total={archivedClients.total}
              onPageChange={setArchivedPage}
            />
          )}
        </section>

        {/* ============ История действий ============ */}
        <section className="card">
          <div className="sec-h stack">
            <h2>История действий</h2>
            <span className="note">Журнал не чистится никогда</span>
          </div>

          {auditLoading && (
            <div className="state">
              <span className="sk w40" />
              <span className="sk w22" /> Загружаем журнал
            </div>
          )}

          {/* Без права запрос не уходит вовсе — isError означает отказ сети или
              сервера, а не отсутствие права (26.08.2026). */}
          {auditError && (
            <Rh2ErrorState
              message="Не удалось загрузить историю действий. Попробуйте ещё раз."
              onRetry={() => refetchAuditLog()}
            />
          )}

          {!auditLoading && !auditError && auditLog?.items.length === 0 && (
            <Rh2EmptyState icon={ClipboardList} title="Записей пока нет." />
          )}

          {auditLog && auditItems.length > 0 && (
            <div className="list">
              {auditItems.map((entry) => {
                const name = auditEntityName(entry.meta);
                const link = auditEntityLink(entry.entityType, entry.meta);
                return (
                  <div className="row" key={entry.id}>
                    <div className="t">
                      <b>
                        {entry.agentName}, {(AUDIT_ACTION_LABELS[entry.action] ?? entry.action).toLowerCase()}:{" "}
                        {AUDIT_ENTITY_LABELS[entry.entityType] ?? entry.entityType}
                      </b>
                      <span>
                        {name && link ? (
                          <Link className="lk mut" to={link}>
                            {name}
                          </Link>
                        ) : (
                          name
                        )}
                        {entry.meta && typeof entry.meta === "object" && "amount" in entry.meta
                          ? `, ${String((entry.meta as Record<string, unknown>).amount)}`
                          : ""}
                      </span>
                    </div>
                    <span className="meta only-wide">{relativeTime(entry.createdAt)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {auditLog && (
            <Pagination loading={auditFetching} variant="loadMore" page={auditPage} pageSize={auditLog.pageSize} total={auditLog.total} onPageChange={setAuditPage} />
          )}
        </section>
      </div>

      {confirmPurge && (
        <ConfirmDialog
          title="Удалить навсегда?"
          description={`«${confirmPurge.name}» будет стёрт из базы без возможности восстановления. Фото и файлы тоже удалятся. Отменить нельзя.`}
          confirmLabel="Удалить навсегда"
          danger
          onConfirm={handlePurgeConfirm}
          onCancel={() => setConfirmPurge(null)}
        />
      )}
    </div>
  );
}
