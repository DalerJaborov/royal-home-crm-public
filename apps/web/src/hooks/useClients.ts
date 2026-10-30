import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { ClientPropertyMatchEvidence, ClientPropertyMatchSummary, ClientKind, ClientSort, SendPropertiesFallback, SendTargetInfo } from "@royal-home/shared";
import { api, ApiError } from "../lib/api";
import { keepWhilePaging, keepWhilePagingAt, keepWhilePagingIndexed } from "../lib/keepWhilePaging";
import { OfflineQueuedError } from "../lib/offlineQueue";
import { currentSessionEpoch, rollbackInSameSession } from "../lib/sessionGuard";
import type { Client, Paginated, Property } from "../types";
import { useProperties } from "./useProperties";
import { withRetryKey, type RetryKey } from "./useRetryKey";
import { useAccumulatedPages } from "./useAccumulatedPages";

/** Оптимистично правит открытую карточку клиента в кэше (кэш по shortId из URL,
 *  значение — Client с .id=uuid). Возвращает снимок для отката при реальной ошибке. */
function patchCachedClient(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
  patch: Partial<Client>
): [QueryKey, Client | undefined][] {
  const prev = qc.getQueriesData<Client>({ queryKey: ["client"] });
  qc.setQueriesData<Client>({ queryKey: ["client"] }, (old) =>
    old && old.id === id ? { ...old, ...patch } : old
  );
  return prev;
}

/** Откат оптимистичного апдейта — но НЕ при офлайн-очереди: там правка применится
 *  сама при появлении сети, поэтому локальное изменение оставляем. И только в той
 *  сессии, где апдейт сделан (`epoch`, WEB-01): после выхода/входа кэш уже чужой. */
function rollbackUnlessQueued(
  qc: ReturnType<typeof useQueryClient>,
  err: unknown,
  ctx: { prev: [QueryKey, Client | undefined][]; epoch: number } | undefined
) {
  if (err instanceof OfflineQueuedError) return;
  rollbackInSameSession(ctx?.epoch, () => ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data)));
}

export interface ClientFilters {
  status?: string;
  kind?: string;
  districtId?: string;
  agentId?: string;
  /** Источник — фильтр шторки «Фильтры» экрана «Клиенты» (артефакт). */
  source?: string;
  /** Раздел «Контроль руководителя» → «Светофор неактивных» (Oversight.tsx):
   *  клик по числу матрицы агент×цвет ведёт сюда с этими двумя фильтрами. */
  workStatus?: "ACTIVE" | "INACTIVE";
  inactiveLevel?: "GREEN" | "YELLOW" | "RED";
  q?: string;
  /** Порядок выдачи — только значения из общего словаря (CLIENT_SORTS): незнакомую
   *  строку сервер отвергнет как неверный запрос, и опечатка обязана ловиться
   *  типом здесь, а не 400-й ошибкой у агента на экране. */
  sort?: ClientSort;
  page?: number;
  /** Для селектов-справочников: одна страница на весь список, до 200 записей. */
  pageSize?: number;
  /** Срез «Ждут принятия» — честно на сервере (acceptedAt IS NULL), а не первой
   *  страницей обычной сортировки на клиенте (docs/TASKS.md, «дашборд агента
   *  против ТЗ», 07.09.2026: переназначенный старый лид с дедлайном в минутах
   *  мог не попасть в первые 20 карточек). Сервер же сортирует такой список по
   *  assignedAt — самые старые ожидающие первыми. */
  pendingAcceptance?: boolean;
  /** Срез «Вчера остались без ответа» — тоже честно на сервере (создан вчера по
   *  Душанбе И firstContactAt IS NULL): число на плитке директора считается тем
   *  же правилом, и клиентский отбор страницы расходился бы с ним на длинных
   *  списках. */
  noFirstContactYesterday?: boolean;
  /** Вкладка «Все мои клиенты» (18.09.2026, задание В §f п.1) — снимает Корзину/
   *  kind/status-срезы у своего агента, см. серверный комментарий (routes/clients/list.ts). */
  scope?: "allMine" | "inWork";
}

