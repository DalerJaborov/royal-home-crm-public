import { isInsideDushanbe, type PropertyDraftMediaView } from "@royal-home/shared";
import { api, refreshAccessToken } from "./api";
import { ApiError } from "./apiError";
import { compressImage } from "./compressImage";
import { clearAllDraftFiles, deleteDraftFile, putDraftFile, readAllDraftFiles, type StoredDraftFile } from "./draftUploadStore";
import { getOrCreateDeviceId } from "./deviceId";
import { reportUploadIssue } from "./errorReporter";
import { createLightPreview } from "./imagePreview";
import type { ExifGpsPoint } from "./exifGps";
import { readGpsFromFile } from "./mediaGps";
import { isBlobReadable, unreadableFileMessage } from "./uploadFormat";
import { httpStatusMessage } from "./httpStatusMessage";
import { useAuthStore } from "../store/auth";
import { registerWork } from "./workGuard";
import { setDraftReminder } from "./draftReminder";

/**
 * ФАЙЛЫ МАСТЕРА УХОДЯТ СРАЗУ, А НЕ ПОСЛЕ «СОХРАНИТЬ» (владелец 11.09.2026:
 * «прогресс фото и видео чтобы сразу всё было видно»).
 *
 * Раньше снимки и ролики лежали в памяти вкладки до самого конца мастера, и вся
 * отдача — десятки мегабайт по мобильному интернету — начиналась в момент, когда
 * агент уже собрался уходить из квартиры. Теперь файл уходит в черновик объекта
 * (POST /properties/drafts/current/...) в ту же секунду, когда его выбрали, а
 * агент видит по каждому файлу полосу и состояние: ждёт → грузится N % → готово
 * → не ушло, с кнопкой «Повторить».
 *
 * ПОЧЕМУ НЕ ОБЩАЯ ОЧЕРЕДЬ lib/uploadQueue.ts. Та умеет работать только с уже
 * существующим объектом: задание хранит его id, маршруты все вида
 * /properties/:id/..., а идентификатор черновика ей неоткуда взять. Городить в
 * ней вторую цель — значит трогать горячий модуль, который держит загрузки со
 * всех карточек объектов сразу. Здесь свой маленький ход, живущий ровно столько,
 * сколько открыт мастер.
 *
 * ФАЙЛЫ ПЕРЕЖИВАЮТ ПЕРЕЗАГРУЗКУ ВКЛАДКИ (21.09.2026, разбор жалобы «агент
 * добавил 15-20 фото — сервер сбросился, всё потерялось»). Настоящая причина
 * была не в сервере, а в двух местах разом: (1) плитки показывали
 * полноразмерный objectURL исходника — 20 снимков по 12 Мп декодированных
 * разом кладут вкладку сами по себе (см. lib/imagePreview.ts), и (2) то, что
 * ещё не успело уйти, жило только в памяти модуля и пропадало вместе с
 * закрытием мастера/перезагрузкой. Теперь ещё не отправленный файл дублируется
 * в IndexedDB (lib/draftUploadStore.ts) и подхватывается заново в
 * hydrateDraftMedia — досылается тем же uploadKey, сервер идемпотентен.
 *
 * ПОСЛЕДОВАТЕЛЬНО, ПО ОДНОМУ ФАЙЛУ. Канал у телефона узкий: три параллельные
 * отдачи не быстрее одной, зато все три ползут, и ни одна не готова. Один файл
 * за раз — и первый снимок готов через несколько секунд.
 */

const API_PREFIX = "/api/v1/properties/drafts/current";
/** Пауза перед повтором отказа сервера (5xx/429) — растёт с числом попыток. */
const RETRY_BASE_MS = 4_000;
/** Потолок паузы — и она же периодичность «пробного» повтора при обрыве связи. */
const RETRY_MAX_MS = 60_000;
/** Отказов подряд от СЕРВЕРА (не обрыва связи — см. ниже), после которых
 *  перестаём пробовать сами и ждём кнопку «Повторить». */
const MAX_SERVER_ATTEMPTS = 6;

export type DraftMediaKind = "photo" | "video";
/**
 * queued — в очереди, ещё не начали; uploading — идёт отдача; ready — файл на
 * сервере; failed — отказ, ждём кнопки «Повторить»; lost — файл был начат в
 * прошлый заход в мастер и не докачан, самого файла у вкладки больше нет.
 */
export type DraftItemStatus = "queued" | "uploading" | "ready" | "failed" | "lost";

/**
 * Чем кончилась неудача (07.10.2026) — от этого зависит, есть ли смысл в кнопке
 * «Повторить»: net/server лечатся повтором, limit/type/other — нет (лимит и тип
 * файла от второго нажатия не изменятся), у таких плитки только «Убрать».
 */
export type DraftErrorKind = "limit" | "type" | "net" | "server" | "other";

/** Отличить отказ по существу от того, что лечится повтором. Чистая функция. */
export function classifyDraftError(status: number, message: string | null): DraftErrorKind {
  if (status === 0) return "net";
  if (status >= 500 || status === 429) return "server";
  const text = (message ?? "").toLowerCase();
  if (status === 413 || /лимит|помещается|слишком больш/.test(text)) return "limit";
  if (status === 415 || status === 422 || /тип|формат|не поддерж|допустимо только|не даёт прочитать/.test(text)) return "type";
  return "other";
}

/** Можно ли у этой плитки показывать «Повторить»: только упавшая повторяемой причиной и с файлом на руках. */
export function canRetryDraftItem(item: Pick<DraftMediaItem, "status" | "errorKind">): boolean {
  return item.status === "failed" && (item.errorKind === "net" || item.errorKind === "server" || item.errorKind === null);
}

export interface DraftMediaItem {
  /** Ключ повторной отправки — он же стабильный id плитки в списке. */
  uploadKey: string;
  kind: DraftMediaKind;
  name: string;
  sizeBytes: number;
  status: DraftItemStatus;
  /** Отдано байт (для полосы). */
  loaded: number;
  error: string | null;
  /** Причина последней неудачи — null, пока ничего не падало. */
  errorKind: DraftErrorKind | null;
  /** id строки на сервере — появляется, как только сервер её завёл. */
  mediaId: string | null;
  /** Лёгкое превью (~320px, lib/imagePreview.ts) — пока не готово, плитка
   *  показывает иконку-заглушку, а НЕ полноразмерный файл. */
  previewUrl: string | null;
  thumbUrl: string | null;
}

