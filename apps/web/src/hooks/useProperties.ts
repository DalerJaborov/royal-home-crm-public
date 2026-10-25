import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";
import type { BulkTrashItemResult, MatchingClient, SiteSyncItemResult, PropertyRemovalInput } from "@royal-home/shared";
import { api, refreshAccessToken } from "../lib/api";
import { keepWhilePaging, keepWhilePagingIndexed } from "../lib/keepWhilePaging";
import { ApiError } from "../lib/apiError";
import { compressImage } from "../lib/compressImage";
import { getOrCreateDeviceId } from "../lib/deviceId";
import { useAuthStore } from "../store/auth";
import { toast } from "../store/toast";
import { siteSyncFailureText } from "../lib/siteSyncFeedback";
import { withRetryKey, type RetryKey } from "./useRetryKey";
import type { AgentRef, Paginated, Property, PropertyPhoto } from "../types";

export interface PropertyFilters {
  type?: string;
  districtId?: string;
  /** Несколько районов сразу — уходит на сервер строкой через запятую. */
  districtIds?: string[];
  priceMin?: number;
  priceMax?: number;
  rooms?: number;
  /** Площадь в квадратных метрах, границы снизу и сверху. */
  areaMin?: number;
  areaMax?: number;
  status?: string;
  /** «1» — все четыре этапа подготовки сразу (на проверке, ждём фото, ждём
   *  видео, на монтаже). Одна пилюля вместо четырёх в ленте срезов —
   *  см. propertyQuerySchema.inPrep в @royal-home/shared. */
  inPrep?: "1";
  /** «1» — только объекты без ссылки на видео-обзор (очередь монтажёра). */
  noVideo?: "1";
  /** «1» — только объекты с просроченным этапом конвейера. Считает сервер
   *  (routes/properties/list.ts): фильтр по загруженной странице врал бы ровно
   *  на длинной очереди монтажа, то есть там, где список и нужен. */
  overdue?: "1";
  /** «Мои объекты» / «Все объекты» (владелец 21.08.2026) — id интейк-агента,
   *  фильтрует ТУ ЖЕ выдачу, что видна и без параметра: не ограничение доступа,
   *  а удобство поверх общего каталога (см. propertyQuerySchema в @royal-home/shared). */
  agentId?: string;
  /** Объекты конкретного продавца (Property.sellerClientId) — карточка продавца
   *  использует это, чтобы предупредить о повторном создании объекта. */
  sellerClientId?: string;
  q?: string;
  sort?: string;
  page?: number;
}

function toQuery(filters: PropertyFilters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    // Массив районов уходит строкой через запятую; пустой массив — как отсутствие фильтра.
    if (Array.isArray(v)) {
      if (v.length > 0) params.set(k, v.join(","));
      return;
    }
    if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * ОДНА ТОЧКА СБРОСА КЭША ОБЪЕКТА (06.10.2026, карточка объекта, пункт 7 задания).
 *
 * Карточка закеширована под `["property", <shortId из URL>]`, а мутации приходят с
 * настоящим UUID, поэтому точечная инвалидация по id не находит запись. Сбрасываем
 * ПРЕФИКС `["property"]` (карточка, подбор, ссылки) и список `["properties"]`
 * (обложка, статус, число фото в строке). Раньше каждая мутация перечисляла ключи
 * сама, и часть забывала либо карточку (удаление и загрузка видео двигали статус
 * объекта, а чип на экране оставался старым), либо список (фото).
 */
function invalidatePropertyEverywhere(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["properties"] });
  void qc.invalidateQueries({ queryKey: ["property"] });
}

export function useProperties(filters: PropertyFilters, enabled = true) {
  return useQuery({
    queryKey: ["properties", filters],
    queryFn: () => api<Paginated<Property>>(`/properties${toQuery(filters)}`),
    placeholderData: keepWhilePaging<Paginated<Property>>(["properties", filters]),
    enabled,
  });
}

/** Сводная плашка над каталогом (эталон tpl-properties): показов за 30 дней и
 *  просрочка этапа по ВСЕМУ каталогу (не по текущей странице/фильтру) — счёт,
 *  которого не было ни в одном списке. Один GET /properties/summary, тот же
 *  ритм обновления, что у сводки клиентов. */
export interface PropertiesSummary {
  windowDays: number;
  showings30d: number;
  overduePipelineCount: number;
}

export function usePropertiesSummary(enabled = true) {
  return useQuery({
    queryKey: ["properties", "summary"],
    queryFn: () => api<PropertiesSummary>("/properties/summary"),
    enabled,
    staleTime: 30_000,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
  });
}