function toQuery(filters: ClientFilters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (k === "pendingAcceptance" || k === "noFirstContactYesterday") {
      if (v) params.set(k, "1");
      return;
    }
    if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useClients(filters: ClientFilters = {}, enabled = true) {
  return useQuery({
    queryKey: ["clients", filters],
    queryFn: () => api<Paginated<Client>>(`/clients${toQuery(filters)}`),
    placeholderData: keepWhilePaging<Paginated<Client>>(["clients", filters]),
    enabled,
  });
}

/** Сводка экрана «Клиенты» (артефакт, tpl-clients): счётчики срезов, плитки,
 *  строка «ждёт агента». Один GET /clients/summary, права те же, что у списка;
 *  поля, закрытые роли, приходят null. Обновляется раз в минуту — как список. */
export interface ClientsSummary {
  buyers: number;
  sellers: number;
  mine: number | null;
  other: number | null;
  lost: number | null;
  newToday: number;
  newYesterday: number;
  awaitingAgent: {
    count: number;
    oldest: { id: string; shortId: number; fullName: string; kind: string; waitingMinutes: number } | null;
  };
  noContactOverDay: number;
  showings: { today: number; tomorrow: number };
  freeAgents: { id: string; fullName: string; slotsLeft: number }[] | null;
  /** Лиды по стадиям воронки (экран «Воронка лидов», pages/LeadFunnel.tsx) — см.
   *  тот же комментарий у типа на сервере (routes/clients/summary.ts). */
  stages: { new: number; inProgress: number; awaitingDecision: number; closed: number };
  /** Счётчики вкладок «Неактивные»/«Все мои» (18.09.2026, задание В §f п.1/4). */
  inactive: number;
  deferred: number;
  trashedMine: number | null;
}

export function useClientsSummary(enabled = true) {
  return useQuery({
    queryKey: ["clients", "summary"],
    queryFn: () => api<ClientsSummary>("/clients/summary"),
    enabled,
    staleTime: 30_000,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
  });
}

export function useClient(
  id: string | undefined,
  options?: {
    /**
     * ПАНЕЛЬ ПЕРЕПИСКИ ОТКРЫТА (06.09.2026, разбор «лёгкого чата»). В инбоксе
     * (pages/Messages.tsx, useConversation) открытый диалог опрашивается раз в
     * 8с — на карточке клиента этого не было вовсе, и агент, держащий панель
     * открытой, не видел ответ клиента, пока сам не закроет и не откроет её
     * заново (или пока не сработает поллинг расшифровки звонка — событие
     * редкое и с перепиской не связанное).
     *
     * НЕ включаем этот интервал безусловно: useClient дёргают и там, где
     * панель не открыта вовсе (список карточек, другие вкладки), а карточка —
     * тяжёлый объект (сделки, объекты, хронология). Флаг явно передаёт
     * вызывающая сторона (ClientDetail: `chat.open`), поэтому опрос идёт
     * ровно то время, пока переписка правда на экране.
     */
    pollConversations?: boolean;
  }
) {
  const pollConversations = options?.pollConversations ?? false;
  return useQuery({
    queryKey: ["client", id],
    queryFn: () => api<Client>(`/clients/${id}`),
    enabled: !!id,
    /**
     * КАРТОЧКА ОБНОВЛЯЕТСЯ САМА, ПОКА ИДЁТ РАСШИФРОВКА ЗВОНКА (владелец 15.08.2026)
     * ИЛИ ПОКА ОТКРЫТА ПАНЕЛЬ ПЕРЕПИСКИ (06.09.2026, см. `pollConversations` выше).
     * Расшифровка звонка важнее и опрашивается чаще — если активны оба условия
     * разом, побеждает более частый интервал.
     */
    refetchInterval: (query) => {
      const interactions = query.state.data?.interactions;
      const transcribing = interactions?.some((i) => i.type === "CALL" && i.transcriptionStage != null);
      if (transcribing) return 4_000;
      return pollConversations ? 8_000 : false;
    },
  });
}

/** POST /clients возвращает 200 с этой формой вместо Client, если найден
 *  вероятный дубликат по телефону (см. clientsRouter.post("/") на сервере) —
 *  агент может подтвердить создание повторно с force=true. */
export interface ClientDuplicateWarning {
  warning: string;
  /** Только ссылка и имя: чужую карточку целиком сервер не отдаёт (аудит 23.09.2026, №43). */
  client: { id: string; shortId: number; fullName: string };
}

/** `retryKey` — см. hooks/useRetryKey.ts: повтор после обрыва не создаёт второго клиента. */
export function useCreateClient(retryKey?: RetryKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      withRetryKey(retryKey, (idempotencyKey) =>
        api<Client | ClientDuplicateWarning>("/clients", { method: "POST", body, queueOffline: true, idempotencyKey })
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useUpdateClient(id: string) {
  const qc = useQueryClient();
  return useMutation({
    // queueOffline: смена статуса и прочие правки без сети сохраняются в очередь.
    mutationFn: (body: Record<string, unknown>) =>
      api<Client>(`/clients/${id}`, { method: "PATCH", body, queueOffline: true }),
    // Офлайн правку применяем к карточке сразу, чтобы агент видел новый статус,
    // даже пока запрос ждёт сети в очереди.
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ["client"] });
      return { prev: patchCachedClient(qc, id, body as Partial<Client>), epoch: currentSessionEpoch() };
    },
    onError: (err, _body, ctx) => {
      rollbackUnlessQueued(qc, err, ctx);
      // Пачка 16 (11.09.2026): PATCH на чужую/переданную карточку отвечает
      // foreignWriteDenied (403) или конфликтом состояния (409) — карточка на
      // экране устарела (клиента уже передали, статус уже другой), поэтому
      // перечитываем её вместо того, чтобы оставить старые данные висеть под
      // ошибкой. offline-очередь (OfflineQueuedError) не трогаем — там ошибки нет.
      if (err instanceof ApiError && (err.status === 403 || err.status === 409)) {
        qc.invalidateQueries({ queryKey: ["client"] });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      // Открытая карточка кэширована по shortId из URL, а не по этому UUID — инвалидируем
      // весь префикс ["client"], иначе refetch не тронет отображаемую карточку.
      qc.invalidateQueries({ queryKey: ["client"] });
    },
  });
}

/** Удаление карточки в Корзину — только админ/директор (API вернёт 403 остальным,
 *  409 — если у клиента есть активная сделка). Мягкое: карточку можно вернуть
 *  из Корзины (см. useRestoreClient). Кэш карточки чистим целиком — со списка
 *  клиент пропадает сразу, а открытая карточка (если была) больше не актуальна. */
export function useDeleteClient(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/clients/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.removeQueries({ queryKey: ["client"] });
    },
  });
}