interface QueueEntry {
  /**
   * Чей это файл (аудит 04.10.2026, WEB-03). Очередь живёт в памяти вкладки и
   * переживает выход: без владельца файлы А уходили бы в черновик Б его токеном.
   */
  agentId: string | null;
  item: DraftMediaItem;
  /** Сам файл. У восстановленных с сервера (без файла у вкладки — status
   *  "lost") его нет — их и слать не нужно. */
  file: File | null;
  /** Попытки, которые тратит именно ОТКАЗ СЕРВЕРА (5xx/429) — обрыв связи
   *  (status 0) в этот счётчик не идёт, см. run(). */
  attempts: number;
  /** Отдельный счётчик для ОБРЫВА СВЯЗИ (status 0) — только для телеметрии
   *  (D2): «при каждом повторе начиная со 2-й попытки», не для бэкоффа. */
  connectivityFails: number;
  cancelled: boolean;
  /**
   * Плитку убрал человек (removeDraftMedia), а не сброс мастера (clearDraftMedia).
   * Только такой файл, дошедший до сервера уже ПОСЛЕ удаления плитки, надо стереть
   * на сервере: при сбросе после создания объекта файлы уже стали его фото (WEB-04).
   */
  removedByUser?: boolean;
  /** Запрос на удаление файла на сервере уже отправлен (removeDraftMedia знал mediaId). */
  serverDeleteSent?: boolean;
  /** Раньше этого момента файл не берём повторно — задаёт бэкофф без блокировки
   *  остальной очереди (пункт 7 задания: раньше один отказавший файл со своим
   *  таймером останавливал ВСЮ очередь через return из run()). */
  nextAttemptAt?: number;
  /** Сжатая версия — считается один раз и переиспользуется и отправкой, и
   *  записью в IndexedDB, чтобы не сжимать один и тот же снимок дважды. */
  compressedPromise?: Promise<File>;
  /** Где оборвался ролик (07.10.2026, для журнала `[загрузка]`): открытие
   *  сессии, отдача частей или сборка — и сколько частей уже ушло. */
  stage?: "session" | "parts" | "complete";
  partsDone?: number;
  partsTotal?: number;
}

const entries = new Map<string, QueueEntry>();
const listeners = new Set<() => void>();
let snapshot: DraftMediaItem[] = [];
let running = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

/** Часть видео, которая отказала status 0 без единого отданного байта — по
 *  ключу отправки, см. разбор в sendVideo (D1, 23.09.2026). */
const lastZeroProgressPart = new Map<string, number>();

/**
 * ТОЧКА ПО EXIF ПЕРВОГО СНИМКА (17.09.2026) — отдельный маленький сторедж, тем
 * же способом (useSyncExternalStore), что и очередь выше, но не связан с ней:
 * фото могут не уйти на сервер ещё долго, а точку карта в мастере (StepPlace)
 * должна получить сразу, как только файл выбран, не дожидаясь отправки.
 * Разбор — в браузере (lib/mediaGps.ts: JPEG, HEIC/AVIF, PNG/WebP и видео MP4/MOV/3GP), без похода на сервер.
 *
 * Первый найденный тег и остаётся: агент мог добавить второй снимок из другого
 * места (интерьер отдельной комнаты переслали клиенты) — его EXIF точку объекта
 * не заменяет.
 */
let detectedLocation: ExifGpsPoint | null = null;
const locationListeners = new Set<() => void>();

export function subscribeDraftPhotoLocation(listener: () => void): () => void {
  locationListeners.add(listener);
  return () => locationListeners.delete(listener);
}

export function getDraftPhotoLocationSnapshot(): ExifGpsPoint | null {
  return detectedLocation;
}

/** Сбрасывается вместе с остальным черновиком («начать заново», новый объект). */
let locationGeneration = 0;

function resetDraftPhotoLocation(): void {
  locationGeneration += 1;
  locationSamples = [];
  locationProbes = 0;
  if (detectedLocation === null) return;
  detectedLocation = null;
  locationListeners.forEach((l) => l());
}

/**
 * ТОЧКА ПО ВСЕМ СНИМКАМ, А НЕ ПО ПЕРВОМУ (28.09.2026, владелец: «по EXIF на
 * пару метров в дорогу ввёл»). GPS каждого кадра в помещении гуляет на
 * 10–30 м в свою сторону; медиана по кадрам объекта заметно ближе к дому, чем
 * любой один из них. Кадры дальше `LOCATION_OUTLIER_M` от медианы (фото из
 * галереи с другого адреса) в расчёт не идут. Разбираем не больше
 * `LOCATION_MAX_PHOTOS` — дальше точность уже не растёт.
 */
const LOCATION_MAX_PHOTOS = 12;
const LOCATION_OUTLIER_M = 150;
let locationSamples: ExifGpsPoint[] = [];
let locationProbes = 0;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function medianPhotoPoint(points: readonly ExifGpsPoint[]): ExifGpsPoint | null {
  if (points.length === 0) return null;
  // Самое плотное скопление кадров, а не медиана всех: два адреса дальше 300 м
  // друг от друга иначе давали точку ПОСЕРЕДИНЕ между ними — ни там, ни там
  // (аудит 02.10.2026). Для каждого кадра считаем соседей в LOCATION_OUTLIER_M,
  // берём кадр с наибольшим числом соседей (при равенстве — самый ранний) и
  // медиану его соседей.
  const metersPerDegLng = 111_000 * Math.cos((points[0].lat * Math.PI) / 180);
  const near = (a: ExifGpsPoint, b: ExifGpsPoint) =>
    Math.hypot((a.lat - b.lat) * 111_000, (a.lng - b.lng) * metersPerDegLng) <= LOCATION_OUTLIER_M;
  let best: ExifGpsPoint[] = [];
  for (const p of points) {
    const group = points.filter((q) => near(p, q));
    if (group.length > best.length) best = group;
  }
  return { lat: median(best.map((p) => p.lat)), lng: median(best.map((p) => p.lng)) };
}

function tryDetectLocation(file: File): void {
  if (locationProbes >= LOCATION_MAX_PHOTOS) return;
  locationProbes += 1;
  const generation = locationGeneration;
  void readGpsFromFile(file).then((point) => {
    // Снимок из другого города (пересланный, из галереи) метку туда не ставит —
    // та же рамка, что на сервере (packages/shared/src/geo.ts).
    if (!point || generation !== locationGeneration || !isInsideDushanbe(point.lat, point.lng)) return;
    locationSamples = [...locationSamples, point];
    detectedLocation = medianPhotoPoint(locationSamples);
    locationListeners.forEach((l) => l());
  });
}

function publish() {
  // Новый массив на каждое изменение: useSyncExternalStore сравнивает по ссылке.
  snapshot = [...entries.values()].map((e) => ({ ...e.item }));
  // Есть файлы черновика — значит, есть незавершённый черновик объекта: плашка
  // «Черновик объекта · Продолжить» (components/WorkIndicator.tsx) напомнит о нём.
  if (entries.size > 0) setDraftReminder(true);
  syncWorkGuard();
  listeners.forEach((l) => l());
}

/**
 * ОЧЕРЕДЬ МАСТЕРА В РЕЕСТРЕ РАБОТЫ (lib/workGuard.ts, 07.10.2026). Пока что-то
 * едет, ждёт очереди или упало повторяемой причиной, вкладку нельзя тихо
 * закрыть, обновить или разлогинить, а при возврате в приложение/появлении сети
 * очередь обязана проснуться сама (resumeUploads), а не ждать замороженных 60 с.
 */
let unregisterWork: (() => void) | null = null;

function syncWorkGuard(): void {
  const active = snapshot.some(
    (i) => i.status === "queued" || i.status === "uploading" || canRetryDraftItem(i)
  );
  if (active && !unregisterWork) {
    unregisterWork = registerWork({
      id: "draft-uploads",
      label: "Загрузка фото и видео объекта",
      blocksUnload: true,
      resume: resumeUploads,
    });
  } else if (!active && unregisterWork) {
    unregisterWork();
    unregisterWork = null;
  }
}

