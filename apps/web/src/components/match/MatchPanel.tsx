import { useRef, useState, type ReactNode } from "react";
import { useAssignClientToAgent, useClientMatch, useSendProperties, useSendTarget } from "../../hooks/useClients";
import { useDistricts } from "../../hooks/useDistricts";
import { useMatchingClients, useProperties, type PropertyFilters } from "../../hooks/useProperties";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useSendPropertyConfirm } from "../../hooks/useSendPropertyConfirm";
import { useSmsShareProperty, useSmsStatus, type SmsShareResult } from "../../hooks/useSms";
import { useCan, useIsReadOnly } from "../../lib/permissions";
import { formatMoney, PROPERTY_TYPE_LABELS } from "../../lib/format";
import { AddInteractionModal } from "../AddInteractionModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { SendFallback, SendTargetNote, sendFallbackOf, targetReady } from "./SendFallback";
import { useMobileUx } from "../../hooks/useMobileUx";
import { useCleanShell } from "../../hooks/useCleanShell";
import type { SendPropertiesFallback } from "@royal-home/shared";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { MatchPropertyCard } from "./MatchPropertyCard";
import { MatchClientCard } from "./MatchClientCard";
import { bookedShowingsByProperty } from "../../lib/clientFormat";
import type { Client, Property } from "../../types";

/**
 * ОДНА ФУНКЦИЯ «ПОДБОР» (владелец, 17.09.2026 вечер, `docs/match-policy-plan-17-09.md`
 * §6): раньше подбор был растащен по трём местам — модальное окно клиента
 * (`MatchPropertiesModal.tsx`), карточка «Кому подойдёт» на объекте
 * (`MatchingClientsCard.tsx`) и свой список в кнопке-здании чата
 * (`ChatPropertySend.tsx`). Три реализации одного и того же расходились в
 * деталях (какая кнопка отправляет, что показано при пустом списке) и втрое
 * дороже правились. Теперь один компонент с двумя режимами: `client` — что
 * подходит этому покупателю, `property` — кто ждёт этот объект.
 *
 * ОБОЛОЧКА. `variant="modal"` (по умолчанию) — та же широкая шторка
 * `Rh2Sheet`, что была у прежнего `MatchPropertiesModal`: на ПК окно по
 * центру, на телефоне снизу — переключение уже внутри `Rh2Sheet`
 * (`useMobileUx`), здесь ничего решать не нужно. `variant="inline"` — без
 * шторки, только карточка `.card` с заголовком: для вкладки «Клиенты» на
 * карточке объекта, где панель и так встроена в раздел страницы.
 */
export type MatchPanelProps =
  | {
      mode: "client";
      client: Client;
      readOnly?: boolean;
      open: boolean;
      onClose: () => void;
      /** Композер чата закрывает панель сразу после отправки; карточка клиента
       *  оставляет её открытой (агент может отправить ещё). */
      onSent?: () => void;
      variant?: "modal" | "inline";
      /** Панель открыта из композера полноэкранного мобильного чата — её шторку
       *  и диалог подтверждения внутри надо поднять над чатом (z-index 45),
       *  иначе они уезжают под него и кнопка выглядит мёртвой. См. Rh2Sheet. */
      layer?: "above-chat";
      /** Диалог, из которого открыли панель (id инбокса). Объект уходит именно
       *  туда, а не в «последний» диалог клиента (28.09.2026). */
      conversationId?: string;
    }
  | {
      mode: "property";
      property: Property;
      open: boolean;
      onClose: () => void;
      variant?: "modal" | "inline";
    };

const MAX_TO_SEND = 5;

/** Канал словами — для строки «Объект отправлен в WhatsApp». */
const CHANNEL_WORD: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  TELEGRAM: "Telegram",
  WEBSITE: "чат на сайте",
};

function pluralObjects(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "объект";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "объекта";
  return "объектов";
}

