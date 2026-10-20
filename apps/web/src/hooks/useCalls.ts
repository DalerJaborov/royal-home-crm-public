import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CallTranscriptionStage } from "@royal-home/shared";
import { api } from "../lib/api";
import { keepWhilePaging } from "../lib/keepWhilePaging";
import type { CallAnalysis } from "../types";

/**
 * Раздел «Звонки» — разговоры агентства.
 *
 * Список сужается сервером: с правом calls.transcripts (директор и админ) приходят
 * разговоры всей команды, без него — только собственные (право calls.ownTranscripts,
 * владелец 15.08.2026). Сводка, ночной разбор, журнал входящих и дашборд станции
 * остаются администрации и агенту не запрашиваются.
 */

export type { CallAnalysis };

export interface CallRow {
  id: string;
  createdAt: string;
  notes: string | null;
  hasRecording: boolean;
  /** Можно ли ИМЕННО ЭТОМУ смотрящему прослушать звук (04.09.2026) — отдельно от
   *  доступа к тексту/разбору, см. lib/callTranscripts.ts. false у обычного
   *  агента даже для собственного разговора. */
  canHear: boolean;
  durationSec: number | null;
  /** Чем кончился дозвон — TALKED/NO_ANSWER/AGENT_NO_PICKUP/CANCELLED, см.
   *  callAttempt в schema.prisma. null — отметка без станции (запись руками
   *  или до 27.08.2026). Не TALKED и не null — разговора не было: интерфейс
   *  показывает недозвон недозвоном, а не пустой строкой с «0:00». */
  callAttempt: string | null;
  /** Оригинал: таджикская речь записана таджикской кириллицей, русская — по-русски. */
  transcript: string | null;
  /** Русский перевод оригинала. null — разговор и так шёл по-русски. */
  transcriptRu: string | null;
  /** Живой статус конвейера — null, пока (или уже) им никто не занят. */
  transcriptionStage: CallTranscriptionStage | null;
  transcriptionProgress: number | null;
  agent: { id: string; fullName: string; avatarUrl: string | null } | null;
  client: { id: string; shortId: number; fullName: string } | null;
  analysis: CallAnalysis | null;
}

/** Подписи недозвона (callAttempt, кроме TALKED и null) — общие для десктопа и
 *  мобильных экранов, чтобы разговор не читался как звонок из «0:00». */
export const CALL_ATTEMPT_LABELS: Record<string, string> = {
  NO_ANSWER: "Клиент не ответил",
  AGENT_NO_PICKUP: "Не подняли трубку",
  CANCELLED: "Отменили вызов",
};

/** Хотя бы один звонок на странице сейчас в работе у конвейера — значит стоит
 *  переспрашивать сервер, а не ждать, пока человек сам обновит страницу. */
function hasActiveTranscription(items: CallRow[] | undefined): boolean {
  return !!items?.some((c) => c.transcriptionStage !== null);
}

export interface CallFilters {
  agentId?: string;
  from?: string;
  to?: string;
  /** Только разговоры без договорённости или со счётом ниже 50. */
  problems?: boolean;
  page?: number;
}

export function useCalls(filters: CallFilters, options?: { enabled?: boolean }) {
  const query = new URLSearchParams();
  if (filters.agentId) query.set("agentId", filters.agentId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.problems) query.set("problems", "1");
  if (filters.page && filters.page > 1) query.set("page", String(filters.page));

  return useQuery<{
    items: CallRow[];
    total: number;
    page: number;
    pageSize: number;
    /** Сервер сузил выборку до собственных разговоров смотрящего. */
    ownOnly: boolean;
  }>({
    queryKey: ["calls", filters],
    queryFn: () => api(`/calls${query.toString() ? `?${query}` : ""}`),
    placeholderData: keepWhilePaging(["calls", filters]),
    enabled: options?.enabled ?? true,
    /**
     * ПОКА КОНВЕЙЕР РАБОТАЕТ НАД ХОТЬ ОДНИМ ЗВОНКОМ НА СТРАНИЦЕ — ПЕРЕСПРАШИВАЕМ
     * КАЖДЫЕ 4 СЕКУНДЫ (владелец 15.08.2026: не сидеть и не ждать вслепую, пока
     * что-то расшифровывается). Как только все звонки на экране либо готовы, либо
     * конвейер ими не занят — поллинг сам выключается: список звонков за месяц
     * незачем дёргать раз в четыре секунды, когда там давно всё тихо.
     */
    refetchInterval: (query) => (hasActiveTranscription(query.state.data?.items) ? 4_000 : false),
  });
}

/**
 * Входящий звонок: клиент позвонил сам. Ни агента, ни разбора у него нет —
 * трубку берёт оператор, которого в CRM нет, — поэтому и поля другие.
 */