/**
 * Вернулись в приложение / появилась сеть / сердцебиение: сбросить заморозку
 * бэкоффа у ждущих файлов и сразу пробовать. Без сброса `nextAttemptAt` файл,
 * ждавший 60 секунд паузы после обрыва, стоял бы, хотя связь давно вернулась.
 */
export function resumeUploads(): void {
  let touched = false;
  for (const e of entries.values()) {
    if (e.item.status === "queued" && e.nextAttemptAt) {
      e.nextAttemptAt = undefined;
      touched = true;
    }
  }
  if (touched && wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  void run();
}

export function subscribeDraftMedia(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDraftMediaSnapshot(): DraftMediaItem[] {
  return snapshot;
}

export function draftPhotos(): DraftMediaItem[] {
  return snapshot.filter((i) => i.kind === "photo");
}

export function draftVideos(): DraftMediaItem[] {
  return snapshot.filter((i) => i.kind === "video");
}

/** Есть ли что-то, что ещё едет или не уехало вовсе. */
export function draftUploadsPending(): boolean {
  return snapshot.some((i) => i.status === "queued" || i.status === "uploading");
}

export function draftUploadsFailed(): boolean {
  return snapshot.some((i) => i.status === "failed" || i.status === "lost");
}

/** Всё, что ещё не READY: едет, ждёт, упало или потеряно. Объект создавать рано. */
export function draftUploadsBlocking(): boolean {
  return snapshot.some((i) => i.status !== "ready");
}

export interface DraftWaitResult {
  /** Всё доехало: ни едущих, ни упавших, ни потерянных. */
  ok: boolean;
  failed: number;
  lost: number;
  /** Ждать перестали, потому что позвавший ушёл (мастер закрыли) — действовать не надо. */
  aborted: boolean;
}

/** Потолок ожидания в мастере: полчаса на обход квартиры в 4K — предел разумного. */
export const DRAFT_WAIT_TIMEOUT_MS = 30 * 60_000;

/**
 * Ждать, пока очередь мастера доедет. Подписка на изменения очереди, а не
 * `setInterval`: при размонтировании мастера (`signal`) подписка и таймер
 * снимаются, и позвавший не получает «зомби»-продолжения (create/navigate после
 * ухода с экрана). Ждёт только едущих/ждущих — упавшие и потерянные сами не
 * доедут, их возвращает счётчиками.
 */
export function waitForDraftUploads(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DraftWaitResult> {
  const { signal, timeoutMs = DRAFT_WAIT_TIMEOUT_MS } = opts;
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (aborted: boolean) => {
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const failed = snapshot.filter((i) => i.status === "failed").length;
      const lost = snapshot.filter((i) => i.status === "lost").length;
      resolve({ ok: !aborted && !draftUploadsPending() && failed === 0 && lost === 0, failed, lost, aborted });
    };
    const onAbort = () => finish(true);
    const check = () => {
      if (!draftUploadsPending()) finish(false);
    };

    if (signal?.aborted) {
      finish(true);
      return;
    }
    signal?.addEventListener("abort", onAbort);
    unsubscribe = subscribeDraftMedia(check);
    timer = setTimeout(() => finish(false), timeoutMs);
    check();
  });
}

/** Есть ли в модуле хоть одна плитка — включая едущие/ждущие. Мастер при
 *  повторном открытии по этому флагу понимает, что черновик уже «в руках»
 *  (плитки живут в фоне после detachDraftMediaView), и не должен снова
 *  предлагать «Продолжить / Начать заново». */
export function hasLiveDraftMedia(): boolean {
  return entries.size > 0;
}

/** Ключ отправки. crypto.randomUUID есть во всех браузерах, где работает CRM. */
function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currentAgentId(): string | null {
  return useAuthStore.getState().agent?.id ?? null;
}

/**
 * Смена сотрудника в той же вкладке (А вышел, вошёл Б): чужие плитки из памяти
 * убираем и больше не отправляем (WEB-03). Дисковые копии А (IndexedDB,
 * draftUploadStore) НЕ трогаем: они ключуются агентом и ждут его возвращения,
 * а hydrateDraftMedia достанет только копии вошедшего.
 */
function dropForeignEntries(): void {
  const me = currentAgentId();
  let dropped = false;
  for (const [key, e] of entries) {
    if (e.agentId === me) continue;
    e.cancelled = true;
    if (e.item.previewUrl) URL.revokeObjectURL(e.item.previewUrl);
    entries.delete(key);
    dropped = true;
  }
  if (!dropped) return;
  resetDraftPhotoLocation(); // точка по снимкам чужого объекта Б не нужна
  publish();
}

useAuthStore.subscribe((state, prev) => {
  if (state.sessionEpoch !== prev.sessionEpoch) dropForeignEntries();
});

/**
 * Разложить то, что уже лежит в черновике на сервере, по плиткам, и доложить
 * поверх то, чего сервер ещё не видел (IndexedDB, lib/draftUploadStore.ts).
 * Вызывается при входе в мастер, когда агент согласился продолжить черновик.
 *
 * СЛИЯНИЕ, А НЕ ПЕРЕЗАПИСЬ (21.09.2026). Раньше функция звала clearDraftMedia()
 * первой строкой — если очередь к этому моменту уже что-то грузит (мастер
 * закрыли и открыли снова, detachDraftMediaView оставил файлы ехать в фоне),
 * вызов затирал и отменял живые записи. Теперь живая локальная запись
 * (statuses queued/uploading/failed, есть file) всегда главнее серверной —
 * сервер мог ещё не узнать о ней (автосохранение отстаёт) или уже устарел.
 */
export async function hydrateDraftMedia(media: PropertyDraftMediaView[]): Promise<void> {
  const serverKeys = new Set(media.map((m) => m.uploadKey));

  // 1) Плейсхолдеры прошлого захода (ready/lost, без file), которых сервер
  //    больше не знает, — убрать. Живые локальные записи не трогаем вовсе.
  for (const [key, e] of entries) {
    if (e.file) continue;
    if (!serverKeys.has(key)) {
      if (e.item.previewUrl) URL.revokeObjectURL(e.item.previewUrl);
      entries.delete(key);
    }
  }

  // 2) Разложить то, что знает сервер — кроме ключей с живой локальной записью.
  for (const m of media) {
    if (entries.get(m.uploadKey)?.file) continue;
    const kind: DraftMediaKind = m.kind === "VIDEO" ? "video" : "photo";
    entries.set(m.uploadKey, {
      // Незавершённая закачка ролика из прошлого захода: части на сервере есть,
      // а самого файла у вкладки уже нет — докачка ниже (шаг 3) может это
      // поправить, если тот же файл нашёлся в IndexedDB.
      item: {
        uploadKey: m.uploadKey,
        kind,
        name: m.filename,
        sizeBytes: m.sizeBytes,
        status: m.status === "READY" ? "ready" : "lost",
        loaded: m.status === "READY" ? m.sizeBytes : 0,
        error: m.status === "READY" ? null : "Загрузка прервалась — выберите файл заново",
        errorKind: null,
        mediaId: m.id,
        previewUrl: null,
        thumbUrl: m.thumbUrl,
      },
      file: null,
      agentId: currentAgentId(),
      attempts: 0,
      connectivityFails: 0,
      cancelled: false,
    });
  }
  publish();

  // 3) Докачка из IndexedDB — то, чего сервер ещё не считает READY (включая
  //    "lost" выше и то, чего сервер вообще не видел: файл мог не уйти НИ
  //    БАЙТОМ до перезагрузки). Ключ прежний — сервер примет как продолжение
  //    сессии (видео, .../videos/sessions идемпотентен по uploadKey) или как
  //    повтор (фото, POST .../photos идемпотентен по uploadKeys).
  const agentId = currentAgentId();
  if (!agentId) return;
  let stored: StoredDraftFile[];
  try {
    stored = await readAllDraftFiles(agentId);
  } catch {
    return; // приватный режим/квота — докачивать нечем, работаем как раньше
  }
  let queuedSomething = false;
  for (const rec of stored) {
    const existing = entries.get(rec.uploadKey);
    if (existing?.file) continue; // уже живая запись — не трогаем
    if (existing?.item.status === "ready") {
      void deleteDraftFile(rec.uploadKey).catch(() => undefined); // сервер уже принял — хранить незачем
      continue;
    }
    const file = new File([rec.blob], rec.name, { type: rec.blob.type });
    entries.set(rec.uploadKey, {
      item: {
        uploadKey: rec.uploadKey,
        kind: rec.kind,
        name: rec.name,
        sizeBytes: rec.size,
        status: "queued",
        loaded: 0,
        error: null,
        errorKind: null,
        mediaId: existing?.item.mediaId ?? null,
        previewUrl: null,
        thumbUrl: existing?.item.thumbUrl ?? null,
      },
      file,
      agentId,
      attempts: 0,
      connectivityFails: 0,
      cancelled: false,
    });
    if (rec.kind === "photo") queuePreview(rec.uploadKey);
    queuedSomething = true;
  }
  if (queuedSomething) {
    publish();
    void run();
  }
}

/** Забыть всё, не трогая сервер (после успешного создания объекта или «начать заново»). */
export function clearDraftMedia(): void {
  for (const e of entries.values()) {
    e.cancelled = true;
    if (e.item.previewUrl) URL.revokeObjectURL(e.item.previewUrl);
  }
  entries.clear();
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  resetDraftPhotoLocation();
  publish();
  void clearAllDraftFiles().catch(() => undefined);
}

/**
 * Мастер закрыли, но файлы ещё едут или ждут очереди — НЕ отменяем их
 * (21.09.2026: раньше PropertyWizard на размонтировании звал clearDraftMedia()
 * безусловно, и ролик на середине отправки молча обрывался — владелец видел
 * это как «видео не доехало»). Очередь продолжает работать в фоне модуля;
 * когда агент вернётся в мастер, hasLiveDraftMedia() подскажет ему не
 * предлагать «Продолжить / Начать заново» повторно. Пусто в очереди — ведём
 * себя как раньше, полный сброс (нечего оставлять в фоне).
 */
export function detachDraftMediaView(): void {
  // Упавшие повторяемой причиной (обрыв, сбой сервера) тоже оставляем: агент мог
  // закрыть мастер, не дожидаясь, а полный сброс стёр бы и их копии в IndexedDB —
  // файл пропал бы насовсем. Они ждут «Повторить» в вернувшемся мастере.
  if (draftUploadsPending() || snapshot.some(canRetryDraftItem)) return;
  clearDraftMedia();
}

// ─────────────────────────── лёгкие превью плиток ───────────────────────────

/**
 * Очередь превью — ОТДЕЛЬНАЯ от очереди отправки и от неё не зависит: плитка
 * обязана перестать быть пустой заглушкой быстро, даже если сам файл встал в
 * хвост за пятнадцатью другими и уедет ещё нескоро. Один расчёт за раз (не 20
 * одновременных decode) — та же причина, по которой отправка идёт по одному
 * файлу: параллельно не быстрее, а телефон может подвиснуть на пачке разом.
 */
const previewQueue: string[] = [];
let previewRunning = false;

function queuePreview(uploadKey: string): void {
  previewQueue.push(uploadKey);
  void runPreviewQueue();
}

async function runPreviewQueue(): Promise<void> {
  if (previewRunning) return;
  previewRunning = true;
  try {
    for (;;) {
      const uploadKey = previewQueue.shift();
      if (uploadKey === undefined) return;
      const entry = entries.get(uploadKey);
      if (!entry || entry.cancelled || !entry.file || entry.item.kind !== "photo") continue;

      const url = await createLightPreview(entry.file);
      // Пока считали превью, плитку могли убрать или мастер мог быть закрыт
      // с полным сбросом — не подвешиваем blob URL, которому некуда деться.
      const stillThere = entries.get(uploadKey);
      if (!stillThere || stillThere.cancelled) {
        if (url) URL.revokeObjectURL(url);
        continue;
      }
      if (url) {
        stillThere.item.previewUrl = url;
        publish();
      }
      // url === null — превью не вышло (битый формат и т.п.), плитка остаётся
      // с иконкой-заглушкой; полноразмерный файл НЕ подставляем ни в каком
      // исходе (ровно то, из-за чего вкладка раньше падала).
    }
  } finally {
    previewRunning = false;
  }
}

// ─────────────────────────── склад в IndexedDB ───────────────────────────

/** Сжатая версия файла — считается один раз (и отправкой, и записью в
 *  IndexedDB), а не дважды. Видео не сжимаем вовсе (сервер принимает как
 *  исходник), для него просто возвращаем сам файл. */
function ensureCompressed(entry: QueueEntry): Promise<File> {
  if (entry.item.kind !== "photo") return Promise.resolve(entry.file!);
  if (!entry.compressedPromise) {
    entry.compressedPromise = compressImage(entry.file!).catch(() => entry.file!);
  }
  return entry.compressedPromise;
}

/**
 * Дублировать файл в IndexedDB, чтобы он пережил перезагрузку вкладки, пока
 * не ушёл на сервер. Best-effort: приватный режим/квота — работаем как раньше
 * (без переживания перезагрузки), это не должно ронять саму загрузку.
 *
 * Фото — уже СЖАТОЕ (ensureCompressed): держать в хранилище 20-мегабайтный
 * оригинал с камеры вместо сотен килобайт webp-кандидата незачем. Видео —
 * как есть, если укладывается в MAX_STORED_VIDEO_BYTES (иначе store сам его
 * не примет — см. draftUploadStore.ts).
 */
async function persistDraftFile(entry: QueueEntry): Promise<void> {
  const agentId = currentAgentId();
  if (!agentId) return;
  try {
    const blob = await ensureCompressed(entry);
    const current = entries.get(entry.item.uploadKey);
    // Файл мог уже уйти на сервер или пропасть, пока сжимался — хранить
    // отправленное или уже несуществующее незачем.
    if (!current || current.cancelled || current.item.status === "ready") return;
    await putDraftFile({
      uploadKey: entry.item.uploadKey,
      kind: entry.item.kind,
      name: blob.name,
      size: blob.size,
      agentId,
      blob,
    });
  } catch {
    /* приватный режим/квота — молча продолжаем без склада */
  }
}

// ─────────────────────────── добавление файлов ───────────────────────────

export function addDraftPhotos(files: File[]): void {
  for (const file of files) {
    tryDetectLocation(file);
    const uploadKey = newKey();
    const entry: QueueEntry = {
      item: {
        uploadKey,
        kind: "photo",
        name: file.name,
        sizeBytes: file.size,
        status: "queued",
        loaded: 0,
        error: null,
        errorKind: null,
        mediaId: null,
        // Превью считается асинхронно в фоновой очереди (queuePreview) — до
        // готовности плитка показывает иконку-заглушку, НЕ objectURL(file)
        // (тот и убивал вкладку на пачке снимков — lib/imagePreview.ts).
        previewUrl: null,
        thumbUrl: null,
      },
      file,
      agentId: currentAgentId(),
      attempts: 0,
      connectivityFails: 0,
      cancelled: false,
    };
    entries.set(uploadKey, entry);
    queuePreview(uploadKey);
    void persistDraftFile(entry);
  }
  publish();
  void run();
}

export function addDraftVideos(files: File[]): void {
  for (const file of files) {
    // Ролик тоже несёт точку (moov/udta/©xyz, QuickTime ISO6709) — в тот же набор кадров.
    tryDetectLocation(file);
    const uploadKey = newKey();
    const entry: QueueEntry = {
      item: {
        uploadKey,
        kind: "video",
        name: file.name,
        sizeBytes: file.size,
        status: "queued",
        loaded: 0,
        error: null,
        errorKind: null,
        mediaId: null,
        previewUrl: null,
        thumbUrl: null,
      },
      file,
      agentId: currentAgentId(),
      attempts: 0,
      connectivityFails: 0,
      cancelled: false,
    };
    entries.set(uploadKey, entry);
    void persistDraftFile(entry);
  }
  publish();
  void run();
}

/**
 * Удаление файла черновика на сервере с повторами (аудит 04.10.2026, WEB-04).
 *
 * Один проглоченный отказ раньше оставлял файл READY в черновике, а при создании
 * объекта сервер переносит в него ВСЕ READY: убранное в мастере фото всплывало в
 * объекте. Повторяем при обрыве/5xx/429 (паузы ниже); не вышло совсем: запоминаем
 * и пробуем снова при следующем проходе очереди (run). 404: файла уже нет, цель
 * достигнута. Прочие 4xx (чужой черновик) повтором не исправить.
 */
const DELETE_RETRY_DELAYS_MS = [2_000, 6_000];
const failedMediaDeletes = new Set<string>();
const inFlightMediaDeletes = new Set<string>();

async function deleteDraftMediaOnServer(mediaId: string): Promise<void> {
  if (inFlightMediaDeletes.has(mediaId)) return;
  inFlightMediaDeletes.add(mediaId);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await api(`/properties/drafts/current/media/${mediaId}`, { method: "DELETE" });
        failedMediaDeletes.delete(mediaId);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          failedMediaDeletes.delete(mediaId);
          return;
        }
        const retryable = !(err instanceof ApiError) || err.status >= 500 || err.status === 429;
        if (!retryable) {
          failedMediaDeletes.delete(mediaId);
          return;
        }
        const delay = DELETE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          failedMediaDeletes.add(mediaId);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } finally {
    inFlightMediaDeletes.delete(mediaId);
  }
}