export function MatchPanel(props: MatchPanelProps) {
  return props.mode === "client" ? <ClientMatchPanel {...props} /> : <PropertyMatchPanel {...props} />;
}

/** Оболочка — шторка или голая карточка, в зависимости от `variant`. Открытие/
 *  закрытие модалки решает сам `Rh2Sheet` (Esc, клик мимо, свайп на телефоне). */
function PanelShell({
  variant,
  open,
  title,
  sub,
  onClose,
  footer,
  children,
  layer,
}: {
  variant: "modal" | "inline";
  open: boolean;
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  layer?: "above-chat";
}) {
  if (variant === "inline") {
    return (
      <div className="card">
        <div className="sec-h stack">
          <h2>{title}</h2>
        </div>
        {sub}
        {children}
      </div>
    );
  }
  return (
    <Rh2Sheet title={title} wide open={open} onClose={onClose} footer={footer} layer={layer}>
      {sub}
      {children}
    </Rh2Sheet>
  );
}

/** Метры до желаемого места клиента — как в `MatchPropertyCard`, но заголовок
 *  окна такой строкой не пестрит: это только для короткой строки объекта. */
function shortPropertyLine(p: Property): string {
  return `№${p.shortId} · ${p.title} · ${formatMoney(p.price, p.currency)}`;
}

/**
 * Режим клиента: что подходит этому покупателю.
 *
 * Перенесено из `MatchPropertiesModal.tsx` (файл удалён) почти дословно — тот
 * же приём отправки, та же обработка ошибки с пометкой в хронологии, тот же
 * учёт уже назначенных показов. Отличия: переключатель режимов «ai/manual»
 * переименован во внутренний `source` («Подбор»/«Все объекты», те же чипы),
 * кнопка отправки — «В переписку» вместо «Предложить» (владелец: «сразу
 * отправлять в переписку»), и добавлены `score`/`distanceM` в строке объекта.
 */
