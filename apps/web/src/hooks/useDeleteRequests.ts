import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeleteRequestReason, DeleteRequestStatus, PropertyDeleteRequestReason, Currency } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Заявки агента на удаление клиента (решение владельца 30.08.2026).
 *
 * Отдельный файл, а не хвост useClients.ts: это не работа с карточкой, а своя
 * очередь на рассмотрение — ровно как проверки СБ живут в useSecurity.ts.
 */
export interface DeleteRequestClient {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  kind: string;
  status: string;
  deletedAt: string | null;
  assignedAgent: { id: string; fullName: string } | null;
  /** Агент недавно спрашивал у этого клиента номер телефона (владелец
   *  07.09.2026) — подсказка перед решением, не блокировка. */
  phoneAskFlaggedAt: string | null;
}

export interface DeleteRequest {
  id: string;
  status: DeleteRequestStatus;
  reason: DeleteRequestReason;
  /** Готовая подпись причины с сервера — у продавца и покупателя они разные. */
  reasonLabel: string;
  comment: string | null;
  commentVoiceUrl?: string | null;
  commentVoiceTranscript?: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  requestedBy: { id: string; fullName: string } | null;
  decidedBy: { id: string; fullName: string } | null;
  client: DeleteRequestClient;
}

/** Заявка по конкретной карточке, если она ещё ждёт решения (иначе null). */
export interface PendingDeleteRequest {
  id: string;
  status: DeleteRequestStatus;
  reason: DeleteRequestReason;
  reasonLabel: string;
  comment: string | null;
  commentVoiceUrl?: string | null;
  commentVoiceTranscript?: string | null;
  createdAt: string;
  requestedBy: { id: string; fullName: string } | null;
}

/** Очередь руководства. Поллинг не нужен: экран открывают, чтобы разобрать.
 *
 * Но это же используется как фоновый счётчик значка в `lib/navigation.ts` —
 * там хук смонтирован постоянно, у любого раздела, а глобальный дефолт
 * `refetchInterval: 25_000` (queryClient.ts) всё равно опрашивал его каждые
 * 25 с. Найдено 08.09.2026 (QA3 B-1): на быстрой навигации это давало пачку
 * запросов чаще лимитера (`apiLimiter`, общий на ВСЕ роуты api.ts), и 429 по
 * этому эндпоинту утаскивал за собой соседние запросы в том же окне. Явный
 * интервал явно длиннее и снимает лишнюю фоновую нагрузку — бейджу очереди
 * заявок не нужна секундная свежесть. */
export function useDeleteRequests(enabled = true) {
  return useQuery({
    queryKey: ["delete-requests", "PENDING"],
    queryFn: () => api<{ items: DeleteRequest[] }>("/clients/delete-requests?status=PENDING"),
    enabled,
    staleTime: 60_000,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
  });
}

/** Есть ли по карточке заявка, ждущая решения — от этого зависит, кнопку
 *  показывать или строку «заявка отправлена». */
export function usePendingDeleteRequest(clientId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["client-delete-request", clientId],
    queryFn: () => api<{ request: PendingDeleteRequest | null }>(`/clients/${clientId}/delete-request`),
    enabled: enabled && !!clientId,
  });
}

export function useRequestDeleteClient(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      reason: DeleteRequestReason;
      comment?: string;
      voiceNoteUrl?: string;
      voiceNoteTranscript?: string;
    }) =>
      api<{ ok: boolean; id: string; message: string }>(`/clients/${clientId}/delete-request`, {
        method: "POST",
        body,
      }),
    // silent: окно само показывает результат — общий тост дублировал бы его
    // вторым уведомлением подряд (то же решение, что в useRefuseClient).
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client-delete-request", clientId] });
      qc.invalidateQueries({ queryKey: ["delete-requests"] });
    },
  });
}

export function useApproveDeleteRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; decisionNote?: string }) =>
      api<{ ok: boolean; message: string }>(`/clients/delete-requests/${vars.id}/approve`, {
        method: "POST",
        body: { decisionNote: vars.decisionNote },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["delete-requests"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["clients-trash"] });
    },
  });
}