/** Отмена и удаление — одна кнопка на плитке. Сервер чистим, если он уже знает файл. */
export async function removeDraftMedia(uploadKey: string): Promise<void> {
  const entry = entries.get(uploadKey);
  if (!entry) return;
  entry.cancelled = true;
  entry.removedByUser = true;
  const mediaId = entry.item.mediaId;
  if (entry.item.previewUrl) URL.revokeObjectURL(entry.item.previewUrl);
  entries.delete(uploadKey);
  publish();
  void deleteDraftFile(uploadKey).catch(() => undefined);
  if (mediaId) {
    entry.serverDeleteSent = true;
    await deleteDraftMediaOnServer(mediaId);
  }
  // Если mediaId ещё нет (файл летит прямо сейчас), удалит run(), когда ответ придёт.
  void run();
}

export function retryDraftMedia(uploadKey: string): void {
  const entry = entries.get(uploadKey);
  if (!entry || !entry.file) return;
  // Отказ по существу (лимит, тип файла) от повтора не изменится — только «Убрать».
  if (!canRetryDraftItem(entry.item)) return;
  entry.attempts = 0;
  entry.connectivityFails = 0;
  entry.nextAttemptAt = undefined;
  entry.item.status = "queued";
  entry.item.error = null;
  entry.item.errorKind = null;
  entry.item.loaded = 0;
  publish();
  void run();
}