function ClientMatchPanel({
  client,
  open,
  onClose,
  onSent,
  variant = "modal",
  layer,
  conversationId,
  readOnly: cardReadOnly = false,
}: Extract<MatchPanelProps, { mode: "client" }>) {
  const clean = useCleanShell();
  const accountReadOnly = useIsReadOnly();
  const readOnly = cardReadOnly || accountReadOnly;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [source, setSource] = useState<"match" | "catalog">("match");
  const [showingFor, setShowingFor] = useState<Property | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    fallback: SendPropertiesFallback | null;
    tone: "crit" | "warn";
  } | null>(null);
  const target = useSendTarget(client.id, conversationId, open && !readOnly);
  const deliveryUnavailable = !readOnly && clean && (target.isError || target.isLoading || !target.data);
  const deliveryUnavailableRef = useRef(deliveryUnavailable);
  deliveryUnavailableRef.current = deliveryUnavailable;
  const mobile = useMobileUx();

  // Отправка ссылок клиенту: до пяти объектов за раз — тот же лимит и та же
  // причина, что были у прежнего окна (длинную простыню ссылок читают по
  // диагонали, а мессенджеры её режут).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendResult, setSendResult] = useState<string | null>(null);
  const sendProperties = useSendProperties(client.id);
  const sendConfirm = useSendPropertyConfirm();

  function toggleSelected(id: string) {
    setSendResult(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_TO_SEND) next.add(id);
      return next;
    });
  }

  /**
   * ОДНА ОТПРАВКА на одиночную кнопку и на «Отправить выбранные» (28.09.2026):
   * раньше это были две функции с разными текстами и разной реакцией на отказ,
   * а отказ одиночной ещё и писал в хронологию «предложен» — после чего кнопка
   * навсегда превращалась в чип «Уже предлагали» и повторить было нельзя.
   */
  async function doSend(ids: string[]) {
    if (readOnlyRef.current) return;
    if (!checkDelivery()) return;
    setFailure(null);
    setSendResult(null);
    try {
      const result = await sendProperties.mutateAsync({ propertyIds: ids, conversationId });
      setJustOffered((prev) => new Set([...prev, ...ids]));
      setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      const where = result.channel ? ` в ${CHANNEL_WORD[result.channel] ?? result.channel}` : "";
      setSendResult(
        `${ids.length === 1 ? "Объект отправлен" : `Отправлено объектов: ${result.sent}`}${where}.` +
          (result.masked ? " Телефон в тексте скрыт маской." : " Бот замолчал, дальше переписку ведёте вы.")
      );
      onSent?.();
    } catch (err) {
      setFailure({
        message: err instanceof Error ? err.message : "Не удалось отправить",
        fallback: sendFallbackOf(err),
        tone: "crit",
      });
    }
  }

  /**
   * Мессенджер заведомо не пропустит (окно Meta закрыто, канал выключен,
   * клиент не писал) — не спрашиваем «клиент сразу получит…» и не делаем
   * провальную попытку: сразу готовим текст и ссылки для СМС/«Поделиться»
   * (28.09.2026, владелец: «на телефоне легко, всё отправляется корректно»).
   */
  async function doPrepare(ids: string[]) {
    if (readOnlyRef.current) return;
    if (!checkDelivery()) return;
    setFailure(null);
    setSendResult(null);
    try {
      const result = await sendProperties.mutateAsync({ propertyIds: ids, conversationId, prepareOnly: true });
      if (result.fallback) {
        setFailure({ message: target.data?.hint ?? "В мессенджер не уйдёт.", fallback: result.fallback, tone: "warn" });
      }
    } catch (err) {
      setFailure({ message: err instanceof Error ? err.message : "Не удалось подготовить ссылки", fallback: null, tone: "crit" });
    }
  }

  function send(ids: string[], title?: string) {
    if (readOnlyRef.current) return;
    if (ids.length === 0) return;
    if (!checkDelivery()) return;
    if (!targetReady(target.data)) {
      void doPrepare(ids);
      return;
    }
    sendConfirm.request(
      () => void doSend(ids),
      `Клиент ${client.fullName} сразу получит сообщение со ссылк${ids.length === 1 ? `ой${title ? ` на «${title}»` : ""}` : `ами на ${ids.length} ${pluralObjects(ids.length)}`}. ${target.data?.hint ?? "Сообщение уйдёт в тот мессенджер, откуда клиент писал."} Бот в этом диалоге после этого больше не отвечает — дальше переписку ведёте вы.`
    );
  }

  function checkDelivery() {
    if (!deliveryUnavailableRef.current) return true;
    setFailure({ message: "Сначала обновите статус канала отправки.", fallback: null, tone: "warn" });
    return false;
  }

  // Что уже отправляли — из хронологии карточки. Записи о НЕудачной отправке
  // («…ссылка не отправлена…», старый путь до 28.09.2026) не считаются: объект
  // до клиента не дошёл, и прятать от агента кнопку повтора нельзя.
  const [justOffered, setJustOffered] = useState<Set<string>>(new Set());
  const offered = new Set([
    ...(client.interactions ?? [])
      .filter((i) => !!i.propertyId && !(i.notes ?? "").includes("не отправлена"))
      .map((i) => i.propertyId as string),
    ...justOffered,
  ]);

  // Показы, уже назначенные этому клиенту (только будущие и действующие): отменённый
  // оставляет дату, но не должен прятать кнопку «Назначить показ» (LOCAL-ONLY-WEB02).
  const bookedShowings = bookedShowingsByProperty(client.interactions ?? []);

  // Требования клиента — стартовое положение фильтров каталога, не жёсткая рамка.
  const [filters, setFilters] = useState<PropertyFilters>({
    districtId: client.desiredDistrictId ?? undefined,
    rooms: client.desiredRooms ?? undefined,
    status: "AVAILABLE",
  });
  const debouncedQuery = useDebouncedValue(filters.q, 350);
  const debouncedAreaMin = useDebouncedValue(filters.areaMin, 350);
  const debouncedAreaMax = useDebouncedValue(filters.areaMax, 350);
  const { data: districts } = useDistricts();
  const matchQuery = useClientMatch(client.id);
  const catalogQuery = useProperties(
    { ...filters, q: debouncedQuery, areaMin: debouncedAreaMin, areaMax: debouncedAreaMax },
    open && source === "catalog"
  );

  const requirements = [
    client.desiredDistrict ? `Район: ${client.desiredDistrict.name}` : null,
    client.desiredRooms ? `Комнат: ${client.desiredRooms}` : null,
    client.budgetMin || client.budgetMax
      ? `Бюджет: ${[
          client.budgetMin ? formatMoney(client.budgetMin, client.currency) : null,
          client.budgetMax ? formatMoney(client.budgetMax, client.currency) : null,
        ]
          .filter(Boolean)
          .join(" до ")}`
      : null,
  ].filter(Boolean) as string[];

  const isLoading = source === "match" ? matchQuery.isLoading : catalogQuery.isLoading;
  const items: Property[] = source === "match" ? matchQuery.data?.properties ?? [] : catalogQuery.data?.items ?? [];
  const unfiltered = source === "match" && matchQuery.data?.unfiltered === true;
  const activeQuery = source === "match" ? matchQuery : catalogQuery;
  const loadFailed = activeQuery.isError;

  const title = `Подбор${matchQuery.data ? ` · ${matchQuery.data.total}` : ""}`;

  return (
    <>
      <PanelShell
        variant={variant}
        open={open}
        layer={layer}
        title={title}
        sub={
          <>
            {!readOnly && <SendTargetNote info={target.data} isLoading={target.isLoading} failed={clean && target.isError} retry={() => target.refetch()} />}
            {(requirements.length > 0 || client.requirementsNotes) && (
            <>
              <div className="filters">
                {requirements.map((r) => (
                  <span key={r} className="chip">
                    {r}
                  </span>
                ))}
              </div>
              {client.requirementsNotes && <p className="state">{client.requirementsNotes}</p>}
            </>
            )}
          </>
        }
        onClose={onClose}
        footer={
          !readOnly && selected.size > 0 ? (
            <>
              <span className="state">
                Выбрано: {selected.size} из {MAX_TO_SEND}
              </span>
              <button
                type="button"
                className="pill"
                onClick={() => send([...selected])}
                disabled={sendProperties.isPending || deliveryUnavailable}
                title="Отправить ссылки клиенту одним сообщением"
              >
                {sendProperties.isPending ? "Отправляю…" : `Отправить клиенту · ${selected.size}`}
              </button>
            </>
          ) : undefined
        }
      >
        {unfiltered && (
          <div className="filters" role="status">
            <span className="chip warn">
              Параметры клиента не заполнены — показаны все доступные объекты, а не подбор
            </span>
          </div>
        )}

        <div className="seg" style={{ marginTop: "var(--s3)" }}>
          <button type="button" aria-selected={source === "match"} onClick={() => setSource("match")}>
            Подбор
          </button>
          <button type="button" aria-selected={source === "catalog"} onClick={() => setSource("catalog")}>
            Все объекты
          </button>
        </div>

        {source === "match" && (
          <div className="quiet" style={{ marginTop: "var(--s2)" }}>
            <span className="dot" />
            <span className="txt">
              {items.some((p) => !!p.aiReason)
                ? "Порядок и пояснения — от ИИ по заметкам о требованиях"
                : "По требованиям клиента. Заполните заметки о требованиях — ИИ добавит пояснения"}
            </span>
          </div>
        )}

        {source === "catalog" && (
          /* На телефоне — поиск во всю ширину и сетка два в ряд (28.09.2026):
             раньше каждое поле занимало целую строку, и до первого объекта
             было пять полей. На ПК — прежний ряд. */
          <div
            className={mobile ? undefined : "filters"}
            style={
              mobile
                ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s2)", marginTop: "var(--s3)" }
                : { marginTop: "var(--s3)" }
            }
          >
            <select
              className="inp"
              style={mobile ? undefined : { maxWidth: "180px" }}
              value={filters.districtId ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, districtId: e.target.value || undefined, page: 1 }))}
              aria-label="Район"
            >
              <option value="">Район: все</option>
              {districts?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              className="inp"
              style={mobile ? undefined : { maxWidth: "160px" }}
              value={filters.rooms ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, rooms: e.target.value ? Number(e.target.value) : undefined, page: 1 }))}
              aria-label="Комнаты"
            >
              <option value="">Комнат: любое</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} комн.
                </option>
              ))}
            </select>
            <select
              className="inp"
              style={mobile ? undefined : { maxWidth: "180px" }}
              value={filters.type ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value || undefined, page: 1 }))}
              aria-label="Тип объекта"
            >
              <option value="">Тип: все</option>
              {Object.entries(PROPERTY_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              className="inp"
              style={mobile ? undefined : { maxWidth: "96px" }}
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="м² от"
              aria-label="Площадь от, м²"
              value={filters.areaMin ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, areaMin: e.target.value ? Number(e.target.value) : undefined, page: 1 }))}
            />
            <input
              className="inp"
              style={mobile ? undefined : { maxWidth: "96px" }}
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="м² до"
              aria-label="Площадь до, м²"
              value={filters.areaMax ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, areaMax: e.target.value ? Number(e.target.value) : undefined, page: 1 }))}
            />
            <input
              className="inp"
              type="search"
              enterKeyHint="search"
              style={mobile ? { gridColumn: "1 / -1", order: -1 } : undefined}
              value={filters.q ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value || undefined, page: 1 }))}
              placeholder="Поиск по названию, адресу…"
              aria-label="Поиск объектов"
            />
          </div>
        )}

        {isLoading && <p className="state">Подбор…</p>}

        {loadFailed && (
          <div className="empty">
            <p>{activeQuery.error instanceof Error ? activeQuery.error.message : "Не удалось загрузить объекты"}</p>
            <span className="sub">Это не значит, что подходящих объектов нет, список просто не пришёл.</span>
            <button type="button" className="pill ghost" onClick={() => activeQuery.refetch()}>
              Повторить
            </button>
          </div>
        )}

        {!isLoading && !loadFailed && items.length === 0 && (
          <div className="empty">
            {source === "match" ? (
              <>
                <p>Под требования клиента ничего не подошло.</p>
                <button type="button" className="pill ghost" onClick={() => setSource("catalog")}>
                  Посмотреть все объекты
                </button>
              </>
            ) : (
              <p>По этим фильтрам объектов нет, снимите часть условий</p>
            )}
          </div>
        )}

        {!readOnly && failure &&
          (failure.fallback ? (
            <SendFallback
              clientId={client.id}
              message={failure.message}
              fallback={failure.fallback}
              tone={failure.tone}
              smsAvailable={target.data?.smsAvailable ?? false}
              onDone={(ids) => setJustOffered((prev) => new Set([...prev, ...ids]))}
            />
          ) : (
            <p className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">{failure.message}</span>
            </p>
          ))}

        {sendResult && (
          <p className="quiet">
            <span className="dot ok" />
            <span className="txt">{sendResult}</span>
          </p>
        )}

        <div className="list">
          {items.map((p) => (
            <MatchPropertyCard
              key={p.id}
              property={p}
              selected={selected.has(p.id)}
              onToggleSelect={readOnly ? undefined : () => toggleSelected(p.id)}
              offered={offered.has(p.id)}
              onSend={readOnly ? undefined : () => send([p.id], p.title)}
              sending={sendProperties.isPending}
              sendDisabled={deliveryUnavailable}
              bookedShowingAt={bookedShowings.get(p.id) ?? null}
              onScheduleShowing={readOnly ? undefined : () => setShowingFor(p)}
              onClosePanel={variant === "modal" ? onClose : undefined}
            />
          ))}
        </div>
      </PanelShell>

      {/* Форма показа — соседом панели, а не внутри неё: подложка модалки
          закрывается по клику, и вложенная форма схлопывала бы панель при
          первом же клике по своим полям (перенесено дословно). */}
      {!readOnly && showingFor && (
        <AddInteractionModal
          clientId={client.id}
          initialType="SHOWING"
          initialPropertyId={showingFor.id}
          onClose={() => setShowingFor(null)}
          onSaved={() => setShowingFor(null)}
        />
      )}
      {!readOnly && sendConfirm.open && (
        <ConfirmDialog
          title="Отправить объект клиенту"
          description={sendConfirm.description}
          confirmLabel="Отправить"
          danger={false}
          onConfirm={sendConfirm.confirm}
          onCancel={sendConfirm.cancel}
          // Тот же слой, что у самой панели: вопрос задаётся ПОВЕРХ неё, а из
          // чата — ещё и поверх полноэкранного чата. Без этого на телефоне
          // первый (и единственный) вопрос был не виден, «Отправить» молча не
          // срабатывало, флаг «уже объяснили» не ставился — и так каждый раз.
          layer={layer}
        />
      )}
    </>
  );
}

