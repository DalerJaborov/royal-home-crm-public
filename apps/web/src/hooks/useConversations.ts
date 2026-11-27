import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContactProfileView } from "@royal-home/shared";
import { api } from "../lib/api";
import { sendToClient } from "../lib/clientSend";
import { useSendIntent } from "./useSendIntent";
import { currentSessionEpoch, rollbackInSameSession } from "../lib/sessionGuard";
import { keepWhilePaging } from "../lib/keepWhilePaging";
import { ApiError } from "../lib/apiError";
import {
  cancelConversationMediaUpload,
  requestOutgoingMediaCancel,
  requestOutgoingMediaRetry,
  fetchOutgoingMediaJobs,
  reconcileJobBubbles,
  serverJobLocalId,
  uploadConversationMedia,
  waitOutgoingMediaJob,
  type OutgoingMediaJobView,
} from "../lib/mediaUpload";
import { UploadCancelledError } from "../lib/chunkedUpload";
import { useMediaUploadsStore, type PendingMediaUpload } from "../store/mediaUploads";
import type { ConversationMessage, Paginated } from "../types";
import { audioFileNameFor } from "../lib/audioRecording";
import { pausedUntilIso } from "../lib/botPauseOptions";

/**
 * Отказ отправки из-за закрытого 24-часового окна Meta (решение владельца
 * 22.08.2026: «пусть в чате будет предупреждение, а не тихая ошибка») — сервер
 * помечает его отдельным `code` (см. apps/api/src/lib/conversationDelivery.ts),
 * а не только текстом, чтобы интерфейс мог показать другой блок, а не строку
 * общей ошибки сети. Используется и десктопом, и мобильным чатом.
 */
export function isWindowClosedError(err: unknown): boolean {
  return err instanceof ApiError && (err.data as { code?: string } | null)?.code === "window_closed";
}

export interface ConversationFilters {
  q?: string;
  /** «Только Instagram» и т.п.; undefined = все каналы. Произвольная строка —
   *  список каналов приходит с сервера и строится из данных. */
  channel?: string;
  /** В какой НАШ аккаунт написали: Royal Home или Royal Home Info. undefined = все. */
  accountId?: string;
  /** Срез «Ждут человека» (эталон messages.html, `.seg`) — последняя реплика от
   *  клиента, ответа ещё нет. */
  needsHuman?: boolean;
  /** Срез «Бот на паузе». */
  paused?: boolean;
  /** Срез «Мои» — диалоги клиентов, закреплённых за текущим сотрудником. */
  mine?: boolean;
  /** Show one row per exact linked client, with standalone unlinked chats. */
  grouped?: boolean;
  /** «Архив»: переписки без карточки клиента и тише 30 дней (сервер: lib/chatArchive.ts). */
  archived?: boolean;
  page?: number;
}

export interface ConversationListItem {
  id: string;
  channel: string;
  name: string | null;
  clientShortId: string | null;
  lastMessage: Pick<ConversationMessage, "role" | "content" | "by"> | null;
  lastMessageAt: string;
  paused: boolean;
  /** С какого момента диалог ждёт живого человека — последняя реплика от клиента,
   *  ответа ещё нет. null — ждать некого (последний ответил бот/агент). */
  awaitingHumanSince: string | null;
  /** С какого момента стоит ТЕКУЩАЯ пауза — только пока она действует. */
  pausedSince: string | null;
  /** Есть новое входящее, которое ещё не открывали в инбоксе. */
  unread: boolean;
  /**
   * СКОЛЬКО непрочитанных реплик — хвост подряд идущих сообщений клиента после
   * последнего ответа бота или агента (владелец 12.09.2026: «покажи числом, а
   * не точкой»). 0 при прочитанном диалоге.
   *
   * Необязательно: вкладка, открытая до выката, продолжает работать на одном
   * `unread` — список тогда рисует точку, как раньше.
   */
  unreadCount?: number;
  /** Строка в архиве у этого зрителя (27.11.2026): в поиске показывает «Вернуть». */
  archived?: boolean;
  messagesCount: number;
  /** Наш аккаунт-получатель: показывается меткой в списке, чтобы не путать переписки. */
  accountId: string | null;
  accountTitle: string | null;
  /** Клиент попросил живого агента, а тот ещё не ответил и не дозвонился
   *  (владелец 18.09.2026) — список ставит такой диалог первым и красным,
   *  пока это не null. Гасится реальным ответом/звонком закреплённого агента. */
  agentAttentionRequestedAt: string | null;
  /** Имени нет вовсе (ни карточки, ни профиля канала): тогда `name` собран из интереса, а кружок несёт его метку. */
  unnamed?: boolean;
  /** Что человеку нужно, по тому, что бот уже собрал: «Ищет 2к · Шохмансур», «до 650 тыс.», «2к». */
  interest?: { title: string; budget: string | null; badge: string | null; kind: "buy" | "rent" | "sell" | "job" | null } | null;
  /** Подписанная ссылка на фото из профиля канала (Instagram, Messenger, Telegram); null: фото нет или канал его не отдаёт. */
  avatarUrl?: string | null;
  /** Чем красить кружок: закреплено за человеком, а не за строкой. */
  avatarSeed?: string;
  /** Source conversation IDs represented by this row (grouped inbox only). */
  sourceConversationIds?: string[];
  /** Channels represented by this row (hidden unless clients.viewOrigin). */
  channels?: string[];
}