/**
 * «Выбрать файл заново» у потерянной плитки (status "lost": часть файла на
 * сервере есть, а самого файла у вкладки уже нет — перезапуск, закрытая вкладка,
 * ролик тяжелее 300 МБ). Раньше «Повторить» на такой плитке молча ничего не
 * делала.
 *
 * Ролик с тем же именем и размером — это тот же файл: продолжаем под прежним
 * ключом, сервер дольёт недостающие части. Любой другой файл (или фото, которое
 * уходит целиком) — новая запись, а старую строку убираем, иначе части одного
 * файла склеились бы с чужим.
 */
export function replaceLostDraftFile(uploadKey: string, file: File): void {
  const entry = entries.get(uploadKey);
  if (!entry || entry.item.status !== "lost") return;
  const sameVideo =
    entry.item.kind === "video" && file.name === entry.item.name && file.size === entry.item.sizeBytes;
  if (!sameVideo) {
    void removeDraftMedia(uploadKey);
    if (entry.item.kind === "photo") addDraftPhotos([file]);
    else addDraftVideos([file]);
    return;
  }
  entry.file = file;
  entry.attempts = 0;
  entry.connectivityFails = 0;
  entry.nextAttemptAt = undefined;
  entry.item.status = "queued";
  entry.item.error = null;
  entry.item.errorKind = null;
  entry.item.loaded = 0;
  void persistDraftFile(entry);
  publish();
  void run();
}

// ─────────────────────────── очередь отправки ───────────────────────────

/** Читаем первые 64 КБ файла до отправки — та же проверка и по той же причине,
 *  что и в uploadQueue.ts::filesReadable (D1, 23.09.2026): WebKit может отдать
 *  нечитаемый Blob из IndexedDB после перезапуска вкладки, и без этой проверки
 *  агент узнаёт об этом только после MAX_SERVER_ATTEMPTS/RETRY_MAX_MS попыток. */