/** Один объект из `GET /properties/handover/pending` — переданный МНЕ и ещё не
 *  принятый (см. PropertyOwnerCard.tsx). Сокращённая карточка, не полный `Property`. */
export interface HandoverPendingProperty {
  id: string;
  shortId: number;
  title: string;
  address: string | null;
  price: string;
  currency: Property["currency"];
  status: Property["status"];
  handoverPendingSince: string;
  handoverReason: string | null;
  handoverFromAgent: AgentRef | null;
  photos: { url: string }[];
}

/**
 * Объекты, переданные текущему сотруднику и ждущие его «Принять» (плашка
 * баннера над каталогом и чип на карточке в списке, Properties.tsx и
 * MobilePropertiesList.tsx — оба используют один и тот же запрос).
 */
export function useHandoverPendingProperties(enabled = true) {
  return useQuery({
    queryKey: ["properties", "handover-pending"],
    queryFn: () => api<HandoverPendingProperty[]>("/properties/handover/pending"),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Переключатель «Мои объекты» / «Все объекты» (владелец 21.08.2026).
 *
 * Один и тот же кусок правила — «чей это id и как его переключить» — нужен и
 * десктопной таблице (Properties.tsx), и мобильному списку (MobilePropertiesList),
 * у которых разный визуальный язык кнопок. Вынесен сюда, чтобы не заводить вторую
 * копию логики рядом со второй копией вёрстки.
 *
 * Это фильтр поверх ОБЩЕГО каталога, не ограничение доступа: агент и без него видит
 * чужие объекты (см. hint у properties.viewAll в permissions.ts) — кнопка просто
 * сужает список до собственных карточек, интейк-агентом которых он значится.
 */
export function usePropertyScopeToggle(filters: PropertyFilters, setFilters: Dispatch<SetStateAction<PropertyFilters>>) {
  const agent = useAuthStore((s) => s.agent);
  const isMine = !!agent && filters.agentId === agent.id;
  return {
    isMine,
    showMine: () => {
      if (agent) setFilters((f) => ({ ...f, agentId: agent.id, page: 1 }));
    },
    showAll: () => setFilters((f) => ({ ...f, agentId: undefined, page: 1 })),
  };
}

export function useProperty(id: string | undefined) {
  return useQuery({
    queryKey: ["property", id],
    queryFn: () => api<Property>(`/properties/${id}`),
    enabled: !!id,
    // Идёт публикация ролика в сети — карточка обновляется сама, чтобы было видно,
    // какая сеть вышла и что ещё впереди (05.10.2026).
    refetchInterval: (query) => {
      const state = query.state.data?.videoHandoff?.publish?.state;
      return state === "running" ? 4000 : state === "waiting" || state === "retrying" ? 30_000 : false;
    },
  });
}

/**
 * `retryKey` — ключ формы (hooks/useRetryKey.ts): повторное «Сохранить» после
 * обрыва не создаёт второй объект. Потолок ожидания длинный: сервер перед
 * записью ходит к модели за SEO и подписью ролика, 30 секунд ему мало — обрыв
 * на 30-й секунде и был источником дублей (23.09.2026).
 */
const CREATE_PROPERTY_TIMEOUT_MS = 180_000;

export function useCreateProperty(retryKey?: RetryKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      withRetryKey(retryKey, (idempotencyKey) =>
        api<Property>("/properties", { method: "POST", body, queueOffline: true, idempotencyKey, timeoutMs: CREATE_PROPERTY_TIMEOUT_MS })
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["properties"] }),
  });
}

export function useUpdateProperty(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Property>(`/properties/${id}`, { method: "PATCH", body }),
    // Префикс без id, как в useUploadPhotos: карточка закеширована под shortId
    // из URL, а сюда приходит UUID — точечная инвалидация по UUID не находила запись.
    onSuccess: () => invalidatePropertyEverywhere(qc),
  });
}

export interface FinishEditResult {
  changed: boolean;
  site: boolean;
  captions: {
    updated: string[];
    failed: { channel: string; error: string }[];
    manual: { channel: string }[];
  } | null;
}

const CHANNEL_RU: Record<string, string> = {
  FACEBOOK: "Facebook",
  TELEGRAM: "Telegram",
  YOUTUBE: "YouTube",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  THREADS: "Threads",
};

