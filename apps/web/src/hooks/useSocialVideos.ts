import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  SocialVideoAiCaptionRequest,
  SocialVideoAiCaptionResponse,
  SocialVideoAiCoverRequest,
  SocialVideoAiProvidersResponse,
  SocialVideoChannel,
  SocialVideoChannelInfo,
  SocialVideoChannelLive,
  SocialVideoDestination,
  SocialVideoItem,
  SocialVideoListResponse,
  SocialVideoRemovalOutcome,
  SocialVideoStatus,
  SocialVideoTrends,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { uploadSocialVideo, type SocialVideoUploadInput } from "../lib/socialVideoUpload";

/**
 * Хуки экрана «Ролики в соцсети» (12.10.2026). Пути — `/api/v1/social-videos`,
 * контракт — `packages/shared/src/socialVideo.ts`. Ключи запросов с общим
 * префиксом `["social-videos"]`: любая мутация гасит весь префикс разом, и
 * список, вкладки-счётчики и открытая карточка не расходятся.
 */

const ROOT = ["social-videos"] as const;
const listKey = (tab: SocialVideoTab, limit: number) => [...ROOT, "list", tab, limit] as const;
const itemKey = (id: string) => [...ROOT, "item", id] as const;
const CHANNELS_KEY = [...ROOT, "channels"] as const;
const LIVE_KEY = [...ROOT, "channels-live"] as const;
const PROVIDERS_KEY = [...ROOT, "ai-providers"] as const;
const TRENDS_KEY = [...ROOT, "trends"] as const;

/** Пока ролик публикуется, экран спрашивает сервер раз в столько миллисекунд. */
export const SOCIAL_VIDEO_POLL_MS = 3000;

/** Вкладки списка. «Ошибки» — это PARTIAL + FAILED, у API на них два отдельных статуса. */
export type SocialVideoTab = "ALL" | "DRAFT" | "SCHEDULED" | "PUBLISHING" | "DONE" | "ERRORS" | "REMOVED";

const TAB_STATUSES: Record<SocialVideoTab, (SocialVideoStatus | undefined)[]> = {
  ALL: [undefined],
  DRAFT: ["DRAFT"],
  SCHEDULED: ["SCHEDULED"],
  PUBLISHING: ["PUBLISHING"],
  DONE: ["DONE"],
  ERRORS: ["PARTIAL", "FAILED"],
  REMOVED: ["REMOVED"],
};

function listPath(status: SocialVideoStatus | undefined, limit: number): string {
  const q = new URLSearchParams({ limit: String(limit), offset: "0" });
  if (status) q.set("status", status);
  return `/social-videos?${q.toString()}`;
}

/** Сам ли ролик ещё в работе у сервера — тогда экран продолжает опрос. */
const hasPublishing = (data: SocialVideoListResponse | undefined): boolean =>
  !!data && (data.counts.PUBLISHING > 0 || data.items.some((i) => i.status === "PUBLISHING"));

/**
 * Список роликов вкладки. «Ошибки» собираются из двух запросов (PARTIAL и FAILED)
 * и склеиваются по дате создания — отдельного фильтра «оба статуса» у API нет.
 * `limit` растёт кнопкой «Показать ещё», offset всегда 0: так список остаётся
 * целым при опросе и новые ролики не сдвигают страницы.
 */
export function useSocialVideoList(tab: SocialVideoTab, limit: number, enabled = true) {
  const statuses = TAB_STATUSES[tab];
  const results = useQueries({
    queries: statuses.map((status) => ({
      queryKey: [...listKey(tab, limit), status ?? "all"],
      queryFn: () => api<SocialVideoListResponse>(listPath(status, limit)),
      enabled,
      refetchInterval: (query: { state: { data: SocialVideoListResponse | undefined } }) =>
        hasPublishing(query.state.data) ? SOCIAL_VIDEO_POLL_MS : false,
      placeholderData: (prev: SocialVideoListResponse | undefined) => prev,
    })),
  });

  const loaded = results.map((r) => r.data).filter((d): d is SocialVideoListResponse => !!d);
  const items = loaded
    .flatMap((d) => d.items)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
  return {
    items,
    total: loaded.reduce((sum, d) => sum + d.total, 0),
    counts: loaded[0]?.counts,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
    error: (results.find((r) => r.error)?.error as Error | null | undefined) ?? null,
    refetch: () => Promise.all(results.map((r) => r.refetch())),
  };
}