async function fileReadable(file: File): Promise<boolean> {
  try {
    await file.slice(0, 65536).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Телеметрия отказа одного файла мастера (D2) — объекта у черновика ещё нет
 *  (Property заводится только на последнем шаге мастера), поэтому подпись
 *  фиксированная, в отличие от uploadQueue.ts, где есть propertyShortId. */
function reportDraftUploadIssue(
  entry: QueueEntry,
  info: { attempts: number; status: number; error: string | null; retryable: boolean }
): void {
  reportUploadIssue({
    kind: entry.item.kind,
    name: entry.item.name,
    sizeBytes: entry.item.sizeBytes,
    propertyLabel: "черновик объекта (мастер)",
    attempts: info.attempts,
    maxAttempts: MAX_SERVER_ATTEMPTS,
    status: info.status,
    error: info.error,
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    // Где оборвался ролик (07.10.2026): по журналу видно шаг, на котором встал
    // iPhone Safari — сессия, части или сборка.
    ...(entry.stage ? { stage: entry.stage } : {}),
    ...(entry.partsTotal != null ? { partsDone: entry.partsDone ?? 0, partsTotal: entry.partsTotal } : {}),
  });
}

/**
 * Очередь: один файл за раз, снимки раньше роликов (их ждёт проверка
 * Маркетинга — см. комментарий в StepMedia.tsx про монтажёра).
 *
 * ОТКАЗАВШИЙ ФАЙЛ НЕ ОСТАНАВЛИВАЕТ ОСТАЛЬНУЮ ОЧЕРЕДЬ (пункт 7 задания,
 * настоящий баг прежней версии). Раньше при повторяемом отказе run() ставил
 * таймер и делал `return` — из ВСЕЙ функции, а не только для этого файла:
 * пока файл A ждал 4-60 секунд бэкоффа, файлы B/C/D стояли рядом без единой
 * причины, хотя могли уйти прямо сейчас. Теперь у каждой записи свой
 * `nextAttemptAt`, цикл пропускает ещё не готовые к повтору записи и берёт
 * следующую подходящую; спать (scheduleWakeup) есть смысл, только когда
 * подходящих действительно нет ни одной.
 */
async function run(): Promise<void> {
  // Удаления, что не удались раньше (WEB-04), пробуем снова на каждом проходе.
  for (const mediaId of failedMediaDeletes) void deleteDraftMediaOnServer(mediaId);
  if (running) return;
  running = true;
  try {
    for (;;) {
      const now = Date.now();
      // Только файлы вошедшего сотрудника (WEB-03): его токеном чужое не уходит.
      const me = currentAgentId();
      const eligible = (e: QueueEntry) =>
        e.item.status === "queued" && !!e.file && e.agentId === me && (!e.nextAttemptAt || e.nextAttemptAt <= now);
      const next =
        [...entries.values()].find((e) => eligible(e) && e.item.kind === "photo") ??
        [...entries.values()].find((e) => eligible(e));
      if (!next) {
        scheduleWakeup();
        return;
      }

      // D1 — файл, который телефон не даёт прочитать: сказать сразу, а не
      // после MAX_SERVER_ATTEMPTS/RETRY_MAX_MS повторов (см. uploadQueue.ts —
      // тот же разбор, та же починка, своя копия по докстрингу наверху файла).
      if (!(await fileReadable(next.file!))) {
        const message = unreadableFileMessage(false);
        next.item.status = "failed";
        next.item.error = message;
        next.item.errorKind = "type";
        next.nextAttemptAt = undefined;
        publish();
        reportDraftUploadIssue(next, { attempts: next.attempts + 1, status: 0, error: message, retryable: false });
        continue;
      }

      next.item.status = "uploading";
      next.item.loaded = 0;
      next.item.error = null;
      next.item.errorKind = null;
      next.stage = undefined;
      next.partsDone = undefined;
      next.partsTotal = undefined;
      publish();

      const result = next.item.kind === "photo" ? await sendPhoto(next) : await sendVideo(next);
      if (next.cancelled || !entries.has(next.item.uploadKey)) {
        // Плитку убрали, пока файл летел: сервер уже мог его принять и теперь
        // держит READY-файл, который при создании объекта попадёт в объект (WEB-04).
        if (next.removedByUser && next.item.mediaId && !next.serverDeleteSent) {
          next.serverDeleteSent = true;
          void deleteDraftMediaOnServer(next.item.mediaId);
        }
        continue;
      }

      if (result.ok) {
        next.item.status = "ready";
        next.item.loaded = next.item.sizeBytes;
        next.item.error = null;
        next.nextAttemptAt = undefined;
        publish();
        void deleteDraftFile(next.item.uploadKey).catch(() => undefined);
        continue;
      }

      if (result.status === 0) {
        // ОБРЫВ СВЯЗИ (пункт 6 задания). На телефоне это лифт, метро, потеря
        // сигнала — минуты, не секунды. Не тратим на него попытки сервера
        // (MAX_SERVER_ATTEMPTS) и не растим бэкофф экспоненциально — ждём
        // событие online (его слушает workGuard) и подстраховываемся редким
        // пробным повтором раз в RETRY_MAX_MS на случай, если браузер/WebView
        // событие не пришлёт (бывает на некоторых мобильных прошивках).
        next.item.status = "queued";
        next.item.error = result.error;
        next.item.errorKind = "net";
        next.nextAttemptAt = now + RETRY_MAX_MS;
        publish();
        next.connectivityFails++;
        // D2 — телеметрия начиная со 2-го подряд обрыва связи на этом файле
        // (первый — обычное дело: лифт, метро, не сигнал).
        if (next.connectivityFails >= 2) {
          reportDraftUploadIssue(next, { attempts: next.attempts, status: 0, error: result.error, retryable: true });
        }
        continue; // другие файлы очереди не должны ждать чужой обрыв связи
      }
      next.connectivityFails = 0;

      if (result.retryable) {
        next.attempts++;
        if (next.attempts < MAX_SERVER_ATTEMPTS) {
          next.item.status = "queued";
          next.item.error = result.error;
          next.item.errorKind = "server";
          next.nextAttemptAt = now + Math.min(RETRY_BASE_MS * 2 ** (next.attempts - 1), RETRY_MAX_MS);
          publish();
          // D2 — начиная со 2-й попытки сервера.
          if (next.attempts >= 2) {
            reportDraftUploadIssue(next, { attempts: next.attempts, status: result.status, error: result.error, retryable: true });
          }
          continue;
        }
      }
      // Отказ по существу (не тот формат, лимит объекта) или исчерпаны
      // попытки сервера — ждём человека, кнопку «Повторить».
      next.item.status = "failed";
      next.item.error = result.error;
      next.item.errorKind = classifyDraftError(result.status, result.error);
      next.nextAttemptAt = undefined;
      publish();
      reportDraftUploadIssue(next, {
        attempts: next.attempts || 1,
        status: result.status,
        error: result.error,
        retryable: result.retryable,
      });
    }
  } finally {
    running = false;
  }
}

/** Разбудить run() на время ближайшего nextAttemptAt среди тех, кто сейчас
 *  ждёт (а не бесконечных попыток без дела — run() и так проверяет пусто ли). */
function scheduleWakeup(): void {
  if (wakeTimer) return; // кто-то уже разбудит
  let soonest: number | null = null;
  for (const e of entries.values()) {
    if (e.item.status !== "queued" || !e.file || !e.nextAttemptAt) continue;
    if (soonest === null || e.nextAttemptAt < soonest) soonest = e.nextAttemptAt;
  }
  if (soonest === null) return;
  const delay = Math.max(0, soonest - Date.now());
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void run();
  }, delay);
}