/** Ответ списка диалогов: пагинация + фактический список каналов для фильтра. */
export interface InboxAccount {
  id: string;
  title: string;
  channel: string;
}

/** Счётчики срезов `.seg .n` — «Все / Ждут человека / Бот на паузе / Мои». */
export interface ConversationSegmentCounts {
  all: number;
  needsHuman: number;
  paused: number;
  mine: number;
  /** Сколько переписок лежит в «Архиве»; нет поля, пока сервер старый или рубильник выключен. */
  archived?: number;
}

/** Тихие строки сверху инбокса (`.quiet.crit` / `.quiet.warn`, эталон messages.html). */
export interface ConversationAlerts {
  longestWaitingHuman: { id: string; name: string | null; waitingMinutes: number } | null;
  pausedOverDay: { count: number; names: string[] };
}

export type ConversationsPage = Omit<Paginated<ConversationListItem>, "total"> & {
  total: number | null;
  channels: string[];
  /** Подключённые аккаунты — для переключателя над списком. */
  accounts: InboxAccount[];
  counts: ConversationSegmentCounts | null;
  /** Рубильник «Архив чатов» (Настройки): выключен, пункта «Архив» нет. */
  archiveEnabled?: boolean;
  /** Grouped source loading reached the safety cap; totals and segment counts are intentionally omitted. */
  groupedIncomplete?: boolean;
  alerts: ConversationAlerts;
};

export interface ConversationDetail {
  id: string;
  channel: string | null;
  name: string | null;
  /** Имя профиля из соцсети (как прислал мессенджер) — может отличаться от ФИО в CRM. */
  profileName: string | null;
  /** ID подписчика на бот-платформе — стабильный идентификатор профиля. */
  subscriberId: string | null;
  clientId: string | null;
  clientShortId: string | null;
  clientPhone: string | null;
  firstContactAt: string;
  pausedUntil: string | null;
  /**
   * Бота остановил ЩИТ ИСХОДЯЩИХ (17.09.2026, apps/api/src/lib/outboundShield.ts):
   * причина по-русски приходит с сервера, потому что там же живут сами правила.
   * null — пауза обычная (оператор, ручной ответ) или её нет вовсе.
   */
  shieldPause: { reason: string; reasonText: string; until: string } | null;
  messages: ConversationMessage[];
  /**
   * Досье собеседника — ровно то, что бот прочитает перед следующим ответом
   * (apps/api/src/lib/contactProfileView.ts). null у диалогов, начатых раньше,
   * чем досье появились: панель об этом пишет прямо, а не показывает пустоту.
   */
  contact: ContactProfileView | null;
  /** Миниатюра и закреплённый цвет собеседника — те же, что у строки списка (шапка переписки). */
  avatarUrl?: string | null;
  avatarSeed?: string | null;
  /** Source metadata for messages in a grouped timeline. */
  grouped?: boolean;
  sources?: Array<{ id: string; channel: string | null; canReply: boolean; pausedUntil: string | null }>;
}