/**
 * «В КАНДИДАТЫ» — карточка уезжает в раздел «Вакансии» (17.09.2026).
 *
 * Человек пришёл по рекламе вакансии, а CRM завела его покупателем и отдала
 * агенту (живые случаи 302, 315, 319). Сервер создаёт анкету, снимает агента и
 * убирает карточку в Корзину, поэтому кэш чистим так же, как при удалении:
 * открытая карточка больше не актуальна, а из списков клиент пропадает сразу.
 */
export function useClientToCandidate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true; applicationId: string }>(`/clients/${id}/to-candidate`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["vacancies"] });
      qc.removeQueries({ queryKey: ["client"] });
    },
  });
}

/** Корзина клиентов — только админ/директор. Постранично (20 на страницу) —
 *  раньше отдавала до 200 карточек разом. */
export function useClientTrash(page: number, enabled = true) {
  return useQuery({
    queryKey: ["clients-trash", page],
    queryFn: () => api<Paginated<Client>>(`/clients/trash?page=${page}`),
    placeholderData: keepWhilePagingIndexed<Paginated<Client>>(["clients-trash", page]),
    enabled,
  });
}

export function useRestoreClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/clients/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients-trash"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

/**
 * «Попросить восстановить» — зеркало заявки на удаление (hooks/useDeleteRequests.ts,
 * право `clients.requestDelete`) для агента без `clients.delete` (18.09.2026,
 * задание В §f п.1): видит свою
 * карточку в Корзине на вкладке «Все мои», но восстановить сам не может.
 * Упрощено против полной заявки: без своей очереди/статуса, одно уведомление
 * тем, у кого есть `clients.delete` — см. серверный комментарий у роута.
 */
export function useRequestRestoreClient() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; message: string }>(`/clients/${id}/request-restore`, { method: "POST" }),
    meta: { silent: true },
  });
}

/** Безвозвратное удаление — только из Корзины (клиент уже должен быть в ней),
 *  только админ/директор. Отдельная кнопка — обычное удаление в Корзину не трогает
 *  сделки/переписку, а эта необратимо стирает карточку. */
