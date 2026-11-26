import { useEffect, useMemo, useState } from "react";
import { Building2, Check, Loader2, Search } from "lucide-react";
import type { ConversationSendContext, ConversationSendPropertiesResult } from "@royal-home/shared";
import { ApiError } from "../lib/api";
import { formatMoney, PROPERTY_STATUS_LABELS } from "../lib/format";
import { useAuthStore } from "../store/auth";
import { toast } from "../store/toast";
import type { Property } from "../types";
import { useClientMatch } from "../hooks/useClients";
import { useProperties, type PropertyFilters } from "../hooks/useProperties";
import { useConversationSendContext, useSendPropertiesFromChat } from "../hooks/useConversationObjectSend";
import { PropertyPhoto } from "./property/PropertyPhoto";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import "../chat-object-picker.css";

/**
 * ВЫБОР ОБЪЕКТА ДЛЯ ОТПРАВКИ ИЗ ЧАТА (владелец 26.11.2026: «клиент должен СНАЧАЛА посмотреть
 * объекты, а потом дать номер; отправлять любые объекты любому собеседнику, и без карточки, и
 * без принятой заявки»). Макет A (шторка: вкладки, список с фото, «уже отправляли») плюс
 * подсказка «что получит клиент» из макета C. Сервер: POST /conversations/:id/send-properties.
 *
 * Карточка клиента НЕ нужна и НЕ грузится (раньше открытие ждало самый тяжёлый запрос CRM и
 * без карточки не открывалось вовсе): шторка открывается сразу со скелетоном, а «куда уйдёт»,
 * «что уже отправляли» и «что бот собрал о запросе» приходят одним лёгким запросом
 * (GET /conversations/:id/send-context). Вкладка «Рекомендуем»: с карточкой — подбор под
 * требования клиента, без неё — по тому, что бот уже собрал (комнаты, район, бюджет); нечего
 * подбирать — вкладки нет.
 */

type Tab = "mine" | "recommended" | "all";
const MAX_TO_SEND = 10;
const PAGE_SIZE = 12;
const TAB_LABEL: Record<Tab, string> = { mine: "Мои", recommended: "Рекомендуем клиенту", all: "Все" };
const NOT_OFFERABLE = new Set(["SOLD", "WITHDRAWN"]);