/** Срез списка чатов (эталон messages.html, `#tpl-messages`, `.seg`): «Все / Ждут
 *  человека / Бот на паузе / Мои». Взаимоисключающие, в отличие от канала/аккаунта —
 *  сервер сам считает счётчики каждого среза независимо от остальных фильтров
 *  (GET /conversations, поле `counts`), а показывать сразу два среза разом
 *  («ждут человека» ∩ «мои») мокет не просит. Живёт здесь, а не в pages/Messages.tsx:
 *  тип нужен и components/mobile/MobileChatsList.tsx, а тот файл уже импортирует
 *  саму страницу Messages.tsx под свой заголовок — обратный импорт замкнул бы цикл. */
export type ChatSegment = "all" | "needsHuman" | "paused" | "mine" | "archive";

export function segmentFromFilters(filters: ConversationFilters): ChatSegment {
  if (filters.needsHuman) return "needsHuman";
  if (filters.paused) return "paused";
  if (filters.mine) return "mine";
  if (filters.archived) return "archive";
  return "all";
}

function toQuery(filters: ConversationFilters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.accountId) params.set("accountId", filters.accountId);
  if (filters.needsHuman) params.set("needsHuman", "1");
  if (filters.paused) params.set("paused", "1");
  if (filters.mine) params.set("mine", "1");
  if (filters.grouped) params.set("grouped", "1");
  if (filters.archived) params.set("archived", "1");
  if (filters.page) params.set("page", String(filters.page));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Список диалогов бота — лента живая, поллинг раз в 15с. */
export function useConversations(filters: ConversationFilters = {}, options?: { enabled?: boolean }) {
  return useQuery<ConversationsPage>({
    queryKey: ["conversations", filters],
    queryFn: () => api(`/conversations${toQuery(filters)}`),
    placeholderData: keepWhilePaging<ConversationsPage>(["conversations", filters]),
    // Список тянет переписку целиком, поэтому опрашиваем редко и только
    // пока вкладка на виду: у фонового окна смысла в живом опросе нет.
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (12.09.2026). Свежесть держит поток
    // событий (lib/liveEvents.ts): сервер сам говорит, что обновилось.
    // Таймер оставлен на случай, когда поток не дошёл — прокси срезал
    // соединение, телефон спал, флаг LIVE_EVENTS=0, — поэтому он редкий,
    // а не выключенный.
    refetchInterval: 300_000,
    refetchIntervalInBackground: false,
    // Роль без доступа к инбоксу не должна ходить за 403 каждые 15 секунд.
    enabled: options?.enabled ?? true,
  });
}

/** Открытый диалог обновляем чаще: оператор ждёт реплику клиента в реальном времени.
 *  Сервер при открытии помечает диалог прочитанным (readAt) — синхронно гасим
 *  синий индикатор в закэшированных страницах списка, не дожидаясь поллинга. */
export function useConversation(id: string | null, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  return useQuery<ConversationDetail>({
    queryKey: ["conversations", id],
    queryFn: async () => {
      const detail = await api<ConversationDetail>(`/conversations/${id}`);
      queryClient.setQueriesData<ConversationsPage>(
        { queryKey: ["conversations"], exact: false },
        (old) =>
          old && Array.isArray(old.items)
            ? { ...old, items: old.items.map((c) => (c.id === id ? { ...c, unread: false, unreadCount: 0 } : c)) }
            : old
      );
      return detail;
    },
    enabled: !!id && (options?.enabled ?? true),
    // Было 8 секунд, потом 60 — теперь новое сообщение приезжает событием
    // message.new мгновенно, а таймер лишь страхует на случай, когда поток
    // не дошёл (22.09.2026: часть шторма 429 — вклад одной открытой вкладки).
    refetchInterval: 120_000,
  });
}

/** Grouped inbox detail is opt-in so existing single-conversation consumers keep
 * their established API and cache contract. */