/**
 * Режим объекта: кто ждёт этот объект.
 *
 * Перенесено из `MatchingClientsCard.tsx` (файл удалён). Раньше список
 * подгружался по нажатию «Показать» — здесь этой кнопки больше нет: сама
 * панель монтируется по требованию (модалка — по клику на «Подбор · N»,
 * вкладка «Клиенты» — только пока эта вкладка активна), так что повторной
 * ленивой загрузки поверх ленивого монтирования заводить незачем.
 */
function PropertyMatchPanel({
  property,
  open,
  onClose,
  variant = "modal",
}: Extract<MatchPanelProps, { mode: "property" }>) {
  const can = useCan();
  const readOnly = useIsReadOnly();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const responsibleAgent = property.assignedAgent ?? property.intakeAgent ?? null;
  const { data, isLoading, isError, error, refetch } = useMatchingClients(property.id, true);
  const assignClient = useAssignClientToAgent();
  const [givenIds, setGivenIds] = useState<Set<string>>(new Set());
  const [assignError, setAssignError] = useState<string | null>(null);

  async function handleGive(clientId: string) {
    if (readOnlyRef.current) return;
    if (!responsibleAgent) return;
    setAssignError(null);
    try {
      await assignClient.mutateAsync({ clientId, agentId: responsibleAgent.id });
      setGivenIds((prev) => new Set(prev).add(clientId));
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : "Не удалось передать клиента");
    }
  }

  const title = `Подбор${data ? ` · ${data.total}` : property.demandCount != null ? ` · ${property.demandCount}` : ""}`;

  return (
    <PanelShell
      variant={variant}
      open={open}
      title={title}
      sub={<p className="state">{shortPropertyLine(property)}</p>}
      onClose={onClose}
    >
      {isLoading && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Подбираем…</span>
        </div>
      )}
      {isError && (
        <div className="empty">
          <p>{error instanceof Error ? error.message : "Не удалось загрузить список"}</p>
          <button type="button" className="pill ghost" onClick={() => refetch()}>
            Повторить
          </button>
        </div>
      )}
      {assignError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{assignError}</span>
        </div>
      )}
      <div className="list">
        {data?.items.map((c) => {
          const alreadyGiven = givenIds.has(c.id);
          const canGive = !readOnly && can("clients.assign") && !!responsibleAgent && c.assignedAgentId !== responsibleAgent.id && !alreadyGiven;
          return (
            <MatchClientCard
              key={c.id}
              client={c}
              propertyId={property.id}
              propertyTitle={property.title}
              onGive={() => handleGive(c.id)}
              giving={assignClient.isPending}
              given={alreadyGiven}
              canGive={canGive}
              responsibleAgentName={responsibleAgent?.fullName}
              onClosePanel={variant === "modal" ? onClose : undefined}
            />
          );
        })}
      </div>
      {data && data.total > data.items.length && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Показаны {data.items.length} из {data.total} по совпадению
          </span>
        </div>
      )}
      {data && data.items.length > 0 && property.status !== "SOLD" && (
        <SmsShareRow propertyId={property.id} clientIds={data.items.map((c) => c.id)} />
      )}
      {!isLoading && data && data.items.length === 0 && (
        <div className="empty">
          <span className="ic">
            <svg className="i" viewBox="0 0 24 24">
              <path d="M16 19v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
            </svg>
          </span>
          <p>Подходящих клиентов в активной базе нет.</p>
          <p className="sub">Это не ошибка: у большинства карточек не заполнены бюджет и район, и подбор их не видит.</p>
        </div>
      )}
    </PanelShell>
  );
}