/** Срок паузы бота в ISO, округлённый до минуты: повтор того же нажатия идёт с тем же ключом и клиенту не уйдёт дубль. */
function pausedUntilRounded(minutes: number): string {
  const minuteMs = 60_000;
  return new Date(Math.ceil(Date.now() / minuteMs) * minuteMs + minutes * minuteMs).toISOString();
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

type Source =
  | { kind: "properties"; filters: PropertyFilters }
  | { kind: "match"; clientId: string };

interface PageState {
  rows: Property[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  refetch: () => void;
}

/** Одна порция списка. Порций столько, сколько раз нажали «Показать ещё»: так список не копится в одном состоянии. */
function usePickerPage(source: Source, page: number): PageState {
  const list = useProperties(source.kind === "properties" ? { ...source.filters, page } : {}, source.kind === "properties");
  const match = useClientMatch(source.kind === "match" ? source.clientId : undefined, source.kind === "match", { page, pageSize: PAGE_SIZE });
  if (source.kind === "match") {
    return {
      rows: (match.data?.properties as Property[] | undefined) ?? [],
      loading: match.isLoading,
      error: match.isError,
      hasMore: !!match.data?.hasMore,
      refetch: () => void match.refetch(),
    };
  }
  const data = list.data;
  return {
    rows: data?.items ?? [],
    loading: list.isLoading,
    error: list.isError,
    hasMore: !!data && data.page * data.pageSize < data.total,
    refetch: () => void list.refetch(),
  };
}

function rowFacts(p: Property): string {
  const parts = [
    p.rooms ? `${p.rooms}к` : null,
    p.areaSqm ? `${Math.round(Number(p.areaSqm))} м²` : null,
    p.floor ? (p.totalFloors ? `${p.floor}/${p.totalFloors} этаж` : `${p.floor} этаж`) : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function PickerRow({ property, selected, sent, blocked, onToggle }: {
  property: Property;
  selected: boolean;
  sent: boolean;
  blocked: boolean;
  onToggle: () => void;
}) {
  const photo = property.photos?.[0];
  const notOfferable = NOT_OFFERABLE.has(property.status);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={notOfferable || (blocked && !selected)}
      className={`cop-row${selected ? " on" : ""}`}
      onClick={onToggle}
      data-testid="object-picker-row"
    >
      <span className="cop-thumb">
        <PropertyPhoto sources={[photo?.thumbUrl, photo?.url]} fill compact alt="" />
      </span>
      <span className="cop-body">
        <span className="cop-price">{formatMoney(property.price, property.currency)}</span>
        <span className="cop-facts">{rowFacts(property) || `№${property.shortId}`}</span>
        <span className="cop-where">№{property.shortId}{property.district?.name ? ` · ${property.district.name}` : ""}</span>
        <span className="cop-tags">
          <span className={`cop-chip${property.status === "AVAILABLE" ? " ok" : notOfferable ? " bad" : ""}`}>{PROPERTY_STATUS_LABELS[property.status]}</span>
          {sent && <span className="cop-chip sent">Уже отправляли</span>}
        </span>
      </span>
      <span className="cop-check" aria-hidden="true">{selected && <Check strokeWidth={3} />}</span>
    </button>
  );
}

function PickerPage({ source, page, selected, sentIds, blocked, onToggle, onMore, isLast, onState }: {
  source: Source;
  page: number;
  selected: Set<string>;
  sentIds: Set<string>;
  blocked: boolean;
  onToggle: (property: Property) => void;
  onMore: () => void;
  isLast: boolean;
  onState: (empty: boolean) => void;
}) {
  const state = usePickerPage(source, page);
  useEffect(() => {
    if (page === 1) onState(!state.loading && state.rows.length === 0 && !state.error);
  }, [page, state.loading, state.rows.length, state.error, onState]);
  if (state.loading) {
    return (
      <div className="cop-skel" aria-busy="true" data-testid="object-picker-skeleton">
        {[0, 1, 2].map((i) => <span key={i} className="cop-skel-row" />)}
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="empty" role="alert">
        <p>Не удалось загрузить объекты. Проверьте связь и повторите.</p>
        <button type="button" className="pill ghost" onClick={state.refetch}>Повторить</button>
      </div>
    );
  }
  return (
    <>
      {state.rows.map((p) => (
        <PickerRow key={p.id} property={p} selected={selected.has(p.id)} sent={sentIds.has(p.id)} blocked={blocked} onToggle={() => onToggle(p)} />
      ))}
      {isLast && state.hasMore && (
        <button type="button" className="pill ghost cop-more" onClick={onMore}>Показать ещё</button>
      )}
    </>
  );
}

export function ChatObjectPicker({
  conversationId,
  disabled,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  pauseMinutes,
  onSent,
}: {
  /** Открытый диалог (id инбокса): объект уходит СЮДА. */
  conversationId?: string;
  disabled?: boolean;
  /** Управление снаружи: «Объект» живёт в меню скрепки. Без этих свойств — самостоятельная кнопка. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  /** Срок паузы бота, выбранный сотрудником (минуты); пусто — умолчание сервера. */
  pauseMinutes?: number;
  /** Объект ушёл: фото стоят в очереди — экран показывает по ним пузыри «В очереди / Отправляем». */
  onSent?: (result: ConversationSendPropertiesResult) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (value: boolean) => (onOpenChange ? onOpenChange(value) : setOwnOpen(value));
  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={disabled || !conversationId}
          aria-label="Объект"
          aria-haspopup="dialog"
          title="Отправить объект из базы"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-line-soft hover:text-gray-600 disabled:opacity-40"
        >
          <Building2 className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
      )}
      {open && conversationId && (
        <ChatObjectPickerSheet conversationId={conversationId} onClose={() => setOpen(false)} pauseMinutes={pauseMinutes} onSent={onSent} />
      )}
    </>
  );
}

function recommendedFilters(draft: NonNullable<ConversationSendContext["draft"]>): PropertyFilters {
  return {
    status: "AVAILABLE",
    ...(draft.rooms ? { rooms: draft.rooms } : {}),
    ...(draft.districtId ? { districtId: draft.districtId } : {}),
    ...(draft.budgetMax ? { priceMax: draft.budgetMax } : {}),
    ...(draft.type ? { type: draft.type } : {}),
  };
}

function ChatObjectPickerSheet({ conversationId, onClose, pauseMinutes, onSent }: {
  conversationId: string;
  onClose: () => void;
  pauseMinutes?: number;
  onSent?: (result: ConversationSendPropertiesResult) => void;
}) {
  const viewerId = useAuthStore((s) => s.agent?.id);
  const ctx = useConversationSendContext(conversationId, true);
  const send = useSendPropertiesFromChat(conversationId);
  const [pickedTab, setPickedTab] = useState<Tab | null>(null);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 300);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<{ message: string; copyText?: string } | null>(null);
  const [empty, setEmpty] = useState(false);

  const context = ctx.data;
  const clientId = context?.hasCard ? context.clientId : null;
  const hasRecommendations = !!context && (!!clientId || !!context.draft);
  const tabs = useMemo<Tab[]>(() => (hasRecommendations ? ["mine", "recommended", "all"] : ["mine", "all"]), [hasRecommendations]);
  const tab: Tab = pickedTab && tabs.includes(pickedTab) ? pickedTab : hasRecommendations ? "recommended" : "mine";

  const source = useMemo<Source>(() => {
    if (tab === "recommended" && clientId && !q) return { kind: "match", clientId };
    const base: PropertyFilters = q ? { q } : { status: "AVAILABLE" };
    if (tab === "recommended" && context?.draft) return { kind: "properties", filters: { ...recommendedFilters(context.draft), ...(q ? { q, status: undefined } : {}) } };
    if (tab === "mine") return { kind: "properties", filters: { ...base, ...(viewerId ? { agentId: viewerId } : {}) } };
    return { kind: "properties", filters: base };
  }, [tab, clientId, q, context?.draft, viewerId]);
  const sourceKey = JSON.stringify(source);
  useEffect(() => setPages(1), [sourceKey]);

  const sentIds = useMemo(() => new Set(context?.sentPropertyIds ?? []), [context?.sentPropertyIds]);
  const blocked = selected.size >= MAX_TO_SEND;
  const count = selected.size;
  const canSend = !!context && context.allowed && !!context.channel && count > 0 && !send.isPending;

  function toggle(property: Property) {
    setFailure(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(property.id)) next.delete(property.id);
      else if (next.size < MAX_TO_SEND) next.add(property.id);
      return next;
    });
  }

  async function submit() {
    if (!canSend) return;
    setFailure(null);
    try {
      const result = await send.mutateAsync({
        propertyIds: [...selected],
        ...(pauseMinutes ? { pausedUntil: pausedUntilRounded(pauseMinutes) } : {}),
      });
      onSent?.(result);
      onClose();
      toast.success(
        result.photos.queued > 0 ? "Объект отправлен, фото уходят следом" : result.photos.note ? "Объект отправлен ссылкой" : "Объект отправлен"
      );
    } catch (err) {
      const data = err instanceof ApiError ? (err.data as { fallback?: { text?: string }; code?: string } | null) : null;
      setFailure({
        message: err instanceof Error && err.message ? err.message : "Не удалось отправить. Проверьте связь и повторите.",
        copyText: data?.fallback?.text,
      });
    }
  }

  async function copyFallback() {
    if (!failure?.copyText) return;
    try {
      await navigator.clipboard.writeText(failure.copyText);
      toast.success("Текст со ссылками скопирован");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  const hintWarn = !!context && (!context.channelEnabled || !context.windowOpen || !context.channel);

  return (
    <Rh2Sheet
      title="Объект для клиента"
      onClose={onClose}
      layer="above-chat"
      className="cop-sheet"
      footer={
        <div className="cop-foot">
          <p className={`cop-hint${hintWarn ? " warn" : ""}`} role="status" data-testid="object-picker-hint">
            {context ? (
              <>
                {!hintWarn && <>Клиент получит: карточку, фото и личную ссылку. </>}
                {context.hint}
              </>
            ) : ctx.isError ? "Не удалось узнать, куда уйдёт объект." : "Проверяю, куда уйдёт объект…"}
          </p>
          {failure && (
            <p className="cop-error" role="alert">
              {failure.message}
              {failure.copyText && <> <button type="button" className="lnk" onClick={() => void copyFallback()}>Скопировать текст со ссылками</button></>}
            </p>
          )}
          <button type="button" className="pill cop-send" disabled={!canSend} onClick={() => void submit()} data-testid="object-picker-send">
            {send.isPending ? <><Loader2 className="cop-spin" aria-hidden="true" /> Отправляем…</> : `Отправить${count ? ` (${count})` : ""}`}
          </button>
        </div>
      }
    >
      {ctx.isError && (
        <div className="empty" role="alert">
          <p>{ctx.error instanceof Error && ctx.error.message ? ctx.error.message : "Не удалось открыть выбор объекта."}</p>
          <button type="button" className="pill ghost" onClick={() => void ctx.refetch()}>Повторить</button>
        </div>
      )}
      {context && !context.allowed && context.deniedReason && <p className="cop-error" role="alert">{context.deniedReason}</p>}
      <div className="cop-tabs" role="tablist" aria-label="Откуда взять объект">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "on" : ""}
            onClick={() => setPickedTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <label className="cop-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          enterKeyHint="search"
          className="inp"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Номер, район, цена"
          aria-label="Поиск объекта"
        />
      </label>
      <div className="cop-list" role="group" aria-label="Объекты">
        {!context && !ctx.isError ? (
          <div className="cop-skel" aria-busy="true" data-testid="object-picker-skeleton">
            {[0, 1, 2].map((i) => <span key={i} className="cop-skel-row" />)}
          </div>
        ) : context ? (
          <>
            {Array.from({ length: pages }, (_, i) => (
              <PickerPage
                key={`${sourceKey}:${i + 1}`}
                source={source}
                page={i + 1}
                selected={selected}
                sentIds={sentIds}
                blocked={blocked}
                onToggle={toggle}
                onMore={() => setPages((n) => n + 1)}
                isLast={i === pages - 1}
                onState={setEmpty}
              />
            ))}
            {empty && (
              <div className="empty">
                <p>{q ? "По этому запросу ничего нет. Попробуйте номер или район." : tab === "mine" ? "У вас пока нет объектов в продаже. Откройте вкладку «Все»." : "Подходящих объектов пока нет."}</p>
              </div>
            )}
          </>
        ) : null}
        {blocked && <p className="cop-note">За раз можно отправить до {MAX_TO_SEND} объектов.</p>}
      </div>
    </Rh2Sheet>
  );
}