export function useRejectDeleteRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; decisionNote: string }) =>
      api<{ ok: boolean; message: string }>(`/clients/delete-requests/${vars.id}/reject`, {
        method: "POST",
        body: { decisionNote: vars.decisionNote },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["delete-requests"] });
    },
  });
}

/**
 * Заявки агента на удаление ОБЪЕКТА (31.08.2026) — зеркало заявок на удаление
 * клиента выше, то же устройство и тот же API-путь, только для карточки объекта.
 */
export interface DeleteRequestProperty {
  id: string;
  shortId: number;
  title: string;
  price: string;
  currency: Currency;
  status: string;
  deletedAt: string | null;
  assignedAgent: { id: string; fullName: string } | null;
}

/**
 * ДОСЬЕ К КНОПКЕ «ОДОБРИТЬ» (16.09.2026) — то, что система знает про объект,
 * рядом с причиной, которую написал агент. Дословная тревога владельца: «я могу
 * по ошибке одобрить, не зная всей картины». `null` — сервер старой версии.
 */
export interface PropertyDeleteDossier {
  showingsCount: number;
  lastShowingAt: string | null;
  lastShowingAgentName: string | null;
  lastShowingClientName: string | null;
  lastShowingClientShortId: number | null;
  buyerSilent: boolean;
  sellerAnsweredAfterShowing: boolean | null;
  hasDeal: boolean;
  sellerProbeOutcome: string | null;
  lines: string[];
  hasConcerns: boolean;
}

export interface PropertyDeleteRequest {
  id: string;
  status: DeleteRequestStatus;
  reason: PropertyDeleteRequestReason;
  reasonLabel: string;
  comment: string | null;
  commentVoiceUrl?: string | null;
  commentVoiceTranscript?: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  requestedBy: { id: string; fullName: string } | null;
  decidedBy: { id: string; fullName: string } | null;
  property: DeleteRequestProperty;
  dossier: PropertyDeleteDossier | null;
}

export interface PendingPropertyDeleteRequest {
  id: string;
  status: DeleteRequestStatus;
  reason: PropertyDeleteRequestReason;
  reasonLabel: string;
  comment: string | null;
  commentVoiceUrl?: string | null;
  commentVoiceTranscript?: string | null;
  createdAt: string;
  requestedBy: { id: string; fullName: string } | null;
}

/** Очередь руководства по объектам. Поллинг не нужен: экран открывают, чтобы
 * разобрать — тот же фикс интервала, что и у useDeleteRequests выше (08.09.2026). */
export function usePropertyDeleteRequests(enabled = true) {
  return useQuery({
    queryKey: ["property-delete-requests", "PENDING"],
    queryFn: () => api<{ items: PropertyDeleteRequest[] }>("/properties/delete-requests?status=PENDING"),
    enabled,
    staleTime: 60_000,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
  });
}

/** Есть ли по объекту заявка, ждущая решения. */
export function usePendingPropertyDeleteRequest(propertyId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["property-delete-request", propertyId],
    queryFn: () => api<{ request: PendingPropertyDeleteRequest | null }>(`/properties/${propertyId}/delete-request`),
    enabled: enabled && !!propertyId,
  });
}

export function useRequestDeleteProperty(propertyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      reason: PropertyDeleteRequestReason;
      comment?: string;
      voiceNoteUrl?: string;
      voiceNoteTranscript?: string;
    }) =>
      api<{ ok: boolean; id: string; message: string }>(`/properties/${propertyId}/delete-request`, {
        method: "POST",
        body,
      }),
    // silent: окно само показывает результат — общий тост дублировал бы его
    // вторым уведомлением подряд.
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["property-delete-request", propertyId] });
      qc.invalidateQueries({ queryKey: ["property-delete-requests"] });
    },
  });
}

export function useApprovePropertyDeleteRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; decisionNote?: string }) =>
      api<{ ok: boolean; message: string }>(`/properties/delete-requests/${vars.id}/approve`, {
        method: "POST",
        body: { decisionNote: vars.decisionNote },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["property-delete-requests"] });
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["properties-trash"] });
    },
  });
}

export function useRejectPropertyDeleteRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; decisionNote: string }) =>
      api<{ ok: boolean; message: string }>(`/properties/delete-requests/${vars.id}/reject`, {
        method: "POST",
        body: { decisionNote: vars.decisionNote },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["property-delete-requests"] });
    },
  });
}

/**
 * ЗАЯВКА НА ПЕРЕСМОТР ЧИСЛА ОБЪЕКТОВ (владелец 06.09.2026, разбор слепых зон
 * п.3; роль добавлена 07.09.2026 — «пусть у покупателя будет тоже самое») —
 * то же устройство: число пишет ИИ, агент оспаривает, решает руководитель
 * (право clients.merge). role различает сторону: SELLER — карточка продавца
 * (sellerDeclaredPropertyCount), BUYER — карточка покупателя
 * (buyerDesiredPropertyCount). У dualIntent-клиента обе стороны независимы.
 */
export type PropertyCountDisputeRole = "SELLER" | "BUYER";

export interface PropertyCountDisputeClient {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  sellerDeclaredPropertyCount: number | null;
  buyerDesiredPropertyCount: number | null;
}

export interface PropertyCountDispute {
  id: string;
  role: PropertyCountDisputeRole;
  status: DeleteRequestStatus;
  aiCount: number;
  proposedCount: number;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  requestedBy: { id: string; fullName: string } | null;
  decidedBy: { id: string; fullName: string } | null;
  client: PropertyCountDisputeClient;
}

export interface PendingPropertyCountDispute {
  id: string;
  role: PropertyCountDisputeRole;
  status: DeleteRequestStatus;
  aiCount: number;
  proposedCount: number;
  reason: string;
  createdAt: string;
  requestedBy: { id: string; fullName: string } | null;
}

/** Очередь руководства. Поллинг не нужен: экран открывают, чтобы разобрать. */
export function usePropertyCountDisputes(enabled = true) {
  return useQuery({
    queryKey: ["property-count-disputes", "PENDING"],
    queryFn: () => api<{ items: PropertyCountDispute[] }>("/clients/property-count-disputes?status=PENDING"),
    enabled,
  });
}

/** Заявки по карточке, ждущие решения — массив: у dualIntent-клиента могут
 *  одновременно висеть заявка на продавца и заявка на покупателя. От этого
 *  зависит, кнопку «Оспорить» показывать по каждой стороне или строку
 *  «заявка отправлена». */
export function usePendingPropertyCountDisputes(clientId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["client-property-count-dispute", clientId],
    queryFn: () => api<{ requests: PendingPropertyCountDispute[] }>(`/clients/${clientId}/property-count-dispute`),
    enabled: enabled && !!clientId,
  });
}

export function useDisputePropertyCount(clientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { role: PropertyCountDisputeRole; proposedCount: number; reason: string }) =>
      api<{ ok: boolean; id: string; message: string }>(`/clients/${clientId}/property-count-dispute`, {
        method: "POST",
        body,
      }),
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client-property-count-dispute", clientId] });
      qc.invalidateQueries({ queryKey: ["property-count-disputes"] });
    },
  });
}

export function useApprovePropertyCountDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; decisionNote?: string }) =>
      api<{ ok: boolean; message: string }>(`/clients/property-count-disputes/${vars.id}/approve`, {
        method: "POST",
        body: { decisionNote: vars.decisionNote },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["property-count-disputes"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["client"] });
    },
  });
}

export function useRejectPropertyCountDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; decisionNote: string }) =>
      api<{ ok: boolean; message: string }>(`/clients/property-count-disputes/${vars.id}/reject`, {
        method: "POST",
        body: { decisionNote: vars.decisionNote },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["property-count-disputes"] });
    },
  });
}
