import { useRef, useState, type ReactNode } from "react";
import { useAssignClientToAgent, useClientMatch, useSendProperties, useSendTarget } from "../../hooks/useClients";
import { useDistricts } from "../../hooks/useDistricts";
import { useMatchingClients, useProperties, type PropertyFilters } from "../../hooks/useProperties";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useSmsShareProperty, useSmsStatus, type SmsShareResult } from "../../hooks/useSms";
import { useCan, useIsReadOnly } from "../../lib/permissions";
import { formatMoney, PROPERTY_TYPE_LABELS } from "../../lib/format";
import { AddInteractionModal } from "../AddInteractionModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { SendFallback, SendTargetNote, sendFallbackOf, targetReady } from "./SendFallback";
import { useMobileUx } from "../../hooks/useMobileUx";
import type { ClientPropertyMatchEvidence, SendPropertiesFallback } from "@royal-home/shared";
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
      /** Show a compact first view while preserving selection when expanded. */
      overviewLimit?: number;
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
  return props.mode === "client" ? <ClientMatchPanel key={`${props.client.id}:${props.conversationId ?? "card"}`} {...props} /> : <PropertyMatchPanel {...props} />;
}

/** Оболочка — шторка или голая карточка, в зависимости от `variant`. Открытие/
 *  закрытие модалки решает сам `Rh2Sheet` (Esc, клик мимо, свайп на телефоне). */