export function usePermanentDeleteClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/clients/${id}/permanent`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients-trash"] }),
  });
}

/** Кандидат на освобождение места — обычный (0.5%) активный лид агента. */
export interface ReleaseCandidate {
  id: string;
  shortId: number;
  fullName: string;
  kind: ClientKind;
  status: string;
  assignedAt: string;
}

/** Ответ сервера, когда портфель полон и нужно выбрать, кого отдать. */
export interface RequiresReleaseBody {
  requiresRelease: true;
  error: string;
  candidates: ReleaseCandidate[];
}

/** Портфель полон, пришёл лид по своему объекту — сервер спрашивает, кого
 *  освободить (решение владельца 11.08.2026). Это НЕ ошибка, а вопрос. */
export function isRequiresRelease(err: unknown): RequiresReleaseBody | null {
  const data = err instanceof ApiError ? (err.data as RequiresReleaseBody | undefined) : undefined;
  return data?.requiresRelease ? data : null;
}

export function useAcceptLead(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars?: { releaseClientId?: string }) =>
      api<Client>(`/clients/${id}/accept`, {
        method: "POST",
        queueOffline: true,
        body: vars?.releaseClientId ? { releaseClientId: vars.releaseClientId } : {},
      }),
    // Офлайн: карточку разблокируем сразу (агент может вести заметки), а сам приём
    // уйдёт из очереди при появлении сети. Телефон подтянется настоящим после синка.
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["client"] });
      return {
        prev: patchCachedClient(qc, id, { acceptedAt: new Date().toISOString(), pendingAcceptance: false }),
        epoch: currentSessionEpoch(),
      };
    },
    // Откат нужен и при 409 «выберите, кого освободить»: приём не состоялся, и
    // карточка обязана вернуться в состояние «ждёт принятия», иначе агент видит
    // разблокированного клиента, которого на самом деле ещё не принял.
    onError: (err, _vars, ctx) => rollbackUnlessQueued(qc, err, ctx),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client"] });
    },
  });
}

/** «❌ Отклонить» рядом с «✅ Принять» (спецификация: Royal Score Engine, часть 1).
 *  Лид сразу уходит следующему свободному агенту — карточка у текущего агента
 *  пропадает из выдачи, поэтому инвалидируем список и сам client целиком. */
export function useDeclineLead(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ reassignedTo: string | null; escalated: boolean; declineCount: number }>(`/clients/${id}/decline`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client"] });
    },
  });
}

// useClaimPoolLead (POST /clients/:id/claim-pool) УДАЛЁН ЦЕЛИКОМ (17.09.2026,
// закон о владении клиентом П-4/Р-3) — см. комментарий в
// routes/clients/lifecycle.ts.

/** Руководитель вручную назначает непринятый/эскалированный лид агенту
 *  (accept=true — забирает себе и сразу принимает). */
export function useAssignLead(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { agentId: string; accept?: boolean }) =>
      api<Client>(`/clients/${id}/assign`, { method: "POST", body }),
    // silent: у ClientDetail.tsx уже своя плашка на этот случай (assignLead.isError,
    // два места — «Взять себе» и переназначение) — общий тост дублировал текст
    // (найдено аудитом 22.08.2026, тот же баг что был у useUpdateDeal).
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      // Карточка кэширована по shortId из URL, не по этому UUID — инвалидируем префикс.
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["dashboard-team-live"] });
    },
    // Отказ чаще всего значит, что карточка уже другая (лид приняли, его забрал
    // другой руководитель): перечитываем её, иначе повтор упрётся в тот же отказ
    // (аудит 23.09.2026, №57).
    onError: () => {
      qc.invalidateQueries({ queryKey: ["client"] });
    },
  });
}

/**
 * То же назначение, но id клиента приходит с каждым вызовом, а не фиксирован
 * при вызове хука — нужно там, где кнопка «отдать» стоит в списке из нескольких
 * клиентов сразу (карточка объекта, «Кому подойдёт»), и заводить отдельный
 * экземпляр хука на каждую строку было бы лишним.
 */
export function useAssignClientToAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, agentId }: { clientId: string; agentId: string }) =>
      api<Client>(`/clients/${clientId}/assign`, { method: "POST", body: { agentId } }),
    // silent: у единственного вызывающего (MatchPanel, режим объекта) своя
    // обратная связь — строка помечается переданной, а отказ печатается
    // плашкой над списком. Общий тост дублировал её (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client"] });
      // Ключ запроса — ["property", propertyId, "matching-clients"], поэтому
      // инвалидация по ["matching-clients"] не срабатывала никогда: список
      // «Кому подойдёт» обновлялся только глобальным поллингом (аудит №4).
      qc.invalidateQueries({ predicate: (q) => q.queryKey.includes("matching-clients") });
    },
  });
}

/**
 * «Робот позвонит клиенту» (28.09.2026): звонит не агент, а голосовой бот —
 * POST /clients/:id/live-voice-call, при переданном объекте бот рассказывает о
 * нём. Отказы сервер присылает человеческим текстом (409: живой голос выключен,
 * линия занята, номер не набирается, звонок уже идёт) — их показывает сама
 * строка действия, поэтому общий тост здесь не нужен (meta.silent). Звонок
 * настоящий: mutate только по явному нажатию.
 */
export function useLiveVoiceCall(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string | null) =>
      api<{ ok: boolean; channelId: string }>(`/clients/${clientId}/live-voice-call`, {
        method: "POST",
        body: propertyId ? { propertyId } : {},
      }),
    // Сервер заводит в хронологии запись о запуске звонка (аудит роботов №4):
    // открытая карточка кэширована по shortId, поэтому — весь префикс ["client"].
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client"] });
    },
    meta: { silent: true },
  });
}

/**
 * Что устаревает после новой записи по клиенту.
 *
 * Открытая карточка кэширована по shortId из URL, а не по UUID (тот же баг, что
 * чинили для update/accept/assign) — гасим весь префикс ["client"], иначе новая
 * запись разговора появлялась в хронологии только после F5.
 *
 * Показ или задача с датой — это ещё и клетка календаря, плитка «сегодня» на
 * главной и счётчики в меню (ночная проверка 01.10.2026, №248): обратная
 * сторона — useCalendar — их гасит уже давно, а добавление записи не гасило, и
 * назначенный показ не появлялся в календаре до следующего опроса.
 */
export const INTERACTION_INVALIDATE_KEYS: readonly (readonly string[])[] = [
  ["client"],
  ["clients"],
  ["calendar-tasks"],
  ["dashboard-summary"],
  ["counters"],
];

export function useAddInteraction(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/clients/${clientId}/interactions`, { method: "POST", body, queueOffline: true }),
    onSuccess: () => {
      for (const queryKey of INTERACTION_INVALIDATE_KEYS) qc.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Экспорт полной переписки клиента (все каналы) в .json или .txt — с
 * таймингами там, где они есть (13.09.2026, задача «жалоба на ответ бота —
 * нет способа выгрузить полную историю»). Права проверяет сервер: те же, что
 * на просмотр самой переписки в карточке (GET /clients/:id/conversation-export).
 * Тот же приём, что downloadFinanceCsv (useFinance.ts) — Blob + временная ссылка.
 */
export async function downloadClientConversation(shortId: number, format: "json" | "txt" = "json") {
  const blob = await api<Blob>(`/clients/${shortId}/conversation-export?format=${format}`, { responseType: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `client-${shortId}-conversation.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Произвольное сообщение клиенту из его карточки. Бот ставится на паузу сервером —
 *  агент вступает в переписку, и отвечать поверх него ИИ не должен. */
export function useSendClientMessage(clientId: string, conversationId?: string) {
  const qc = useQueryClient();
  return useMutation({
    // conversationId — диалог выбранной вкладки канала (без него сервер берёт самый
    // живой и мог ответить в Instagram, когда агент выбрал Telegram, WEB-PAGES01).
    mutationFn: (text: string) =>
      api<{ ok: boolean; masked: boolean }>(`/clients/${clientId}/message`, {
        method: "POST",
        body: { text, conversationId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["client"] }),
  });
}

/** Голосовое клиенту из его карточки — тот же путь, что и текст выше, но
 *  multipart: сервер сам перекодирует, расшифрует и проверит запись перед
 *  отправкой (lib/conversationDelivery.ts, deliverVoiceToConversation). */
export function useSendClientVoiceMessage(clientId: string, conversationId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (blob: Blob) => {
      const form = new FormData();
      form.append("audio", blob, "voice.webm");
      if (conversationId) form.append("conversationId", conversationId);
      return api<{ ok: boolean }>(`/clients/${clientId}/message-voice`, { method: "POST", body: form });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["client"] }),
  });
}

/** Звонок из карточки клиента (ARI Originate на Asterisk) — см. apps/api/src/routes/clients.ts
 *  и docs/telephony-sip-numbering.md. Ошибка «телефония не настроена» /  «нет SIP-номера» —
 *  штатный, ожидаемый исход до подключения реального сервера, не баг. */
export interface CallStartedResult {
  ok: boolean;
  channelId?: string;
  /** Номер, на который АТС звонит самому агенту, и каким способом. Показывается ему
   *  сразу: 07.08.2026 первый живой звонок «пропал» именно потому, что в карточке
   *  сотрудника стоял выдуманный номер из тестовых данных, а CRM отвечала бодрым
   *  «Сохранено» — она знает лишь то, что станция приняла команду, но не чем
   *  кончился дозвон. Теперь видно, куда именно пошёл вызов. */
  dialing?: { to: string; mode: "mobile" | "extension" };
}

/** `phone` — звонок не на основной номер карточки, а на другой её номер
 *  (WhatsApp-номер, запасной) — владелец 20.08.2026. Сервер сам проверяет,
 *  что номер принадлежит этой карточке и что он таджикский — здесь просто
 *  передаётся дальше. Без него звонок идёт по основному телефону, как раньше. */
export function useCallClient(clientId: string, phone?: string, phoneKey?: string) {
  return useMutation({
    mutationFn: () =>
      api<CallStartedResult>(`/clients/${clientId}/call`, { method: "POST", body: phoneKey ? { phoneKey } : phone ? { phone } : undefined }),
    // Своё сообщение вместо общего «Сохранено» — оно тут прямо вводило в заблуждение.
    meta: { silent: true },
  });
}

/** Ручной набор номера (владелец 11.08.2026: «а если надо набрать номер?») —
 *  кнопка «Позвонить» есть только у существующей карточки, а звонить иногда нужно
 *  туда, где карточки ещё нет. Сервер сам найдёт клиента по номеру или заведёт
 *  нового — см. POST /clients/dial. */
export function useDialNumber() {
  return useMutation({
    mutationFn: (phone: string) => api<CallStartedResult & { client: { id: string; shortId: number; fullName: string } }>(
      "/clients/dial",
      { method: "POST", body: { phone } }
    ),
    meta: { silent: true },
  });
}

/**
 * «Завершить сделку → Без сделки» (переработка 12.08.2026 из «Клиент отказался»,
 * тот же роут /refuse): причина обязательна, доступна для покупателя только
 * после первого показа, дальше сервер сам передаёт лид сильному агенту (или
 * руководству после третьего отказа). После успеха карточка у агента может
 * стать недоступной — клиент уже не его.
 */
export function useRefuseClient(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      reason: string;
      initiator: string;
      comment?: string;
      competitorName?: string;
      boughtWhat?: string;
      voiceNoteUrl?: string;
      voiceNoteTranscript?: string;
    }) =>
      api<{ ok: boolean; isHot: boolean; transferred: boolean; message: string }>(`/clients/${clientId}/refuse`, {
        method: "POST",
        body,
      }),
    // silent: у окна своя обратная связь и она информативнее — на успехе оно само
    // показывает `result.message` (куда именно ушла карточка), на отказе рисует
    // именную плашку в форме. Общий тост дублировал успех вторым уведомлением
    // подряд и повторял текст ошибки (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

/**
 * «Передача» (ТЗ п. 19-21, голосовое уточнение владельца 12.08.2026): доступна
 * только после первого проведённого показа — до этого используется «Неактивный».
 */
export function useTransferClient(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      reason: string;
      comment?: string;
      voiceNoteUrl?: string;
      voiceNoteTranscript?: string;
    }) => api<{ ok: boolean; message: string }>(`/clients/${clientId}/transfer`, { method: "POST", body }),
    // silent: то же, что в useRefuseClient — окно само показывает `result.message`
    // (кому передан клиент или что передач больше нет) и свою плашку на отказе.
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

/**
 * «Вернуть в работу» — обратный переход к «Неактивному» (ТЗ п. 27). Без него
 * статус был дверью в одну сторону: клиент возвращался в работу только тогда,
 * когда сам писал в канал.
 */
export function useReactivateClient(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/clients/${clientId}/activate`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

/** Один шаг цепочки отказов — кто вёл клиента и что записал при закрытии. */
export interface LostClientChainHop {
  agentName: string;
  notes: string;
  at: string;
}

/** Раздел «Потерянные клиенты» (решение владельца 11.08.2026, свой раздел рядом
 *  с «Горячими»): предел передач исчерпан, несколько агентов подряд не смогли
 *  закрыть клиента. Видит только руководство (право clients.assign). */
export interface LostClient {
  id: string;
  shortId: number;
  fullName: string;
  kind: "BUYER" | "SELLER" | "OTHER";
  phone: string;
  refusalCount: number;
  lastReason: string | null;
  lostAt: string | null;
  chain: LostClientChainHop[];
}

/** Страница разделов «Потерянные» и «Отложенные» (routes/clients/list.ts). */
export const CLIENT_SECTION_PAGE_SIZE = 50;

/**
 * `kind` — срез «Потерянные» внутри раздела (21.09.2026): «Продавцы» и
 * «Покупатели» стали двумя единственными разделами верхнего уровня, а
 * «потерян» — состоянием внутри каждого. Отбор ОБЯЗАН быть серверным: список
 * отдаётся страницами, и фильтр по полученной странице соврал бы ровно тогда,
 * когда потерянных много (routes/clients/list.ts, GET /lost).
 */
export function useLostClients(enabled = true, kind?: "SELLER" | "BUYER" | null, page = 1) {
  return useQuery({
    // total — сколько потерянных всего: список отдаётся страницами.
    queryKey: ["clients-lost", kind ?? "all", page],
    placeholderData: keepWhilePagingAt<Paginated<LostClient>>(["clients-lost", kind ?? "all", page], 2),
    queryFn: () =>
      api<Paginated<LostClient>>(
        `/clients/lost?page=${page}&pageSize=${CLIENT_SECTION_PAGE_SIZE}${kind ? `&kind=${kind}` : ""}`
      ),
    staleTime: 60_000,
    // Сервер требует clients.assign (routes/clients/list.ts, GET /lost) — у
    // агента этого права нет. Раньше запрос уходил безусловно с прямой ссылки
    // на /lost-clients (пункт меню и так скрыт — ClientsTabs.tsx), сервер отвечал
    // 403, и экран рендерился пустым/битым (приёмка 08.09, Q4 B-2).
    enabled,
  });
}

/**
 * ЛЕНТА СТРАНИЦ ДЛЯ «ПОТЕРЯННЫХ» И «ОТЛОЖЕННЫХ» (02.10.2026). Раньше сервер
 * молча отдавал двести, а экран писал «Показаны последние 200 из N» — увидеть
 * остальных было нечем. Теперь «Показать ещё» дочитывает страницы. Общий хук
 * на десктоп и телефон: лента и сброс при смене среза живут в одном месте, и
 * две версии экрана не могут разойтись.
 *
 * `isLoading` — только пока на экране пусто: дочитывание следующей страницы не
 * должно прятать уже показанный список за «Загружаем…».
 */
function useResettingPage(resetKey: string): [number, (page: number) => void] {
  const [paging, setPaging] = useState({ key: resetKey, page: 1 });
  // Сменился срез — страница сама становится первой, без сброса в обработчике.
  const page = paging.key === resetKey ? paging.page : 1;
  return [page, (next: number) => setPaging({ key: resetKey, page: next })];
}

function useSectionFeed<T extends { id: string }>(
  resetKey: string,
  page: number,
  setPage: (page: number) => void,
  query: { data?: Paginated<T>; isLoading: boolean; error: Error | null; refetch: () => unknown },
  head: { data?: Paginated<T> }
) {
  const accumulated = useAccumulatedPages(query.data?.items, page, resetKey, head.data?.items);
  // Ушедшие из раздела строки («Поднять») прячем сразу: страница, где строка
  // лежала, может не перечитаться — подписаны только текущая и первая.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const items = gone.size > 0 ? accumulated.filter((i) => !gone.has(i.id)) : accumulated;
  return {
    items,
    forget: (id: string) => setGone((prev) => new Set(prev).add(id)),
    total: query.data?.total ?? head.data?.total,
    page,
    pageSize: CLIENT_SECTION_PAGE_SIZE,
    setPage,
    isLoading: query.isLoading && items.length === 0,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useLostClientsFeed(enabled: boolean, kind: "SELLER" | "BUYER" | null) {
  const key = kind ?? "all";
  const [page, setPage] = useResettingPage(key);
  const query = useLostClients(enabled, kind, page);
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const head = useLostClients(enabled && page > 1, kind, 1);
  return useSectionFeed(key, page, setPage, query, head);
}

/**
 * Раздел «Отложенные» (задача G, план 03-04.09.2026, решение владельца):
 * EXPENSIVE/FINANCE_ISSUE/WRONG_OBJECT — обычный исход рынка, не отказ, карточка
 * остаётся у того же агента и ждёт таймера возврата. В отличие от «Потерянных»
 * видит НЕ только руководство — агенту показываются его собственные (сервер
 * скоупит по scopeToOwnAgent, см. GET /clients/deferred).
 */
export interface DeferredClient {
  id: string;
  shortId: number;
  fullName: string;
  kind: "BUYER" | "SELLER" | "OTHER";
  phone: string;
  deferredAt: string | null;
  deferredReason: string | null;
  deferredUntil: string | null;
  agentName: string | null;
}

export function useDeferredClients(page = 1, enabled = true) {
  return useQuery({
    queryKey: ["clients-deferred", page],
    placeholderData: keepWhilePagingAt<Paginated<DeferredClient>>(["clients-deferred", page], 1),
    queryFn: () =>
      api<Paginated<DeferredClient>>(`/clients/deferred?page=${page}&pageSize=${CLIENT_SECTION_PAGE_SIZE}`),
    staleTime: 60_000,
    enabled,
  });
}

/** Лента «Отложенных» страницами — см. useSectionFeed выше. */
export function useDeferredClientsFeed() {
  const [page, setPage] = useResettingPage("deferred");
  const query = useDeferredClients(page);
  const head = useDeferredClients(1, page > 1);
  return useSectionFeed("deferred", page, setPage, query, head);
}

/** «Поднять раньше срока» (задача G5) — свой агент или руководитель. */
export function useReturnDeferredClient(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/clients/${clientId}/deferred/return`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["clients-deferred"] });
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

/** Отправка подобранных объектов клиенту в его канал. Бот ставится на паузу сервером —
 *  агент вступает в переписку, и отвечать поверх него ИИ не должен. */
export interface SendPropertiesResult {
  ok: boolean;
  sent: number;
  propertyIds?: string[];
  masked: boolean;
  /** Канал, куда реально ушло (WHATSAPP/INSTAGRAM/…) — для строки результата. */
  channel?: string;
  /** Ответ на `prepareOnly`: ничего не ушло, вот текст и ссылки. */
  prepared?: boolean;
  previewFingerprint?: string;
  fallback?: SendPropertiesFallback;
}

export function useSendProperties(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    /**
     * `conversationId` — диалог, открытый у агента (из чата). Без него сервер
     * берёт самый живой диалог клиента. Отказ приходит `ApiError` с `data.fallback`
     * (готовый текст и ссылки) — см. `sendFallbackOf` в components/match/SendFallback.
     */
    mutationFn: (input: { propertyIds: string[]; conversationId?: string; prepareOnly?: boolean; previewFingerprint?: string }) =>
      api<SendPropertiesResult>(`/clients/${clientId}/send-properties`, {
        method: "POST",
        body: input,
      }),
    // silent: отправка — не сохранение, и вызывающий (MatchPanel) уже
    // отчитывается сам и подробнее: плашкой со счётчиком и предупреждением про
    // маску телефона. Общий тост «Сохранено» вставал поверх неё вторым
    // сообщением о том же событии, да ещё и не тем словом (аудит 22.08.2026,
    // раунд 5).
    meta: { silent: true },
    onSuccess: () => {
      // Переписка и хронология лежат в карточке клиента — обновляем её целиком,
      // иначе отправленное сообщение появлялось бы только после F5.
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["client-send-target", clientId] });
      qc.invalidateQueries({ queryKey: ["client-match", clientId] });
    },
  });
}

/**
 * Куда уйдёт объект — ДО нажатия (28.09.2026): канал, открыто ли окно Meta,
 * есть ли СМС. Раньше агент узнавал это только из отказа после отправки.
 */
export function useSendTarget(clientId: string | undefined, conversationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["client-send-target", clientId, conversationId ?? null],
    queryFn: () =>
      api<SendTargetInfo>(
        `/clients/${clientId}/send-target${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`
      ),
    enabled: !!clientId && enabled,
    staleTime: 30 * 1000,
    retry: false,
  });
}

/**
 * unfiltered=true — у клиента не заполнено НИ ОДНО требование (бюджет/район/
 * тип/комнаты), и SQL-фильтр не отсёк ничего: список ниже — топ-15 любых
 * AVAILABLE объектов, а не подбор под клиента (пачка 10, 11.09.2026, п.5).
 */
export function useClientMatch(clientId: string | undefined, enabled = true, options: { page?: number; pageSize?: number; scope?: "all" | "mine" } = {}) {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 12;
  const scope = options.scope ?? "all";
  return useQuery({
    queryKey: ["client-match", clientId, { page, pageSize, scope }],
    queryFn: () => api<ClientPropertyMatchSummary & { properties: (Property & { match: ClientPropertyMatchEvidence })[] }>(
      `/clients/${clientId}/match?page=${page}&pageSize=${pageSize}&scope=${scope}`),
    enabled: !!clientId && enabled,
  });
}

/**
 * Объект для показа — строгий подбор под требования клиента, а если он пуст,
 * ВЕСЬ каталог доступных объектов, а не тупик.
 *
 * До 13.08.2026 окно «Ждёт показ» на пустом подборе (`/clients/:id/match`,
 * см. useClientMatch) отправляло агента «назначить показ из карточки» — то есть
 * заканчивало работу, не начав её: карточка тоже открывает тот же строгий подбор.
 * Владелец проверил на живом звонке и назвал это прямо: «нажимаешь выбрать
 * объект, а там пусто». Причина не в поломке, а в самом смысле строгого подбора:
 * бюджет, район и число комнат клиента чаще заполнены не до конца, чем полностью,
 * и тогда фильтр честно не находит ничего — но агент уже решил, что показывает
 * объект, ему нужен любой вариант, а не только идеально подходящий.
 *
 * Общий каталог (`GET /properties?status=AVAILABLE`) — тот же список, что и в
 * каталоге панели «Подбор» (components/match/MatchPanel.tsx, чип «Все
 * объекты»), с теми же фото и ценами: второй способ листать объекты заново
 * изобретать незачем.
 */
export function usePropertyPickerOptions(clientId: string | undefined, q?: string) {
  const matched = useClientMatch(clientId);
  // Поиск (05.10.2026): со строкой поиска строгий подбор не нужен — человек ищет
  // конкретный объект («ОБ-000088», слово из названия), и ограничение статусом
  // AVAILABLE ему тоже мешает: показывать можно и объект в задатке.
  const search = q?.trim() ?? "";
  // !!clientId — иначе на пустом clientId (окно закрыто, показ не выбран) matched
  // молчит отключённым запросом, matchEmpty читалось бы как «пусто», и резервный
  // запрос всего каталога уходил бы на КАЖДОЕ открытие окна, даже когда объект
  // вообще не нужен.
  const matchEmpty = !!clientId && !matched.isLoading && (matched.data?.properties.length ?? 0) === 0;
  const useCatalog = !!clientId && (search !== "" || matchEmpty);
  const fallback = useProperties(
    { q: search || undefined, status: search ? undefined : "AVAILABLE", page: 1 },
    useCatalog
  );
  return useCatalog
    ? { properties: fallback.data?.items, isLoading: fallback.isLoading, isFetching: fallback.isFetching, isError: fallback.isError, refetch: fallback.refetch, usedFallback: true, unfiltered: false }
    : {
        properties: matched.data?.properties,
        isLoading: matched.isLoading,
        isFetching: matched.isFetching,
        isError: matched.isError,
        refetch: matched.refetch,
        usedFallback: false,
        unfiltered: matched.data?.unfiltered ?? false,
      };
}

/**
 * Решение службы безопасности по закрытой карточке.
 *
 * Отдельным хуком, а не полем в общем PATCH: это не правка данных, а вердикт
 * человека с особым правом, и на сервере он проходит свою проверку.
 */
export function useSecurityReview(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      verdict: "CLEARED" | "CONFIRMED";
      note?: string;
      noteVoiceUrl?: string;
      noteVoiceTranscript?: string;
    }) =>
      api<{ ok: boolean; verdict: string; message: string }>(`/clients/${clientId}/security-review`, {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

/**
 * Событие «клиент потерян по вине/без вины агента» для карточки клиента, если
 * оно есть (08.09.2026, см. серверный комментарий у GET /royal-score-events/by-client).
 *
 * enabled управляется снаружи: право `score.clientLossOverride` есть у директора
 * и админа (обычная ASSIGNABLE-галочка с 14.09.2026), агенту дёргать этот запрос
 * незачем, а клиент может быть не потерян вовсе — тогда событие всегда null, и
 * спрашивать не о чем.
 */
export interface ClientLossEvent {
  id: string;
  currentKind: "client_lost_agent_fault" | "client_lost_no_fault";
  overridden: boolean;
  overriddenAt: string | null;
}

export function useClientLossEvent(clientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["royal-score-events", "by-client", clientId],
    queryFn: () => api<{ event: ClientLossEvent | null }>(`/royal-score-events/by-client/${clientId}`),
    enabled,
  });
}

export function useOverrideClientLossEvent(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { override: "client_lost_agent_fault" | "client_lost_no_fault"; comment?: string }) =>
      api<{ ok: boolean }>(`/royal-score-events/${eventId}/override`, { method: "PATCH", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["royal-score-events"] });
    },
  });
}

/**
 * ПРЕДЛОЖЕНИЯ РЕАКТИВАЦИИ (разбор 31.08.2026, п.12) — «мои», ждущие решения.
 *
 * Отдельный список, а не фильтр по useClients: пока предложение висит,
 * карточка НЕ закреплена за агентом формально (assignedAgentId может быть
 * пустым — см. services/leads/intake.ts), поэтому в обычный «мой портфель»
 * (useClients с assignedAgentId=я на сервере) она вообще не попадает.
 */
export interface ReactivationOffer {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  kind: "BUYER" | "SELLER" | "OTHER";
  reactivationOfferedAt: string;
  requirementsNotes: string | null;
}

export function useReactivationOffers() {
  return useQuery({
    queryKey: ["reactivation-offers"],
    queryFn: () => api<{ items: ReactivationOffer[] }>("/clients/reactivation-offers"),
    select: (data) => data.items,
  });
}

export function useAcceptReactivationOffer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/clients/${id}/reactivation-offer/accept`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reactivation-offers"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["mission-control"] });
    },
  });
}

export function useDeclineReactivationOffer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/clients/${id}/reactivation-offer/decline`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reactivation-offers"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client"] });
      qc.invalidateQueries({ queryKey: ["mission-control"] });
    },
  });
}

/**
 * ПРОВЕРКА НА ДУБЛЬ ПРИ РАЗДАЧЕ (раздел L, 03.09.2026, план вечерней сессии §L) —
 * «мои» вопросы «это ваш клиент?»: похожая новая заявка придержана и ждёт ответа
 * агента, за которым закреплена похожая карточка-кандидат. Тот же приём, что
 * useReactivationOffers выше — пока проверка не решена, придержанная карточка не
 * закреплена ни за кем формально (assignedAgentId пуст), поэтому это отдельный
 * список, а не фильтр по обычному портфелю.
 */
export interface DuplicateReviewCandidateClient {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  assignedAgent: { fullName: string } | null;
}

export interface DuplicateReviewItem {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  kind: "BUYER" | "SELLER" | "OTHER";
  duplicateReviewAskedAt: string;
  duplicateReviewDueAt: string | null;
  duplicateReviewMatchedBy: string | null;
  duplicateReviewOfClient: DuplicateReviewCandidateClient | null;
}

export function useDuplicateReviews(all = false) {
  return useQuery({
    queryKey: ["duplicate-reviews", all],
    queryFn: () => api<{ items: DuplicateReviewItem[] }>(`/clients/duplicate-reviews${all ? "?all=1" : ""}`),
    select: (data) => data.items,
  });
}

function invalidateAfterDuplicateReview(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["duplicate-reviews"] });
  qc.invalidateQueries({ queryKey: ["clients"] });
  qc.invalidateQueries({ queryKey: ["client"] });
  qc.invalidateQueries({ queryKey: ["client-duplicates"] });
  qc.invalidateQueries({ queryKey: ["mission-control"] });
}

/** «Да, мой клиент» — карточки сливаются, придержанная заявка не считается новым
 *  принятым лидом (владелец, явное условие §L). */
export function useConfirmDuplicateReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/clients/${id}/duplicate-review/confirm`, { method: "POST" }),
    onSuccess: () => invalidateAfterDuplicateReview(qc),
  });
}

/** «Нет, разные люди» — придержка снимается, заявка уходит в обычную раздачу. */
export function useDenyDuplicateReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>(`/clients/${id}/duplicate-review/deny`, { method: "POST" }),
    onSuccess: () => invalidateAfterDuplicateReview(qc),
  });
}