/**
 * «Разослать по СМС» (23.09.2026, просьба владельца): каждому клиенту из
 * подборки уходит СМС со ссылкой — опубликованный объект открывается на сайте,
 * где под фото стоит ролик из Instagram. Ссылка у каждого своя, поэтому в
 * «Ссылках клиентам» на карточке объекта видно, кто открыл
 * (`PropertyShareOpensCard`; блок переименован 01.10.2026, когда показ вернули
 * отдельно от убранной формы «создать ссылку»).
 *
 * Одна кнопка на всю подборку: это и есть рассылка. Кому уже слали за неделю,
 * у кого номер не таджикский — сервер пропускает сам и говорит, сколько ушло.
 * Кнопки нет, пока СМС не подключены в Настройках.
 */
function SmsShareRow({ propertyId, clientIds }: { propertyId: string; clientIds: string[] }) {
  const readOnly = useIsReadOnly();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const { data: status } = useSmsStatus();
  const share = useSmsShareProperty(propertyId);
  const [result, setResult] = useState<SmsShareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Своё окно вместо window.confirm (28.09.2026): системный вопрос браузера
  // выглядел чужим посреди CRM, а в установленном приложении на iPhone его
  // иногда не видно вовсе — нажатие «ничего не делало».
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!status?.configured) return null;

  async function handleSend() {
    if (readOnlyRef.current) return;
    setConfirmOpen(false);
    setError(null);
    setResult(null);
    try {
      setResult(await share.mutateAsync(clientIds));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить СМС");
    }
  }

  const skipped = result?.items.filter((i) => i.status === "skipped").length ?? 0;
  const failed = result?.items.find((i) => i.status === "failed");

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="txt" style={{ flex: "1 1 200px" }}>
          СМС со ссылкой на объект: клиент откроет его на сайте, с фото, роликом и картой.
        </span>
        <button type="button" className="pill sm" onClick={() => setConfirmOpen(true)} disabled={readOnly || share.isPending}>
          {share.isPending ? "Отправляю…" : `Разослать по СМС · ${clientIds.length}`}
        </button>
      </div>
      {result && (
        <div className={`quiet${failed ? " crit" : ""}`}>
          <span className={`dot${failed ? " crit" : ""}`} />
          <span className="txt">
            Ушло {result.sent}
            {skipped > 0 ? `, пропущено ${skipped} (уже отправляли за неделю, чужой клиент или номер не таджикский)` : ""}
            {failed ? `. Остановлено: ${failed.reason}` : ""}
          </span>
        </div>
      )}
      {error && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
      {!readOnly && confirmOpen && (
        <ConfirmDialog
          title="Разослать по СМС"
          description={`Каждому из ${clientIds.length} клиентов подборки уйдёт СМС со своей ссылкой на объект. Кому уже отправляли за неделю, у кого номер не таджикский — пропустим сами.`}
          confirmLabel="Разослать"
          danger={false}
          onConfirm={() => void handleSend()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