// Событие `online`, возврат в приложение (visibilitychange/pageshow) и
// сердцебиение 30 с вешает lib/workGuard.ts — пока в очереди есть что делать
// (syncWorkGuard выше) — и зовёт resumeUploads(). Своего слушателя `online`
// здесь больше нет: раньше он вешался лишь после первого обрыва.

interface SendOutcome {
  ok: boolean;
  error: string | null;
  retryable: boolean;
  /** Настоящий статус ответа — 0 у обрыва связи, отдельного от отказа
   *  сервера (см. разбор в run()). */
  status: number;
}

function outcomeFromStatus(status: number, error: string | null): SendOutcome {
  if (status >= 200 && status < 300) return { ok: true, error: null, retryable: false, status };
  // 0 — до сервера не дошло или ответ не вернулся; 5xx и 429 — сервер попросил
  // позже. Всё остальное (400, 403, 409) повторять бессмысленно.
  const retryable = status === 0 || status >= 500 || status === 429;
  return {
    ok: false,
    error: error ?? (status === 0 ? "Нет связи" : httpStatusMessage(status)),
    retryable,
    status,
  };
}

async function sendPhoto(entry: QueueEntry): Promise<SendOutcome> {
  // Тот же сжатый файл, что уже мог уйти в IndexedDB (persistDraftFile) —
  // считать дважды незачем (ensureCompressed кеширует).
  const file = await ensureCompressed(entry);
  if (entry.cancelled) return { ok: false, error: null, retryable: false, status: 0 };

  const form = new FormData();
  form.append("photos", file, file.name);
  form.append("uploadKeys", entry.item.uploadKey);

  const res = await xhrSendAuthed(
    "POST",
    `${API_PREFIX}/photos`,
    form,
    (loaded, total) => {
      entry.item.loaded = Math.round((loaded / Math.max(total, 1)) * entry.item.sizeBytes);
      publish();
    },
    undefined,
    entry.agentId
  );
  if (res.status >= 200 && res.status < 300) {
    const stored = parseJson<Array<{ id: string; uploadKey: string; thumbUrl: string | null }>>(res.text);
    const mine = stored?.find((m) => m.uploadKey === entry.item.uploadKey);
    if (mine) {
      entry.item.mediaId = mine.id;
      entry.item.thumbUrl = mine.thumbUrl;
    }
  }
  return outcomeFromStatus(res.status, res.error);
}

interface VideoSession {
  status: "started" | "in-progress" | "done";
  mediaId?: string;
  media?: { id: string };
  partSize?: number | null;
  totalParts?: number | null;
  uploadedPartNumbers?: number[];
}

/**
 * ДВА ШАГА РОЛИКА ИДУТ НЕ XHR'ом, А `api()` — У НИХ СВОЙ ПОТОЛОК ОЖИДАНИЯ.
 *
 * Сторож по тишине (см. `xhrSend`) сторожит только отдачу частей. Открытие
 * сессии и сборка ходят обычным `fetch` внутри `api()`, а `fetch` без
 * `AbortSignal` ждёт ответа бесконечно — то есть ровно та же ловушка, из-за
 * которой вставала очередь: проглоченный по дороге ответ на «собери ролик» и
 * ролик, и всё, что за ним, держал бы навсегда.
 *
 * Тела у обоих запросов крошечные (JSON в несколько строк), поэтому потолок по
 * ОБЩЕМУ времени здесь честен, в отличие от отдачи байт. Сборке даём больше:
 * сервер в этот момент склеивает части в файл на диске (localVideoStorage.ts).
 * Оба шага идемпотентны — повторная сессия с тем же uploadKey возвращает
 * «in-progress», повторная сборка готового ролика — «done», — так что
 * сорвавшийся по потолку запрос ничем не опасен.
 */
const SESSION_DEADLINE_MS = 30_000;
const COMPLETE_DEADLINE_MS = 120_000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      // status 0 — тот же смысл, что у обрыва связи: очередь подождёт сети и
      // повторит круг, не тратя попыток сервера.
      () => reject(Object.assign(new Error("Связь пропала — продолжу, когда появится"), { status: 0 })),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Ролик — частями, тем же протоколом, что и видео карточки: сессия → части →
 * сборка. Обрыв на середине трёхсотмегабайтного файла не должен означать
 * «начать заново», иначе на мобильном интернете такой ролик не уедет никогда.
 */