export function PanelShell({
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
        {footer && <div className="client-match-toolbar" role="region" aria-label="Выбранные объекты">{footer}</div>}
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

/** One recommendation and selection state for the overview, catalog and send preview. */
function ClientMatchPanel({
  client, open, onClose, onSent, variant = "modal", layer, conversationId,
  readOnly: cardReadOnly = false, overviewLimit,
}: Extract<MatchPanelProps, { mode: "client" }>) {
  const accountReadOnly = useIsReadOnly();
  const readOnly = cardReadOnly || accountReadOnly;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [source, setSource] = useState<"match" | "catalog">("match");
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [showingFor, setShowingFor] = useState<Property | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [justOffered, setJustOffered] = useState<Set<string>>(new Set());
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    message: string; fallback: SendPropertiesFallback | null; tone: "crit" | "warn";
  } | null>(null);
  const [chosenConversation, setChosenConversation] = useState(conversationId ?? "");
  const effectiveConversation = chosenConversation || undefined;
  const [previewConversation, setPreviewConversation] = useState<string | undefined>();
  const target = useSendTarget(client.id, failure?.fallback ? previewConversation : effectiveConversation, open && !readOnly);
  const sendProperties = useSendProperties(client.id);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  function setOperationBusy(value: boolean) { busyRef.current = value; setBusy(value); }
  const mobile = useMobileUx();
  const conversations = [
    ...(client.botConversation ?? []).map((c, index) => ({ id: c.id, label: `${CHANNEL_WORD[c.channel] ?? c.channel}${(client.botConversation ?? []).filter(item => item.channel === c.channel).length > 1 ? ` · чат ${index + 1}` : ""}` })),
    ...(client.telegramConversation ? [{ id: `tg_${client.telegramConversation.id}`, label: "Telegram" }] : []),
  ];

  function toggleSelected(id: string) {
    if (readOnlyRef.current || busyRef.current) return;
    setSendResult(null);
    setFailure(null);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_TO_SEND) next.add(id);
      return next;
    });
  }

  // Preparation is explicit and independent of channel availability. It never
  // sends, pauses the bot or claims delivery. The same preview is used for all methods.
  async function prepare(ids: string[]) {
    if (readOnlyRef.current || busyRef.current || ids.length === 0) return;
    setOperationBusy(true);
    setFailure(null);
    setSendResult(null);
    const pinnedConversation = effectiveConversation ?? target.data?.conversationId ?? undefined;
    try {
      const result = await sendProperties.mutateAsync({ propertyIds: ids, conversationId: pinnedConversation, prepareOnly: true });
      if (readOnlyRef.current) return;
      if (!result.fallback) throw new Error("Не удалось подготовить текст и ссылки. Повторите.");
      setPreviewConversation(pinnedConversation);
      setFailure({ message: "Предпросмотр: клиенту пока ничего не отправлено.", fallback: result.fallback, tone: "warn" });
    } catch (err) {
      if (!readOnlyRef.current) setFailure({ message: err instanceof Error ? err.message : "Не удалось подготовить подборку", fallback: null, tone: "crit" });
    } finally { setOperationBusy(false); }
  }

  async function sendPrepared() {
    if (readOnlyRef.current || busyRef.current || !failure?.fallback || !targetReady(target.data) || target.isFetching || target.isError) return;
    const pinnedConversation = previewConversation ?? target.data?.conversationId;
    if (!pinnedConversation) return;
    const ids = failure.fallback.links.map(link => link.propertyId);
    setOperationBusy(true);
    setSendResult(null);
    try {
      const result = await sendProperties.mutateAsync({ propertyIds: ids, conversationId: pinnedConversation });
      if (readOnlyRef.current) return;
      const actualIds = result.propertyIds ?? (result.sent === ids.length ? ids : []);
      setJustOffered(prev => new Set([...prev, ...actualIds]));
      setSelected(prev => new Set([...prev].filter(id => !actualIds.includes(id))));
      const where = result.channel ? ` в ${CHANNEL_WORD[result.channel] ?? result.channel}` : " в переписку";
      setSendResult(`Передано${where}: ${result.sent} ${pluralObjects(result.sent)}. Это не подтверждение прочтения. Дальше переписку ведёте вы.`);
      setFailure(null);
      onSent?.();
    } catch (err) {
      if (!readOnlyRef.current) setFailure(prev => ({ message: err instanceof Error ? err.message : "Не удалось отправить", fallback: sendFallbackOf(err) ?? prev?.fallback ?? null, tone: "crit" }));
    } finally { setOperationBusy(false); }
  }

  const bookedShowings = bookedShowingsByProperty(client.interactions ?? []);
  const [filters, setFilters] = useState<PropertyFilters>({ status: "AVAILABLE", page: 1 });
  const debouncedQuery = useDebouncedValue(filters.q, 350);
  const debouncedAreaMin = useDebouncedValue(filters.areaMin, 350);
  const debouncedAreaMax = useDebouncedValue(filters.areaMax, 350);
  const { data: districts } = useDistricts();
  const matchQuery = useClientMatch(client.id, open && source === "match", { page, scope });
  const catalogQuery = useProperties(
    { ...filters, q: debouncedQuery, areaMin: debouncedAreaMin, areaMax: debouncedAreaMax },
    open && source === "catalog"
  );
  const activeQuery = source === "match" ? matchQuery : catalogQuery;
  const items: (Property & { match?: ClientPropertyMatchEvidence })[] = source === "match" ? matchQuery.data?.properties ?? [] : catalogQuery.data?.items ?? [];
  const visibleItems = source === "match" && overviewLimit && !expanded ? items.slice(0, overviewLimit) : items;
  const total = source === "match" ? matchQuery.data?.total ?? 0 : catalogQuery.data?.total ?? 0;
  const currentPage = source === "match" ? page : filters.page ?? 1;
  const pageSize = source === "match" ? matchQuery.data?.pageSize ?? 12 : catalogQuery.data?.pageSize ?? 20;
  const unfiltered = source === "match" && matchQuery.data?.unfiltered;
  const requirementsCurrent = !client.requirementsFieldsKind || client.requirementsFieldsKind === "BUYER";
  const deliveryUnavailable = target.isLoading || target.isFetching || target.isError || !targetReady(target.data) || !(previewConversation ?? target.data?.conversationId);
  function changePage(next: number) {
    if (source === "match") setPage(next);
    else setFilters(prev => ({ ...prev, page: next }));
    setExpanded(true);
  }
  const toolbar = !readOnly && selected.size > 0 ? <>
    <span className="state" role="status">Выбрано: {selected.size} из {MAX_TO_SEND}</span>
    <button type="button" className="pill" disabled={busy} onClick={() => void prepare([...selected])}>
      {busy ? "Подождите…" : `Подготовить отправку · ${selected.size}`}
    </button>
    <button type="button" className="pill ghost" disabled={busy} onClick={() => { setSelected(new Set()); setFailure(null); }}>Снять выбор</button>
  </> : undefined;

  return <>
    <PanelShell variant={variant} open={open} layer={layer} title={`Подбор объектов${matchQuery.data ? ` · ${matchQuery.data.total}` : ""}`} onClose={onClose} footer={toolbar}
      sub={<>
        {!overviewLimit && matchQuery.data?.requirementsSummary?.length ? <p className="state">{matchQuery.data.requirementsSummary.join(" · ")}</p> : null}
        {requirementsCurrent && client.requirementsNotes && <p className="state">Пожелания: {client.requirementsNotes}</p>}
        {!requirementsCurrent && <p className="quiet warn">Предыдущие условия относятся к другой роли. Уточните, что клиент хочет купить.</p>}
        {!readOnly && <details className="client-match-delivery" open={selected.size > 0 || !!failure?.fallback}>
          <summary>Способ отправки{target.data?.channel ? ` · ${CHANNEL_WORD[target.data.channel] ?? target.data.channel}` : ""}</summary>
          <label className="client-match-channel">Канал отправки
            <select className="inp" value={chosenConversation} disabled={busy} onChange={event => { setChosenConversation(event.target.value); setFailure(null); }}>
              <option value="">Автоматически по переписке</option>
              {conversations.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <SendTargetNote info={target.data} isLoading={target.isLoading} failed={target.isError} retry={() => target.refetch()} />
        </details>}
      </>}>
      <div className="seg" role="group" aria-label="Источники объектов">
        <button type="button" aria-pressed={source === "match"} onClick={() => setSource("match")}>Подбор по всей базе</button>
        <button type="button" aria-pressed={source === "catalog"} onClick={() => { setSource("catalog"); setExpanded(true); }}>Каталог объектов</button>
      </div>
      {source === "match" && <>
        <div className="seg" role="group" aria-label="Ответственный за объекты">
          <button type="button" aria-pressed={scope === "all"} onClick={() => { setScope("all"); setPage(1); }}>{unfiltered ? "Все варианты" : "Все подходящие"}</button>
          <button type="button" aria-pressed={scope === "mine"} onClick={() => { setScope("mine"); setPage(1); }}>{unfiltered ? "Мои варианты" : "Мои подходящие"}{matchQuery.data ? ` · ${matchQuery.data.mineTotal}` : ""}</button>
        </div>
        {matchQuery.data && <p className="state">Сравнили доступных объектов: {matchQuery.data.scanned}. Сначала качество соответствия, при равном качестве — свои объекты.</p>}
        {unfiltered && <p className="quiet warn" role="status">Требования ещё не заполнены. Эти варианты нужно уточнить с клиентом.</p>}
      </>}
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

      {activeQuery.isLoading && <p className="state">Подбираем объекты…</p>}
      {activeQuery.isError && <div className="empty" role="alert">
        <p>{activeQuery.error instanceof Error ? activeQuery.error.message : "Не удалось загрузить объекты"}</p>
        <button type="button" className="pill ghost" onClick={() => activeQuery.refetch()}>Повторить</button>
      </div>}
      {!activeQuery.isLoading && !activeQuery.isError && items.length === 0 && <div className="empty">
        <p>{matchQuery.data?.reason === "not_buyer" && source === "match" ? "Подбор доступен только подтверждённому покупателю." : "Подходящих объектов пока нет. Уточните требования или посмотрите каталог."}</p>
        {source === "match" && <button type="button" className="pill ghost" onClick={() => { setSource("catalog"); setExpanded(true); }}>Посмотреть каталог</button>}
      </div>}
      {!readOnly && failure && (failure.fallback ? <div className="client-match-preview">
        <h3>Отправка подборки · {failure.fallback.links.length}</h3>
        <SendFallback key={failure.fallback.links.map(link => link.propertyId).join(",")} clientId={client.id} message={failure.message} fallback={failure.fallback} tone={failure.tone}
          smsAvailable={target.data?.smsAvailable ?? false} disabled={busy} onBusyChange={setOperationBusy} layer={layer}
          onDone={ids => { setJustOffered(prev => new Set([...prev, ...ids])); setSelected(prev => new Set([...prev].filter(id => !ids.includes(id)))); }} />
        <p className="state">Отправка через CRM приостановит бота в выбранном диалоге. Копирование и системное меню не подтверждают доставку.</p>
        <button type="button" className="pill" disabled={busy || deliveryUnavailable} onClick={() => void sendPrepared()}>
          {busy ? "Подождите…" : `Отправить${target.data?.channel ? ` в ${CHANNEL_WORD[target.data.channel] ?? target.data.channel}` : " через CRM"}`}
        </button>
      </div> : <p role="alert" className="quiet crit">{failure.message}</p>)}
      {sendResult && <p className="quiet" role="status">{sendResult}</p>}
      <div className="list">
        {visibleItems.map(p => <MatchPropertyCard key={p.id} property={p} selected={selected.has(p.id)}
          onToggleSelect={readOnly ? undefined : () => toggleSelected(p.id)}
          selectionDisabled={busy || (!selected.has(p.id) && selected.size >= MAX_TO_SEND)}
          offered={(p.match?.sentCount ?? 0) > 0 || justOffered.has(p.id)}
          onSend={readOnly ? undefined : () => void prepare([p.id])} sending={busy}
          bookedShowingAt={bookedShowings.get(p.id) ?? null} onScheduleShowing={readOnly ? undefined : () => setShowingFor(p)}
          onClosePanel={variant === "modal" ? onClose : undefined} />)}
      </div>
      {source === "match" && overviewLimit && !expanded && total > visibleItems.length ?
        <button type="button" className="pill ghost" onClick={() => setExpanded(true)}>Показать все · {total}</button> : null}
      {(expanded || !overviewLimit || source === "catalog") && total > pageSize && <nav className="filters" aria-label="Страницы объектов">
        <button type="button" className="pill ghost" disabled={currentPage <= 1 || activeQuery.isFetching} onClick={() => changePage(currentPage - 1)}>Назад</button>
        <span className="state">Страница {currentPage} из {Math.max(1, Math.ceil(total / pageSize))}</span>
        <button type="button" className="pill ghost" disabled={currentPage * pageSize >= total || activeQuery.isFetching} onClick={() => changePage(currentPage + 1)}>Далее</button>
      </nav>}
    </PanelShell>
    {!readOnly && showingFor && <AddInteractionModal clientId={client.id} initialType="SHOWING" mode="schedule" initialPropertyId={showingFor.id} onClose={() => setShowingFor(null)} onSaved={() => setShowingFor(null)} />}
  </>;
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
  const prepared = result?.items.filter(i => i.status === "prepared").length ?? 0;

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
            Принято SMS-шлюзом: {result.sent}
            {prepared > 0 ? `, тестовых подготовок: ${prepared} (клиентам не отправлено)` : ""}
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