export interface IncomingCallRow {
  id: string;
  phone: string;
  startedAt: string;
  endedAt: string | null;
  answered: boolean;
  talkSeconds: number | null;
  /** Внутренний номер оператора, снявшего трубку. */
  answeredBy: string | null;
  /** Имя сотрудника с этим внутренним номером. null — такого в CRM нет, и тогда
   *  показывается сам номер: «оператор 1001» лучше, чем пустое место. */
  answeredByName: string | null;
  client: { id: string; shortId: number; fullName: string; kind: "BUYER" | "SELLER" | "OTHER" } | null;
  /** Кому поставлена задача перезвонить (только у пропущенных). */
  callbackAgent: { id: string; fullName: string } | null;
  /** Когда оператор указал тип обращения. null — звонок ждёт разбора. */
  qualifiedAt: string | null;
  qualifiedBy: { id: string; fullName: string } | null;
  /** Помечен «не по делу»: курьер, реклама, ошиблись номером. Карточки у такого
   *  звонка нет, и следующий звонок с этого номера её тоже не заведёт. */
  irrelevant: boolean;
  /** Карточку завёл сам этот звонок — значит имя в ней могло остаться заглушкой. */
  autoCreatedClient: boolean;
  /** Пропущенный, по которому дольше missedCallbackHours рабочих часов не было
   *  исходящего контакта (Пачка 18, 12.09.2026) — см. missedCallEscalation.ts.
   *  Порог посчитан на бэке: фронт не хранит число часов сам. */
  missingCallback: boolean;
  /** Порог бейджа выше, в часах — подписать бейдж («без перезвона 2ч+»), не зашивая число. */
  missedCallbackHours: number;
}

export function useIncomingCalls(
  filters: {
    missed?: boolean;
    unqualified?: boolean;
    /** Только пропущенные без исходящего контакта дольше порога (Пачка 18). */
    noCallback?: boolean;
    operator?: string;
    page?: number;
    days?: number;
  },
  options?: { enabled?: boolean }
) {
  const query = new URLSearchParams();
  if (filters.missed) query.set("missed", "1");
  if (filters.unqualified) query.set("unqualified", "1");
  if (filters.noCallback) query.set("noCallback", "1");
  // Внутренний номер, а не id сотрудника: журнал хранит именно номер (в момент
  // звонка CRM не знает, кто снимет трубку).
  if (filters.operator) query.set("operator", filters.operator);
  if (filters.page && filters.page > 1) query.set("page", String(filters.page));
  if (filters.days) query.set("days", String(filters.days));

  return useQuery<{
    items: IncomingCallRow[];
    total: number;
    /** Сколько пропущено за период — считается независимо от фильтра. */
    /** Всего за период БЕЗ фильтров — рядом со счётчиками потерь показывать надо
     *  именно его, иначе «7 · пропущено 7» читается как «других звонков не было». */
    periodTotal: number;
    missed: number;
    /** Сколько состоявшихся разговоров ждут разбора — считается независимо от фильтра. */
    unqualified: number;
    page: number;
    pageSize: number;
    days: number;
  }>({
    queryKey: ["incoming-calls", filters],
    queryFn: () => api(`/calls/incoming${query.toString() ? `?${query}` : ""}`),
    placeholderData: keepWhilePaging(["incoming-calls", filters]),
    enabled: options?.enabled ?? true,
  });
}

export interface CallsSummary {
  days: number;
  total: number;
  averageScore: number | null;
  steps: {
    greeted: number;
    foundNeed: number;
    presentedValue: number;
    handledObjection: number;
    agreedNextStep: number;
  } | null;
  agents: {
    agentId: string;
    fullName: string;
    calls: number;
    averageScore: number;
    nextStepShare: number;
    foundNeedShare: number;
  }[];
  objections: { text: string; count: number }[];
}

export interface CallInsight {
  days: number;
  calls: number;
  strengths: string[];
  weaknesses: string[];
  demand: string[];
  actions: string[];
  createdAt: string;
}

/**
 * Ночной разбор: что получается, где теряем, что спрашивает рынок и что делать.
 * Считается раз в сутки моделью — здесь только чтение готового, чтобы открытие
 * раздела ничего не стоило.
 */
export function useCallInsights(options?: { enabled?: boolean }) {
  return useQuery<CallInsight | null>({
    queryKey: ["call-insights"],
    queryFn: () => api<CallInsight | null>("/calls/insights"),
    enabled: options?.enabled ?? true,
    staleTime: 60 * 60_000,
  });
}

export function useCallsSummary(days = 30, options?: { enabled?: boolean }) {
  return useQuery<CallsSummary>({
    queryKey: ["calls-summary", days],
    queryFn: () => api(`/calls/summary?days=${days}`),
    enabled: options?.enabled ?? true,
  });
}

/**
 * ДАШБОРД ТЕЛЕФОНИИ (владелец 11.08.2026: «полноценный дашборд звонилки, как у
 * настоящей АТС»). Один запрос отдаёт всё состояние: связь со станцией, аппараты
 * сотрудников, живые звонки, счётчики за день и действующие настройки.
 */