async function sendVideo(entry: QueueEntry): Promise<SendOutcome> {
  const file = entry.file!;
  let session: VideoSession;
  entry.stage = "session";
  try {
    session = await withDeadline(
      api<VideoSession>("/properties/drafts/current/videos/sessions", {
        method: "POST",
        body: {
          uploadKey: entry.item.uploadKey,
          filename: file.name,
          sizeBytes: file.size,
          contentType: file.type || "video/mp4",
        },
        expectAgentId: entry.agentId ?? undefined,
      }),
      SESSION_DEADLINE_MS
    );
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0;
    return outcomeFromStatus(status, (err as { message?: string }).message ?? null);
  }

  if (session.status === "done") {
    entry.item.mediaId = session.media?.id ?? entry.item.mediaId;
    return { ok: true, error: null, retryable: false, status: 200 };
  }
  const mediaId = session.mediaId;
  const partSize = session.partSize ?? 0;
  const totalParts = session.totalParts ?? 0;
  if (!mediaId || partSize <= 0 || totalParts <= 0) {
    return { ok: false, error: "Сервер не принял план загрузки", retryable: true, status: 502 };
  }
  entry.item.mediaId = mediaId;
  entry.stage = "parts";
  entry.partsTotal = totalParts;

  const done = new Set(session.uploadedPartNumbers ?? []);
  let sentBytes = done.size * partSize;
  entry.partsDone = done.size;
  entry.item.loaded = Math.min(sentBytes, file.size);
  publish();

  for (let n = 1; n <= totalParts; n++) {
    if (entry.cancelled) return { ok: false, error: null, retryable: false, status: 0 };
    if (done.has(n)) continue;
    const chunk = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
    const base = sentBytes;
    const res = await xhrSendAuthed(
      "PUT",
      `${API_PREFIX}/videos/${mediaId}/parts/${n}`,
      chunk,
      (loaded) => {
        entry.item.loaded = Math.min(base + loaded, file.size);
        publish();
      },
      "application/octet-stream",
      entry.agentId
    );
    if (res.status < 200 || res.status >= 300) {
      // D1, «два повтора подряд одной и той же части» (23.09.2026) — та же
      // проверка, что и в очереди карточки (uploadQueue.ts::sendVideoTask),
      // отдельная копия: этот файл её тоже не разделяет с той очередью
      // (см. докстринг наверху файла — своя маленькая очередь на время мастера).
      if (res.status === 0 && res.zeroProgress) {
        const prevPart = lastZeroProgressPart.get(entry.item.uploadKey);
        if (prevPart === n) {
          lastZeroProgressPart.delete(entry.item.uploadKey);
          // Нечитаемым объявляем, только если кусок реально не читается: два обрыва
          // без байта подряд так же выглядят при отсутствии связи (WEB-10).
          if (!(await isBlobReadable(chunk))) {
            return { ok: false, error: unreadableFileMessage(true), retryable: false, status: 422 };
          }
        } else {
          lastZeroProgressPart.set(entry.item.uploadKey, n);
        }
      } else {
        lastZeroProgressPart.delete(entry.item.uploadKey);
      }
      return outcomeFromStatus(res.status, res.error);
    }
    sentBytes = Math.min(base + chunk.size, file.size);
    entry.item.loaded = sentBytes;
    entry.partsDone = (entry.partsDone ?? 0) + 1;
    publish();
  }

  entry.stage = "complete";
  try {
    await withDeadline(
      api(`/properties/drafts/current/videos/${mediaId}/complete`, {
        method: "POST",
        expectAgentId: entry.agentId ?? undefined,
      }),
      COMPLETE_DEADLINE_MS
    );
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0;
    // 409 на сборке — часть до сервера всё же не дошла: повторяем круг, а не
    // объявляем файл испорченным.
    return outcomeFromStatus(status === 409 ? 0 : status, (err as { message?: string }).message ?? null);
  }
  return { ok: true, error: null, retryable: false, status: 201 };
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface XhrResult {
  status: number;
  text: string;
  error: string | null;
  /** status 0 БЕЗ единого байта прогресса — признак нечитаемого блоба, а не
   *  обрыва связи на середине (D1, 23.09.2026). Только для сравнения в
   *  sendVideo — у sendPhoto не смотрим. */
  zeroProgress?: boolean;
}

/**
 * Отдача с полосой прогресса. Через XMLHttpRequest, а не fetch, по той же
 * причине, что и в общей очереди: fetch не сообщает браузеру о ходе ОТПРАВКИ
 * байт вообще, ни в одном браузере.
 *
 * ЗАПРОС ОБЯЗАН ЧЕМ-ТО ЗАКОНЧИТЬСЯ (найдено 21.09.2026, живая жалоба владельца
 * «видео не грузится, а показывает что-то другое»).
 *
 * Здесь было три события — `onload`, `onerror`, `ontimeout` — и ни одно из них
 * не срабатывает, когда браузер ОБРЫВАЕТ запрос сам: тогда приходит `abort`.
 * А `ontimeout` был мёртвой веткой: без явного `xhr.timeout` (по умолчанию 0)
 * XHR ждёт ответа бесконечно и это событие не шлёт никогда. Обещание в обоих
 * случаях не исполнялось вовсе, флаг `running` в run() оставался поднятым — и
 * очередь, которая ходит строго по одному файлу, вставала намертво до
 * перезагрузки страницы. Стоящий за ней ролик так и висел «Ждёт очереди» и на
 * сервер не уходил.
 *
 * Что обрывает запрос на телефоне: свёрнутое посреди отдачи приложение (тот же
 * случай, что даёт «Unexpected end of form» в app.ts), переключение Wi-Fi→LTE,
 * усыплённая вкладка. Это не редкость, а обычный день агента в квартире.
 *
 * ПОЧЕМУ СТОРОЖ ПО ТИШИНЕ, А НЕ `xhr.timeout`. `xhr.timeout` считает ВСЁ время
 * запроса, а часть ролика в 8 МБ на медленном мобильном канале честно едет
 * минутами — глухой потолок убивал бы живую отдачу. Сторож смотрит не на общее
 * время, а на движение байт: пока прогресс идёт, он отодвигается. Молчание
 * дольше STALL_MS — запрос мёртв, рвём его сами и отдаём status 0, который
 * очередь уже умеет считать обрывом связи (ждёт событие online, попыток сервера
 * не тратит).
 */
const STALL_MS = 60_000;

/**
 * То же, что `xhrSend`, плюс ОДНА попытка обновить протухший токен.
 *
 * Доступ живёт 15 минут (`JWT_ACCESS_TTL`), а мастер заполняют стоя в квартире —
 * дольше. Остальная CRM этого не замечает: `api()` на 401 сам ходит за новым
 * токеном и повторяет запрос. Здесь же отдача идёт голым XHR (ради полосы
 * прогресса), мимо той логики, и 401 попадал в `outcomeFromStatus` как отказ по
 * существу — снимок навсегда вставал «Ошибка 401» и ждал, пока агент нажмёт
 * «Повторить» руками. Для видео хуже: 401 на части рвал весь круг отдачи.
 *
 * Ровно одна попытка: если и с новым токеном 401 — это уже не протухший токен,
 * а настоящий отказ в доступе, и повторять его нечем.
 */
async function xhrSendAuthed(
  method: string,
  path: string,
  body: XMLHttpRequestBodyInit,
  onProgress: (loaded: number, total: number) => void,
  contentType?: string,
  /** Чей файл (WEB-03): токеном другого сотрудника он не уходит ни сразу, ни после refresh. */
  ownerId?: string | null
): Promise<XhrResult> {
  const sessionChanged = () => !!ownerId && currentAgentId() !== ownerId;
  const SESSION_CHANGED: XhrResult = { status: 0, text: "", error: "Сессия сменилась" };
  if (sessionChanged()) return SESSION_CHANGED;
  const first = await xhrSend(method, path, body, onProgress, contentType);
  if (first.status !== 401 || !useAuthStore.getState().hasSession) return first;
  const token = await refreshAccessToken();
  if (!token) return first;
  // refresh мог пройти уже под другим аккаунтом (А вышел, вошёл Б).
  if (sessionChanged()) return SESSION_CHANGED;
  return xhrSend(method, path, body, onProgress, contentType);
}

function xhrSend(
  method: string,
  path: string,
  body: XMLHttpRequestBodyInit,
  onProgress: (loaded: number, total: number) => void,
  contentType?: string
): Promise<XhrResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    // Видел ли этот запрос хоть один байт прогресса — см. XhrResult.zeroProgress.
    let sawProgress = false;

    const settle = (result: XhrResult) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      resolve(result.status === 0 ? { ...result, zeroProgress: !sawProgress } : result);
    };
    /** Тишина пошла заново: байты двинулись или тело ушло целиком и теперь
     *  очередь ждёт ответа сервера (sharp по снимку, запись части на диск). */
    const beat = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // abort() поднимет onabort, тот и исполнит обещание — но настаиваем
        // сами на случай, если событие не придёт.
        xhr.abort();
        settle({ status: 0, text: "", error: "Связь пропала — продолжу, когда появится" });
      }, STALL_MS);
    };

    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Device-Id", getOrCreateDeviceId());
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    const token = useAuthStore.getState().accessToken;
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      beat();
      if (e.loaded > 0) sawProgress = true;
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.upload.onload = beat;
    xhr.onerror = () => settle({ status: 0, text: "", error: "Нет связи" });
    xhr.ontimeout = () => settle({ status: 0, text: "", error: "Превышено время ожидания" });
    xhr.onabort = () => settle({ status: 0, text: "", error: "Связь пропала — продолжу, когда появится" });
    xhr.onload = () => {
      let error: string | null = null;
      if (xhr.status < 200 || xhr.status >= 300) {
        error = parseJson<{ error?: string }>(xhr.responseText)?.error ?? null;
      }
      settle({ status: xhr.status, text: xhr.responseText, error });
    };
    beat();
    xhr.send(body);
  });
}