/** Один ролик. Опрашивается раз в 3 с, пока статус PUBLISHING. */
export function useSocialVideo(id: string | null) {
  return useQuery({
    queryKey: itemKey(id ?? "none"),
    queryFn: () => api<SocialVideoItem>(`/social-videos/${id}`),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.status === "PUBLISHING" ? SOCIAL_VIDEO_POLL_MS : false),
  });
}

/** Быстро: подключён ли канал и его запасные лимиты. */
export function useSocialVideoChannels(enabled = true) {
  return useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: () => api<{ channels: SocialVideoChannelInfo[] }>("/social-videos/channels").then((r) => r.channels),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Медленно (до ~8 с): квоты, лимиты и живость токенов из API самих площадок.
 * Грузится отдельно и не блокирует экран; результат держим 5 минут.
 */
export function useSocialVideoChannelsLive(enabled = true) {
  return useQuery({
    queryKey: LIVE_KEY,
    queryFn: () => api<{ channels: SocialVideoChannelLive[] }>("/social-videos/channels/live").then((r) => r.channels),
    enabled,
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

/** Принудительно перечитать живые данные (`?refresh=1`) и положить в тот же кэш. */
export function useRefreshSocialVideoChannelsLive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ channels: SocialVideoChannelLive[] }>("/social-videos/channels/live?refresh=1").then((r) => r.channels),
    onSuccess: (channels) => qc.setQueryData(LIVE_KEY, channels),
  });
}

/** Ответ-ролик кладём в кэш карточки и гасим списки: статус и счётчики изменились. */
function settleItem(qc: QueryClient, item: SocialVideoItem) {
  qc.setQueryData(itemKey(item.id), item);
  void qc.invalidateQueries({ queryKey: [...ROOT, "list"] });
}

/** Создать черновик: файл едет по XHR с прогрессом. */
export function useCreateSocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SocialVideoUploadInput) => uploadSocialVideo(input),
    onSuccess: (item) => settleItem(qc, item),
  });
}

export function useUpdateSocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    // Автосохранение на каждую букву и опцию — без всплывающего «Сохранено» и звука (общий обработчик
    // queryClient.ts показывает их на любую мутацию). Явное «Сохранить черновик» подтверждает себя само.
    meta: { silent: true },
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      title?: string;
      caption?: string;
      brief?: string | null;
      channels?: SocialVideoChannel[];
      destinations?: SocialVideoDestination[];
    }) => api<SocialVideoItem>(`/social-videos/${id}`, { method: "PATCH", body }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

/** Подписи от ИИ: 5-20 с, общий потолок `api()` в 30 с хватает, но берём с запасом. */
export function useGenerateSocialVideoCaption() {
  return useMutation({
    mutationFn: (body: SocialVideoAiCaptionRequest) =>
      api<SocialVideoAiCaptionResponse>("/social-videos/ai-caption", { method: "POST", body, timeoutMs: 90_000 }),
  });
}

export function useUploadSocialVideoCover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("cover", file, file.name);
      return api<SocialVideoItem>(`/social-videos/${id}/cover`, { method: "POST", body: form });
    },
    onSuccess: (item) => settleItem(qc, item),
  });
}

/**
 * Кто рисует обложку и можно ли его выбрать (ключ введён). Грузится, когда открыт блок «Нарисует ИИ».
 * Ключи в Настройках меняются редко — держим минуту.
 */
export function useSocialVideoAiProviders(enabled = true) {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => api<SocialVideoAiProvidersResponse>("/social-videos/ai-providers"),
    enabled,
    staleTime: 60_000,
    retry: 0,
  });
}

/**
 * Свежие тренды оформления обложек. Сервер кэширует сводку на сутки, но первый поиск в интернете
 * может идти дольше обычного запроса, поэтому потолок — минута.
 */
export function useSocialVideoTrends(enabled = true) {
  return useQuery({
    queryKey: TRENDS_KEY,
    queryFn: () => api<SocialVideoTrends>("/social-videos/trends", { timeoutMs: 60_000 }),
    enabled,
    staleTime: 60 * 60_000,
    retry: 0,
  });
}