/** Одна строка итога «Готово» для всплывашки: что обновилось само и где руками. */
export function finishEditSummary(r: FinishEditResult): string | null {
  if (!r.changed) return null;
  const parts: string[] = [];
  const done = [...(r.captions?.updated ?? []).map((c) => CHANNEL_RU[c] ?? c), ...(r.site ? ["сайт"] : [])];
  if (done.length) parts.push(`Обновлено: ${done.join(", ")}`);
  const failed = (r.captions?.failed ?? []).map((f) => CHANNEL_RU[f.channel] ?? f.channel);
  if (failed.length) parts.push(`не получилось: ${failed.join(", ")}`);
  const manual = [...new Set((r.captions?.manual ?? []).map((m) => CHANNEL_RU[m.channel] ?? m.channel))];
  if (manual.length) parts.push(`поправить руками: ${manual.join(", ")}`);
  return parts.length ? `${parts.join("; ")}.` : null;
}

/**
 * «Готово» после правки объекта (владелец 23.09.2026) — сервер рассылает
 * подпись в вышедшие посты и досылает объект на сайт, если с прошлого раза
 * что-то поменяли. Раньше кнопка только закрывала режим правки.
 */
export function useFinishPropertyEdit(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<FinishEditResult>(`/properties/${id}/finish-edit`, { method: "POST" }),
    onSuccess: () => {
      invalidatePropertyEverywhere(qc);
      qc.invalidateQueries({ queryKey: ["audit-log"] });
    },
  });
}

/**
 * «Перегенерировать» подпись под Reels — другим случайным шаблоном по актуальным
 * данным карточки (решение владельца 04.08.2026: шаблоны вместо ИИ). Бесплатно
 * и мгновенно, поэтому без ограничения по числу нажатий.
 */
export function useRegenerateReelsCaption(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ reelsCaption: string }>(`/properties/${id}/regenerate-caption`, { method: "POST" }),
    onSuccess: () => invalidatePropertyEverywhere(qc),
  });
}

/**
 * «Готово» у монтажёра (Этап 7/9 спецификации): переводит объект в продажу и
 * публикует на сайт одной кнопкой. 207 — статус в CRM сменился, но сайт
 * отказал публикацию; такой ответ не reject-ится (объект честно готов), но
 * несёт siteSyncError, который вызывающий код должен показать отдельно.
 */
export function useCompleteEditing(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<Property & { siteSyncError?: string }>(`/properties/${id}/complete-editing`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["property"] });
    },
  });
}

/** «Одобрить фото»/«Одобрить видео» на проверке (Этап 6 спецификации) — кнопки
 *  вместо выпадающего списка статусов. Когда одобрены оба материала, сервер сам
 *  переводит объект в монтаж (EDITING). */
export function useApprovePropertyMaterial(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (material: "photos" | "video") =>
      api<Property>(`/properties/${id}/review/approve`, { method: "POST", body: { material } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["property"] });
    },
  });
}

/** «Запросить новые фото»/«Запросить новое видео» — возврат агенту на доработку
 *  с обязательной причиной. */
export function useRejectPropertyMaterial(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      material: "photos" | "video";
      reason: string;
      reasonVoiceUrl?: string | null;
      reasonVoiceTranscript?: string | null;
    }) => api<Property>(`/properties/${id}/review/reject`, { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["property"] });
    },
  });
}

/** Удаление объекта в Корзину (только admin/director) — сервер сам снимает с сайта
 * и пишет аудит. Мягкое: объект можно вернуть из Корзины (см. useRestoreProperty).
 * Объект со сделками сервер удалять откажется. */
export function useDeleteProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | ({ id: string } & PropertyRemovalInput)) => {
      const { id, ...body } = typeof input === "string" ? { id: input } : input;
      return api(`/properties/${id}`, { method: "DELETE", body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      // Карточка закеширована под shortId — точечно не найдём, сносим весь префикс.
      qc.removeQueries({ queryKey: ["property"] });
    },
  });
}

/**
 * Что умеет панель выбора в списке объектов: две кнопки сайта и удаление в
 * Корзину. Тип живёт здесь, а не на экране Properties: его же берёт мобильный
 * список (MobilePropertiesList), а импорт типа из страницы, которая сама
 * импортирует этот список, замкнул бы модули друг на друга.
 */
export type BulkAction = "publish" | "unpublish" | "trash";

/**
 * Массовое удаление отмеченных объектов в Корзину (POST /properties/bulk-trash,
 * право `properties.delete`). Партия не всё-или-ничего: сервер отвечает строкой
 * на каждый объект, и экран показывает, что именно не удалилось (объект со
 * сделкой) — поэтому мутация возвращает результат, а не просто «готово».
 */
export function useBulkTrashProperties() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string[] | ({ ids: string[] } & PropertyRemovalInput)) =>
      api<{ trashed: number; failed: number; results: BulkTrashItemResult[] }>("/properties/bulk-trash", {
        method: "POST",
        body: Array.isArray(input) ? { ids: input } : input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["properties-trash"] });
      // Карточки закешированы под shortId — точечно не найдём, сносим весь префикс.
      qc.removeQueries({ queryKey: ["property"] });
    },
  });
}