export function useGroupedConversation(id: string | null) {
  const queryClient = useQueryClient();
  return useQuery<ConversationDetail>({
    // Existing live events and send/pause/media mutations invalidate this prefix.
    queryKey: ["conversations", "groups", id],
    queryFn: async () => {
      const detail = await api<ConversationDetail>(`/conversations/groups/${encodeURIComponent(id!)}`);
      queryClient.setQueriesData<ConversationsPage>(
        { queryKey: ["conversations"], exact: false },
        old => old && Array.isArray(old.items)
          ? { ...old, items: old.items.map(c => c.id === id ? { ...c, unread: false, unreadCount: 0 } : c) }
          : old,
      );
      return detail;
    },
    enabled: !!id,
    refetchInterval: 120_000,
  });
}

/**
 * Стоимость ИИ по одному диалогу (13.09.2026, «стоимость разговора нигде не
 * видна» — владелец). Служебная финансовая цифра — вызывающий сам решает,
 * рендерить ли её, глядя на useCan("finance.view") (см. lib/permissions.ts);
 * хук не проверяет право сам, чтобы не дублировать источник правды на каждом
 * месте использования. 403 от сервера (агент без finance.view) — молчаливо
 * null, а не ошибка тоста: значит спросили не по праву, а не что-то упало.
 */
export function useAiConversationCost(conversationId: string | null, enabled = true) {
  return useQuery<{ costUsd: number | null; callCount: number }>({
    queryKey: ["ai-cost", conversationId],
    queryFn: () => api<{ costUsd: number | null; callCount: number }>(`/ai/cost?conversationId=${conversationId}`),
    enabled: enabled && !!conversationId,
    staleTime: 30_000,
    meta: { silent: true },
  });
}