/** «Обновить тренды»: перечитать из интернета (`?refresh=1`) и положить в тот же кэш. */
export function useRefreshSocialVideoTrends() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: () => api<SocialVideoTrends>("/social-videos/trends?refresh=1", { timeoutMs: 90_000 }),
    onSuccess: (trends) => qc.setQueryData(TRENDS_KEY, trends),
  });
}

/** Обложка от ИИ: 20-90 с (с поиском трендов дольше), поэтому потолок запроса — 3 минуты. */
export function useGenerateSocialVideoCover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, prompt, provider, useFrame, useTrends }: { id: string } & Partial<SocialVideoAiCoverRequest>) =>
      api<SocialVideoItem>(`/social-videos/${id}/cover/ai`, {
        method: "POST",
        body: {
          ...(prompt ? { prompt } : {}),
          ...(provider ? { provider } : {}),
          ...(useFrame !== undefined ? { useFrame } : {}),
          ...(useTrends !== undefined ? { useTrends } : {}),
        },
        timeoutMs: 180_000,
      }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

export function useClearSocialVideoCover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<SocialVideoItem>(`/social-videos/${id}/cover`, { method: "DELETE" }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

export function usePublishSocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      mode: "NOW" | "SCHEDULE";
      scheduledAt?: string;
      channels?: SocialVideoChannel[];
      destinations?: SocialVideoDestination[];
    }) => api<SocialVideoItem>(`/social-videos/${id}/publish`, { method: "POST", body }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

export function useRetrySocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    // `keys` — адреса (destinationKey) для повтора; без них сервер повторяет все упавшие.
    mutationFn: ({ id, channels, keys }: { id: string; channels?: SocialVideoChannel[]; keys?: string[] }) =>
      api<SocialVideoItem>(`/social-videos/${id}/retry`, {
        method: "POST",
        body: { ...(channels ? { channels } : {}), ...(keys ? { keys } : {}) },
      }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

/** Добавить сеть или аккаунт к УЖЕ вышедшему ролику: публикация идёт только в новые адреса (202). */
export function useAddSocialVideoDestinations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, destinations }: { id: string; destinations: SocialVideoDestination[] }) =>
      api<SocialVideoItem>(`/social-videos/${id}/add-destinations`, { method: "POST", body: { destinations } }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

/** Копия ролика черновиком: тот же файл, подпись и адреса, без результатов (201). */
export function useCopySocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<SocialVideoItem>(`/social-videos/${id}/copy`, { method: "POST" }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

/**
 * Снять вышедшие посты из соцсетей (12.10.2026). Без `keys` сервер снимает все вышедшие адреса.
 * Ответ — ролик и итог по адресам (снято / не вышло / надо убрать руками); итог показывает экран.
 * Ошибки 409 (идёт публикация, нечего снимать) приходят текстом сервера.
 */
export function useRemoveSocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, keys }: { id: string; keys?: string[] }) =>
      api<{ item: SocialVideoItem; outcome: SocialVideoRemovalOutcome }>(`/social-videos/${id}/remove-from-socials`, {
        method: "POST",
        body: keys ? { keys } : {},
        timeoutMs: 90_000,
      }),
    onSuccess: ({ item }) => settleItem(qc, item),
  });
}

/** «Я убрал(а) пост вручную» — для площадок, где программа снять не может (TikTok, второй Instagram). */
export function useMarkSocialVideoRemoved() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, keys }: { id: string; keys: string[] }) =>
      api<SocialVideoItem>(`/social-videos/${id}/mark-removed`, { method: "POST", body: { keys } }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

export function useUnscheduleSocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<SocialVideoItem>(`/social-videos/${id}/unschedule`, { method: "POST" }),
    onSuccess: (item) => settleItem(qc, item),
  });
}

export function useDeleteSocialVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/social-videos/${id}`, { method: "DELETE" }),
    onSuccess: (_void, id) => {
      qc.removeQueries({ queryKey: itemKey(id) });
      void qc.invalidateQueries({ queryKey: [...ROOT, "list"] });
    },
  });
}