/** Корзина объектов — только админ/директор. Постранично (20 на страницу) —
 *  раньше отдавала до 200 карточек разом. */
export function usePropertyTrash(page: number, enabled = true) {
  return useQuery({
    queryKey: ["properties-trash", page],
    queryFn: () => api<Paginated<Property>>(`/properties/trash?page=${page}`),
    placeholderData: keepWhilePagingIndexed<Paginated<Property>>(["properties-trash", page]),
    enabled,
  });
}

export function useRestoreProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/properties/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties-trash"] });
      qc.invalidateQueries({ queryKey: ["properties"] });
    },
  });
}

/** Безвозвратное удаление — только из Корзины (объект уже должен быть в ней),
 * только админ/директор. Стирает фото на диске — обычное удаление в Корзину их не трогает. */
export function usePermanentDeleteProperty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/properties/${id}/permanent`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["properties-trash"] }),
  });
}

/**
 * ОТПРАВКА ФАЙЛОВ ЖИВЁТ В lib/uploadQueue.ts, а не здесь.
 *
 * Отсюда убраны uploadPropertyPhotos/useUploadPhotos/useUploadVideos: они
 * отправляли файлы прямо из мутации на экране, и обрыв связи уносил вместе с
 * ошибкой сам выбор — агент заново лез в галерею за тридцатью снимками. Очередь
 * хранит задания на устройстве, показывает ход поимённо и доводит их сама.
 *
 * Здесь остаётся только чтение и удаление: у них нет ни файлов, ни минут
 * ожидания, и переживать обрыв им незачем.
 */

export interface PropertyVideoView {
  id: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByName: string;
  /** Факты сырого файла (23.09.2026, задание C) — null, пока фон не разобрал
   *  ffprobe'ом после загрузки, либо файл нечитаем/бинарник недоступен. См.
   *  apps/api/src/lib/rawVideoFacts.ts. */
  hasAudio: boolean | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
}

/**
 * Список сырых роликов. `enabled` обязателен для тех, кто не ведёт объект: сервер
 * отдаёт список только тем, кто управляет объектом (canManageProperty), остальным
 * 403 — и каждое открытие чужой карточки писало ошибку в консоль (06.10.2026).
 */
export function usePropertyVideos(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["property-videos", id],
    queryFn: () => api<PropertyVideoView[]>(`/properties/${id}/videos`),
    enabled: !!id && enabled,
  });
}


/** Скачивание — presigned-ссылка на R2, открывается в новой вкладке (сама CRM файл не проксирует). */
export function useDownloadVideo(id: string) {
  return useMutation({
    mutationFn: (videoId: string) => api<{ url: string; filename: string }>(`/properties/${id}/videos/${videoId}/download`),
    // silent: скачивание НИЧЕГО не сохраняет — общий тост «Сохранено» по кнопке
    // «Скачать» был не дублем, а прямо неверным словом (тот же случай, что кнопки
    // «Проверить связь» в useSettings). Отказ показывает сам PropertyVideoManager
    // строкой «Не удалось получить ссылку на скачивание» (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
  });
}

/** Все фото объекта одним ZIP — эндпоинт стримит архив, тут только скачивание
 * готового Blob и клик по служебной ссылке (как downloadFinanceCsv/экспорт объектов). */
export async function downloadPropertyPhotosArchive(id: string, shortId: number) {
  const blob = await api<Blob>(`/properties/${id}/photos/archive.zip`, { responseType: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `photos-${shortId}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Все видео объекта одним ZIP — см. downloadPropertyPhotosArchive. */