export function useReplyToConversation(id: string | null) {
  const queryClient = useQueryClient();
  // Ключ повтора: обрыв связи и второе нажатие не дают клиенту два сообщения (lib/clientSend.ts).
  const intent = useSendIntent();
  return useMutation({
    mutationFn: ({ text, pausedUntil }: { text: string; pausedUntil?: string }) =>
      sendToClient(intent, `/conversations/${id}/reply`, { text, pausedUntil }),
    // silent: отправка сообщения клиенту — не сохранение, а тост «Сохранено» именно
    // это и утверждал. Успех виден сам: реплика появляется в переписке. Отказ обе
    // формы — Messages.tsx и mobile/MobileChatView.tsx — печатают строкой под
    // полем ввода (включая отдельный текст про закрытое окно ответа), и текст там
    // набранный не теряется. Общий тост дублировал её (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    // ОПТИМИСТИЧНО (06.09.2026, исследование про Telegram/WhatsApp): своя реплика
    // раньше появлялась только после ответа сервера — при плохой связи или на
    // мобильном интернете это читалось как «зависло». Фото/видео такой приём уже
    // получили (useUploadConversationMediaWithProgress), тексту его не хватало.
    // Кладём пузырь в кэш СРАЗУ, реальная запись с сервера придёт следующим
    // опросом (refetchInterval у useConversation) и просто заменит этот массив
    // целиком — задваивания не будет.
    onMutate: async ({ text }) => {
      if (!id) return {};
      await queryClient.cancelQueries({ queryKey: ["conversations", id] });
      const previous = queryClient.getQueryData<ConversationDetail>(["conversations", id]);
      queryClient.setQueryData<ConversationDetail>(["conversations", id], (old) =>
        old
          ? {
              ...old,
              messages: [...old.messages, { role: "assistant", content: text, at: new Date().toISOString(), by: { kind: "manual" } }],
            }
          : old
      );
      return { previous, epoch: currentSessionEpoch() };
    },
    // Откат — реплика, которую сервер не принял (например, закрытое окно Meta),
    // не должна оставаться в переписке как будто отправленная.
    onError: (_err, _vars, context) => {
      const previous = context?.previous;
      if (id && previous) {
        rollbackInSameSession(context?.epoch, () => queryClient.setQueryData(["conversations", id], previous));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/** Голосовое из инбокса — тот же диалог, что и useReplyToConversation, но
 *  multipart вместо JSON: файл, а не строка. */
export function useSendVoiceMessage(
  id: string | null,
  /** Срок паузы бота, выбранный при ответе (минуты), читается в момент отправки. Нет — умолчание сервера. */
  pauseMinutes?: () => number | null | undefined
) {
  const queryClient = useQueryClient();
  const intent = useSendIntent();
  return useMutation({
    mutationFn: (blob: Blob) => {
      const form = new FormData();
      form.append("audio", blob, audioFileNameFor(blob.type));
      const minutes = pauseMinutes?.();
      if (minutes) form.append("pausedUntil", pausedUntilIso(minutes));
      return sendToClient<{ ok: boolean; pausedUntil: string }>(intent, `/conversations/${id}/reply-voice`, form);
    },
    // silent: то же, что в useReplyToConversation — отправка, а не сохранение.
    // Отказ VoiceRecordButton отдаёт форме через onError, и обе формы показывают
    // его строкой (`voiceError`) там же, где ошибку текстовой отправки.
    meta: { silent: true },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/** Фото/видео из инбокса (18.08.2026) — тот же приём, что useSendVoiceMessage:
 *  multipart вместо JSON, только поле файла и подпись другие. */
export function useSendMediaMessage(id: string | null) {
  const queryClient = useQueryClient();
  const intent = useSendIntent();
  return useMutation({
    mutationFn: ({ file, caption }: { file: File; caption?: string }) => {
      const form = new FormData();
      form.append("media", file, file.name);
      if (caption) form.append("caption", caption);
      return sendToClient<{ ok: boolean; pausedUntil: string }>(intent, `/conversations/${id}/reply-media`, form);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/**
 * Отправка фото/видео с прогрессом «как в мессенджерах» (18.08.2026).
 *
 * В отличие от useSendMediaMessage (осталась ради простоты для мест без прогресса,
 * если понадобятся) — эта версия сразу кладёт пузырь в стор загрузок
 * (store/mediaUploads.ts), не дожидаясь ответа сервера, и обновляет его прогресс
 * через XMLHttpRequest.upload.onprogress (lib/mediaUpload.ts). Стор — на уровне
 * conversationId, а не в useState компонента, поэтому переключение между диалогами
 * во время загрузки прогресс не теряет.
 */
/** Задания, за которыми эта вкладка уже следит: подъём пузырей с сервера не заводит второй опрос. */
const followedMediaJobs = new Set<string>();

export function useUploadConversationMediaWithProgress(id: string | null) {
  const queryClient = useQueryClient();
  const add = useMediaUploadsStore((s) => s.add);
  const setProgress = useMediaUploadsStore((s) => s.setProgress);
  const setLive = useMediaUploadsStore((s) => s.setLive);
  const setError = useMediaUploadsStore((s) => s.setError);
  const setUploading = useMediaUploadsStore((s) => s.setUploading);
  const remove = useMediaUploadsStore((s) => s.remove);

  const setProcessing = useMediaUploadsStore((s) => s.setProcessing);

  /**
   * Файл уже на сервере, сервер сжимает и отправляет (25.11.2026, очередь отправки): пузырь
   * показывает «Сжимаем N% / Отправляем…», пока задание не закончится. Опрос живёт вне
   * компонента — переключение диалогов его не обрывает.
   */
  const follow = useCallback(
    async (conversationId: string, upload: PendingMediaUpload, jobId: string) => {
      const stageOf = (job: OutgoingMediaJobView) =>
        job.status === "QUEUED" ? "queued" : job.status === "PREPARING" ? "compress" : "send";
      followedMediaJobs.add(jobId);
      try {
        // Ответ GET /media-jobs мог прийти раньше ответа на загрузку и завести второй пузырь на то же
        // задание — теперь, когда у загрузки есть номер, дубль убирается (его опрос завершится сам).
        if (upload.localId !== serverJobLocalId(jobId)) remove(conversationId, serverJobLocalId(jobId));
        setProcessing(conversationId, upload.localId, { jobId, stage: "queued", progress: 0 });
        const done = await waitOutgoingMediaJob(conversationId, jobId, (job) => {
          if (job.status === "QUEUED" || job.status === "PREPARING" || job.status === "SENDING") {
            setProcessing(conversationId, upload.localId, { jobId, stage: stageOf(job), progress: job.progress });
          }
        });
        if (done.status === "SENT" || done.status === "CANCELLED") {
          remove(conversationId, upload.localId);
          queryClient.invalidateQueries({ queryKey: ["conversations"] });
          return;
        }
        setError(conversationId, upload.localId, done.error || "Не удалось отправить", done.retryable !== false);
      } finally {
        followedMediaJobs.delete(jobId);
      }
    },
    [queryClient, remove, setError, setProcessing]
  );

  const run = useCallback(
    async (conversationId: string, upload: PendingMediaUpload) => {
      if (!upload.file) return;
      const file = upload.file;
      try {
        // localId живёт с пузырём до успеха: «Повторить» идёт с тем же ключом.
        const result = await uploadConversationMedia(
          conversationId,
          file,
          upload.caption,
          (percent) => setProgress(conversationId, upload.localId, percent),
          upload.uploadKey ?? `media:${upload.localId}`,
          upload.localId,
          (live) => setLive(conversationId, upload.localId, live),
          // Минуты, а не дата: ISO считается в момент «собрать» (на каждой попытке заново), а не при старте долгой загрузки.
          upload.pauseMinutes
        );
        if (result?.queued && result.jobId) {
          await follow(conversationId, upload, result.jobId);
          return;
        }
        // Успех — сама реплика придёт с сервера через инвалидацию, локальный
        // пузырь-заглушку убираем, чтобы не показать её дважды.
        remove(conversationId, upload.localId);
        queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } catch (err) {
        // Отменил человек — пузыря уже нет, ошибку показывать некуда и незачем.
        if (err instanceof UploadCancelledError) return;
        setError(conversationId, upload.localId, err instanceof Error && err.message ? err.message : "Не удалось отправить");
      }
    },
    [queryClient, setProgress, setLive, setError, remove, follow]
  );

  const start = useCallback(
    (file: File, caption?: string, pauseMinutes?: number | null) => {
      if (!id) return;
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const upload: PendingMediaUpload = {
        localId,
        file,
        previewUrl: URL.createObjectURL(file),
        kind: file.type.startsWith("image/") ? "image" : "video",
        caption,
        ...(pauseMinutes ? { pauseMinutes } : {}),
        progress: 0,
        status: "uploading",
      };
      add(id, upload);
      void run(id, upload);
    },
    [id, add, run]
  );

  const retry = useCallback(
    (upload: PendingMediaUpload) => {
      if (!id) return;
      // Файл уже на сервере (задание упало при сжатии или отправке) — повтор без новой загрузки.
      if (upload.jobId) {
        const conversationId = id;
        const jobId = upload.jobId;
        setProcessing(conversationId, upload.localId, { jobId, stage: "queued", progress: 0 });
        void requestOutgoingMediaRetry(conversationId, jobId)
          .then(() => follow(conversationId, upload, jobId))
          .catch((err: unknown) => {
            // Исходника уже нет на сервере (прошли сутки) — грузим файл заново, НОВЫМ ключом
            // повтора: со старым сервер вернул бы ответ первой загрузки — то самое задание (ревью 25.11).
            if ((err as { status?: number }).status === 410) {
              if (!upload.file) {
                setError(conversationId, upload.localId, "Файла уже нет на сервере — выберите его и отправьте заново", false);
                return;
              }
              setUploading(conversationId, upload.localId);
              void run(conversationId, { ...upload, jobId: undefined, uploadKey: `media:${upload.localId}:${Date.now()}` });
              return;
            }
            setError(conversationId, upload.localId, err instanceof Error && err.message ? err.message : "Не удалось повторить");
          });
        return;
      }
      if (!upload.file) return;
      setUploading(id, upload.localId);
      void run(id, upload);
    },
    [id, setUploading, setProcessing, setError, run, follow]
  );

  /**
   * ПУЗЫРИ ПОСЛЕ ПЕРЕЗАГРУЗКИ ВКЛАДКИ (ревью 25.11.2026). Файл уходит в фоне и может упасть,
   * когда вкладку уже закрыли; при открытии переписки сервер называет незавершённые и упавшие
   * за сутки отправки этого сотрудника — пузыри встают на место, опрос продолжается.
   */
  useEffect(() => {
    if (!id) return;
    const conversationId = id;
    let alive = true;
    void fetchOutgoingMediaJobs(conversationId)
      .then(({ jobs }) => {
        if (!alive) return;
        const plan = reconcileJobBubbles(jobs, useMediaUploadsStore.getState().byConversation[conversationId] ?? [], followedMediaJobs);
        for (const localId of plan.removeLocalIds) remove(conversationId, localId);
        for (const job of plan.add) {
          const upload: PendingMediaUpload = {
            localId: serverJobLocalId(job.id),
            file: null,
            previewUrl: "",
            kind: job.kind ?? "video",
            caption: job.caption ?? undefined,
            progress: job.progress,
            status: job.status === "FAILED" ? "error" : "processing",
            error: job.error ?? undefined,
            retryable: job.retryable,
            jobId: job.id,
          };
          add(conversationId, upload);
          if (job.status !== "FAILED") void follow(conversationId, upload, job.id);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, add, remove, follow]);

  const cancel = useCallback(
    (localId: string) => {
      if (!id) return;
      // Сначала оборвать отправку: оставшиеся части не уходят, сборку не зовём —
      // иначе пузырь исчезал, а файл всё равно доходил клиенту (ревью #254).
      cancelConversationMediaUpload(localId);
      // Файл уже на сервере — отменить задание, пока оно не начало уходить клиенту.
      const jobId = useMediaUploadsStore.getState().byConversation[id]?.find((u) => u.localId === localId)?.jobId;
      if (jobId) void requestOutgoingMediaCancel(id, jobId).catch(() => {});
      remove(id, localId);
    },
    [id, remove]
  );

  /**
   * Фото объекта, поставленные в очередь сервером при отправке объекта из чата (26.11.2026): те же пузыри
   * «В очереди / Сжимаем / Отправляем», что у фото из галереи, поднятые по номерам заданий, без файла.
   */
  const adoptJobs = useCallback(
    (jobIds: readonly string[]) => {
      if (!id) return;
      for (const jobId of jobIds) {
        if (followedMediaJobs.has(jobId)) continue;
        const upload: PendingMediaUpload = {
          localId: serverJobLocalId(jobId),
          file: null,
          previewUrl: "",
          kind: "image",
          progress: 0,
          status: "processing",
          jobId,
        };
        add(id, upload);
        void follow(id, upload, jobId);
      }
    },
    [id, add, follow]
  );

  return { start, retry, cancel, adoptJobs };
}

/** Одна переписка или все каналы общего чата клиента (новый вид, ревью #332):
 *  руководитель ставит/снимает паузу разом во всех каналах разговора. */
function botControlIds(id: string | readonly string[] | null): string[] {
  return (Array.isArray(id) ? [...id] : id ? [id as string] : []).filter(Boolean);
}

export function useResumeConversationBot(id: string | readonly string[] | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => Promise.all(botControlIds(id).map((one) => api(`/conversations/${one}/resume`, { method: "POST" }))),
    // Не silent, а свой текст: возврат диалога боту ничего не «сохраняет», но и
    // своей обратной связи у кнопки нет — ни Messages.tsx, ни MobileChatView не
    // рисуют отказ этой мутации. Заглушить её значило бы оставить оператора вовсе
    // без ответа на нажатие, поэтому чиним только неверное слово (раунд 5).
    meta: { successText: "Диалог вернули боту" },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Ночной аудит 24.09.2026 (№5): не гасило ["client"] — карточка клиента
      // (ClientDetail.tsx) продолжала показывать прежнее состояние паузы бота.
      queryClient.invalidateQueries({ queryKey: ["client"] });
    },
  });
}

/** Пауза без отправки сообщения — кнопки-пресеты в шапке инбокса. */
export function usePauseConversationBot(id: string | readonly string[] | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pausedUntil: string) => Promise.all(botControlIds(id).map((one) => api(`/conversations/${one}/pause`, { method: "POST", body: { pausedUntil } }))),
    // См. useResumeConversationBot: своей обратной связи у кнопок-пресетов нет,
    // поэтому тост оставляем — правим только слово.
    meta: { successText: "Бот на паузе — отвечаете вы" },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Ночной аудит 24.09.2026 (№5): то же самое для паузы.
      queryClient.invalidateQueries({ queryKey: ["client"] });
    },
  });
}