export interface TelephonyDashboard {
  station: { configured: boolean; online: boolean; registered: number; total: number };
  extensions: { agentId: string; fullName: string; extension: string; online: boolean; knownToStation: boolean }[];
  live: {
    incoming: {
      channelId: string;
      phone: string;
      clientName: string | null;
      clientShortId: number | null;
      answered: boolean;
      answeredBy: string | null;
      /** Имя принявшего; null — сотрудника с таким внутренним номером в CRM нет. */
      answeredByName: string | null;
      seconds: number;
    }[];
    outgoing: { channelId: string; clientName: string; clientShortId: number; state: string; seconds: number }[];
  };
  today: { incoming: number; outgoing: number; missed: number; unqualified: number };
  settings: {
    operators: number;
    pushEnabled: boolean;
    panelEnabled: boolean;
    autoCreateClient: boolean;
    hoursEnabled: boolean;
    hoursStart: string;
    hoursEnd: string;
    forwardPhone: string | null;
    /** Куда станция ведёт входящий: очередь операторов или прямо на аппарат. */
    primaryTarget: "queue" | "extension";
    primaryExtension: string | null;
  };
}

/**
 * Обновляется САМ раз в 5 секунд, пока экран открыт: дашборд станции, на котором
 * «сейчас в эфире» показывает вчерашнее состояние, бесполезен. Пять секунд —
 * компромисс: живой звонок видно почти сразу, а запрос лёгкий (одна выборка из
 * памяти процесса плюс счётчики).
 */
/**
 * СОСТОЯНИЕ В ОЧЕРЕДИ — «я на месте» или «отошёл».
 *
 * Правду говорит станция, а не CRM: звонки распределяет она, и вторая копия
 * признака означала бы «в CRM отошёл, а телефон звонит». `available: false` —
 * управление станцией не настроено или сотрудник не числится в очереди; тогда
 * кнопки нет вовсе, а не «нажимается и ничего не делает».
 */
export interface QueuePauseState {
  available: boolean;
  paused?: boolean;
  queue?: string;
  error?: string;
}

export function useQueuePause(options?: { enabled?: boolean }) {
  return useQuery<QueuePauseState | null>({
    queryKey: ["queue-pause"],
    queryFn: () => api<QueuePauseState | null>("/me/queue-pause"),
    enabled: options?.enabled ?? true,
    // Реже дашборда: состояние меняет сам человек, а запрос идёт до станции через
    // туннель — держать его на пятисекундном опросе незачем.
    refetchInterval: 30_000,
  });
}

export function useSetQueuePause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) =>
      api<{ paused: boolean; queue: string }>("/me/queue-pause", { method: "POST", body: { paused } }),
    // silent: Telephony.tsx уже показывает setPaused.isError своей строкой под
    // кнопкой — общий тост дублировал текст (найдено аудитом 22.08.2026).
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue-pause"] }),
  });
}

/** «Больше не звонить с этого номера» — отбивает станция, ещё до звонка оператору. */
export function useBlockCaller() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ callId, blocked }: { callId: string; blocked: boolean }) =>
      api<{ blocked: boolean }>(`/me/incoming-call/${callId}/block-caller`, { method: "POST", body: { blocked } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incoming-calls"] }),
  });
}

export function useTelephonyDashboard(options?: { enabled?: boolean }) {
  return useQuery<TelephonyDashboard>({
    queryKey: ["telephony-dashboard"],
    queryFn: () => api<TelephonyDashboard>("/calls/telephony/dashboard"),
    enabled: options?.enabled ?? true,
    refetchInterval: 5000,
  });
}

/** Одна строка общей ленты звонков — исходящий, входящий или пропущенный. */
export interface CallFeedRow {
  kind: "OUT" | "IN" | "MISSED";
  id: string;
  at: string;
  client: { id: string; shortId: number; fullName: string } | null;
  /** Номер звонившего — только у входящих и только если право позволяет. */
  phone: string | null;
  durationSec: number | null;
  /** См. CallRow.callAttempt — только у исходящих (kind "OUT"), у входящих null. */
  callAttempt: string | null;
  /** Кто говорил: автор исходящего, снявший трубку или кому назначено перезвонить. */
  agentName: string | null;
  hasRecording: boolean;
  /** См. CallRow.canHear — то же самое право, тот же смысл. */
  canHear: boolean;
  score: number | null;
  /** Содержимое разговора — только у исходящих (см. GET /calls/feed). */
  transcript: string | null;
  transcriptRu: string | null;
  transcriptionStage: string | null;
  transcriptionProgress: number | null;
  analysis: CallRow["analysis"];
}

/**
 * ОБЩАЯ ЛЕНТА ЗВОНКОВ (владелец 20.08.2026: «один общий список, где видно
 * пропущенные, исходящие и так далее»).
 *
 * Курсором, а не страницами: лента склеена сервером из двух таблиц, и номер
 * страницы в ней ничему не соответствует — подробности в комментарии у
 * GET /calls/feed. Здесь достаточно знать, что «дальше» — это момент времени
 * последней показанной строки.
 */
export function useCallFeed(before?: string | null, enabled = true) {
  const query = new URLSearchParams();
  if (before) query.set("before", before);
  return useQuery<{ items: CallFeedRow[]; nextBefore: string | null; ownOnly: boolean }>({
    queryKey: ["call-feed", before ?? null],
    queryFn: () => api(`/calls/feed${query.toString() ? `?${query}` : ""}`),
    enabled,
  });
}