export async function downloadPropertyVideosArchive(id: string, shortId: number) {
  const blob = await api<Blob>(`/properties/${id}/videos/archive.zip`, { responseType: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `videos-${shortId}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

export function useDeleteVideo(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (videoId: string) => api(`/properties/${id}/videos/${videoId}`, { method: "DELETE" }),
    // Число сырых роликов (`videoCount`) лежит в карточке, а не в списке видео: без
    // сброса карточки «Одобрить видео» и подсказки конвейера читали старое число.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["property-videos", id] });
      invalidatePropertyEverywhere(qc);
    },
  });
}

/** Удаление одного фото объекта — файл и миниатюра стираются и на диске сервера. */
export function useDeletePhoto(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) => api(`/properties/${id}/photos/${photoId}`, { method: "DELETE" }),
    onSuccess: () => invalidatePropertyEverywhere(qc),
  });
}

/** Новый порядок фото (drag-and-drop в карточке объекта). Первый id в списке —
 * главное фото: оно становится обложкой в CRM и первым уходит на сайт. */
export function useReorderPhotos(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (photoIds: string[]) =>
      api(`/properties/${id}/photos/order`, { method: "PATCH", body: { photoIds } }),
    onSuccess: () => invalidatePropertyEverywhere(qc),
  });
}

/**
 * Улучшение фото ИИ (пункт 7 очереди, 23.08.2026) — три мутации: запуск,
 * одобрение, отклонение. Все три отвечают ОБНОВЛЁННОЙ записью фото — тем же
 * приёмом, что и остальные операции с фото объекта здесь. `useEnhancePhoto`
 * без `onSuccess`-инвалидации на неудаче специально: сервер отвечает 502 при
 * отказе рисования (перегруз/нет ключа) — это ожидаемый исход, не повод
 * перечитывать список фото, вызывающий компонент сам показывает ошибку.
 */
export function useEnhancePhoto(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) => api<PropertyPhoto>(`/properties/${id}/photos/${photoId}/enhance`, { method: "POST" }),
    onSuccess: () => invalidatePropertyEverywhere(qc),
  });
}

export function useApprovePhotoEnhance(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) =>
      api<PropertyPhoto>(`/properties/${id}/photos/${photoId}/enhance/approve`, { method: "POST" }),
    onSuccess: () => invalidatePropertyEverywhere(qc),
  });
}

export function useRejectPhotoEnhance(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) =>
      api<PropertyPhoto>(`/properties/${id}/photos/${photoId}/enhance/reject`, { method: "POST" }),
    onSuccess: () => invalidatePropertyEverywhere(qc),
  });
}

/** Publishes/unpublishes one or many properties on royalhome.tj — same
 * endpoint backs the single-object button and the list's bulk action. */
export function useSyncToSite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: string[]; action: "publish" | "unpublish" }) =>
      api<{ results: SiteSyncItemResult[] }>("/properties/bulk-sync", { method: "POST", body }),
    // Сервер отвечает 200 и по строке на объект: отказ по объекту приходит как
    // УСПЕХ запроса, и общий тост говорил «Сохранено» поверх неудачи (WEB-PAGES20).
    // Поэтому тост здесь свой, по строкам результата; ошибки запроса целиком тоже.
    meta: { silent: true },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["property"] });
      const failure = siteSyncFailureText(result.results);
      if (failure) toast.error(failure);
      else toast.success("Сохранено");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Не удалось синхронизировать с сайтом");
    },
  });
}

/** Клиент, которому может подойти этот объект (см. api routes/matching.ts). */
// Описан один раз в @royal-home/shared: его же держится сервер (routes/matching.ts).
export type { MatchingClient } from "@royal-home/shared";

/**
 * Кому подойдёт объект. Загружается ТОЛЬКО когда блок открыли: это выборка по всей
 * активной базе покупателей, и делать её при каждом открытии карточки незачем.
 */
export function useMatchingClients(propertyId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["property", propertyId, "matching-clients"],
    // total — размер всего множества ждущих (то же, что Property.demandCount);
    // items — только первые 10 по баллу (routes/properties/matching.ts).
    queryFn: () => api<{ items: MatchingClient[]; total: number }>(`/properties/${propertyId}/matching-clients`),
    enabled: !!propertyId && enabled,
  });
}

/**
 * Ссылки объекта, выданные клиентам, — ТОЛЬКО ЧТЕНИЕ. Ручное «создать ссылку»
 * владелец убрал (#1016, 29.09.2026), и вместе с формой из карточки ушёл список
 * выданных ссылок — а выдаёт их не только человек: рассылка по СМС даёт каждому
 * клиенту свою (`getOrCreatePropertyShareLinks`, routes/properties/smsShare.ts),
 * чтобы агент видел, кто открыл. После #1016 этого не показывал никто, поэтому
 * чтение вернулось, а создание и отзыв — нет.
 */
export interface PropertyShareLink {
  id: string;
  token: string;
  url: string;
  clientId: string | null;
  client: { id: string; fullName: string; phone: string } | null;
  createdByAgent: { id: string; fullName: string } | null;
  createdAt: string;
  expiresAt: string | null;
  viewedAt: string | null;
  revokedAt: string | null;
  isExpired: boolean;
}

export function usePropertyShareLinks(propertyId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["property", propertyId, "share-links"],
    queryFn: () => api<{ items: PropertyShareLink[] }>(`/properties/${propertyId}/share-links`),
    enabled: !!propertyId && enabled,
  });
}
