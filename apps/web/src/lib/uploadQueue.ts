import { api, refreshAccessToken } from "./api";
import { ApiError } from "./apiError";
import { httpStatusMessage } from "./httpStatusMessage";
import { getOrCreateDeviceId } from "./deviceId";
import { queryClient } from "./queryClient";
import { reportUploadIssue } from "./errorReporter";
import { computeSpeedBps, isBlobReadable, unreadableFileMessage, type ProgressSample } from "./uploadFormat";
import { useAuthStore } from "../store/auth";
import { registerWork } from "./workGuard";

/**
 * Очередь загрузки фотографий и видео: прогресс видно, ничего не пропадает.
 *
 * ЧТО БЫЛО. Отправка жила внутри мутации на экране. Оборвалась связь — мутация
 * упала, на экране ошибка, а выбранные файлы исчезли вместе с ней: агент заново
 * лез в галерею и заново отмечал тридцать снимков. Уход со страницы, случайно
 * закрытая вкладка и заблокированный экран телефона убивали загрузку так же.
 *
 * ЧТО СТАЛО. Задание живёт в IndexedDB вместе с самими файлами и переживает и
 * обрыв связи, и перезагрузку, и закрытие приложения. Очередь подхватывает его
 * при следующем запуске и при появлении сети и доводит до конца сама.
 *
 * ПОЧЕМУ INDEXEDDB, А НЕ ОЧЕРЕДЬ ИЗ lib/offlineQueue.ts. Та хранит отложенные
 * запросы в localStorage, а в localStorage можно положить только строку —
 * файлы туда не кладутся в принципе. IndexedDB хранит Blob как есть.
 *
 * ПОЧЕМУ НЕ BACKGROUND FETCH. Он умеет докачивать при полностью закрытом
 * приложении, но его нет в Safari — то есть у половины агентов. Очередь
 * закрывает те же случаи (лифт, метро, севшая связь) и работает у всех.
 *
 * ВИДЕО ДОКАЧИВАЕТСЯ С СЕРЕДИНЫ. Ролик режется на части (план присылает сервер —
 * см. POST .../videos/upload-sessions в routes/properties.ts), каждая уходит
 * своим запросом, и обрыв на середине не начинает файл заново — очередь досылает
 * только недостающие части. Фотографии в этом не нуждаются: пачка из шести
 * снимков весит несравнимо меньше минутного видео, и повторить её целиком дёшево.
 */

/**
 * `photo` — пачка снимков; `video` — сырой исходник монтажёру (докачка частями,
 * без сжатия); `clip` — короткий ролик карточки, который сервер сжимает сам
 * (ffmpeg, H.264 480p ~700 кбит/с, см. POST /properties/:id/clip-video).
 *
 * `clip` заведён для мастера добавления объекта: агент снимает обход квартиры
 * телефоном, и хранить этот ролик в исходном весе незачем — конвейер умеет его
 * сжимать. Частями `clip` не грузится (у маршрута сжатия нет сессий докачки),
 * зато повтор при обрыве и хранение файла до отправки у него общие с остальными.
 */
export type UploadKind = "photo" | "video" | "clip";

/** `pending` — ждёт очереди или сети; `uploading` — идёт сейчас; `failed` — отказ, требующий человека. */
export type UploadStatus = "pending" | "uploading" | "failed";

export interface StoredTask {
  id: string;
  kind: UploadKind;
  propertyId: string;
  /** Номер объекта — только чтобы из общего указателя увести в карточку.
   *  Адреса карточек построены на нём, а не на внутреннем id. */
  propertyShortId?: number;
  /** Что показать человеку: «6 фото» или имя видеофайла. */
  label: string;
  files: Blob[];
  filenames: string[];
  /** По одному на файл — им сервер отличает повтор от новой пачки. */
  uploadKeys: string[];
  totalBytes: number;
  status: UploadStatus;
  attempts: number;
  error: string | null;
  createdAt: number;
  /**
   * Кто поставил задание (аудит 04.10.2026, WEB-02). Файлы одного сотрудника не
   * уходят токеном другого: общий телефон, А вышел с неотправленной загрузкой, вошёл
   * Б. Чужие задания лежат до входа автора и Б их не видит. Нет поля у заданий,
   * созданных до этого исправления: их первый же проход очереди записывает на
   * текущего сотрудника (владельца уже не узнать).
   */
  agentId?: string;
  /** Когда можно пробовать снова (бэкофф). Отсутствует у задания, которое ещё
   *  ни разу не пыталось уйти, и у отказавшего окончательно (`failed`). Хранится
   *  НА ЗАДАНИИ, а не только в общем состоянии экрана: HEARTBEAT_MS (60 с) и
   *  событие `online` зовут run() безусловно, и без этого поля бэкофф с паузой
   *  в 5 минут превращался бы в повтор каждую минуту (найдено 17.09.2026). */
  nextAttemptAt?: number;
}

/** То же задание без файлов — всё, что нужно экрану. */
export type UploadTaskView = Omit<StoredTask, "files">;

export interface UploadQueueState {
  tasks: UploadTaskView[];
  /** Байт отправлено и всего — по заданию, которое идёт прямо сейчас. */
  activeId: string | null;
  activeLoaded: number;
  activeTotal: number;
  /** Скользящая скорость активного задания за последние ~5 с (uploadFormat.ts,
   *  computeSpeedBps) — `null`, пока данных мало (см. там же). Честная строка
   *  задания (UploadTaskRow) показывает по ней «250 КБ/с · осталось ~12 мин»
   *  вместо голого процента (найдено 23.09.2026). */
  activeSpeedBps: number | null;
  /** `navigator.onLine === false` — обновляется событиями online/offline, а не
   *  угадывается по «отправка не идёт» (см. разбор бага баннера, 17.09.2026). */
  offline: boolean;
  /** Когда следующая попытка задания, которое сейчас ждёт бэкоффа. `null` —
   *  бэкофф не идёт (либо всё грузится, либо всё либо готово, либо отказало). */
  nextAttemptAt: number | null;
  /** Текст последнего отказа задания, которое сейчас в бэкоффе — тот же текст,
   *  что покажет строка задания (UploadTaskRow), баннер его не придумывает заново. */
  lastError: string | null;
}

/**
 * Сколько фотографий уходит одним запросом.
 *
 * Шесть, а не одна: каждый запрос дёргает выкладку объекта на royalhome.tj
 * (resyncPhotosIfPublished на сервере), и тридцать снимков по одному означали бы
 * тридцать синхронизаций. И не вся пачка разом: один гигантский запрос на
 * мобильном интернете рвётся целиком.
 */
const PHOTO_BATCH_SIZE = 6;

/**
 * Вторая граница пачки — по весу, а не только по числу файлов (найдено
 * 17.09.2026: шесть кадров с современного телефона в высоком разрешении легко
 * дают 60-80 МБ одним POST, и такой запрос рвётся на мобильном интернете чаще,
 * чем шесть маленьких). Обе границы считаются одновременно — какая наступит
 * раньше, та и закрывает пачку. Один файл больше предела всё равно уходит
 * один в своей пачке — резать файл на части `sendPhotoTask` не умеет, а
 * держать его в очереди вечно хуже, чем отправить как есть.
 */
const PHOTO_BATCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Порог, после которого «сжатое» фото на самом деле не сжалось: `compressImage`
 * возвращает оригинал без изменений, если canvas не смог декодировать файл
 * (частый случай — HEIC на телефоне без поддержки декодера в этом браузере).
 * 2560px и качество 0.85 (`compressImage.ts`) на любом реально декодированном
 * фото дают в разы меньше — то есть файл ТАКОГО веса после «сжатия» почти
 * наверняка так и остался неизменным оригиналом с камеры (20-40 МБ), а не
 * честно сжатым снимком (см. пункт 5 задания upload-queue-honest-17-09.md).
 */
const HUGE_AFTER_COMPRESS_BYTES = 12 * 1024 * 1024;

/**
 * Раскладка подготовленных файлов по пачкам с учётом обеих границ.
 * Чистая функция — не трогает хранилище, поэтому тестируется без IndexedDB.
 */
export function batchPhotos(files: File[], maxCount = PHOTO_BATCH_SIZE, maxBytes = PHOTO_BATCH_MAX_BYTES): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const overCount = current.length >= maxCount;
    // Первый файл пачки всегда принимается — иначе один файл тяжелее лимита
    // блокировал бы себя же навечно, ни в одну пачку не помещаясь.
    const overBytes = current.length > 0 && currentBytes + file.size > maxBytes;
    if (overCount || overBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const DB_NAME = "royal-home-uploads";
const STORE = "tasks";
const DB_VERSION = 1;

/** Пауза перед повтором: 5с, 10с, 20с… но не длиннее пяти минут. */
export function retryDelayMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
}

/**
 * Потолок автоматических попыток для «повторяемого» отказа (найдено 17.09.2026:
 * объект ОБ-000095 у Нозы — 112 попыток за 6,5 часов, ни одна не прошла).
 *
 * Обрыв связи и 5xx считались повторяемыми БЕЗ ПРЕДЕЛА — правильно для настоящей
 * плохой связи, которая рано или поздно налаживается. Но если файл в IndexedDB
 * пришёл битым (не полностью сохранился блоб — известный класс багов мобильных
 * браузеров) или сервер отказывает по причине, которая сама не пройдёт, — повтор
 * НИКОГДА не сработает, а строка в очереди всё это время пишет агенту «повторим
 * автоматически», убеждая, что всё под контролем. Агент ждёт день за днём, файл
 * не уходит, руководитель узнаёт только по счётчику просрочки маркетинга.
 *
 * 10 попыток — это ~25 минут повторов с нарастающей паузой (retryDelayMs), с
 * запасом покрывает реальный обрыв (лифт, метро, потеря сигнала на минуту-две).
 * Дальше — это уже не сеть, а сам файл, и агенту нужно увидеть отказ и решить
 * (обычно: убрать и переснять/выбрать фото заново).
 */
export const MAX_RETRY_ATTEMPTS = 10;

// ─────────────────────────── хранилище ───────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB недоступна"));
    });
    // Неудачную попытку не запоминаем: приватный режим или запрет хранилища —
    // состояние временное, и следующий вызов обязан попробовать заново, а не
    // получить навсегда отказавшее обещание. Приложение при этом живёт целиком,
    // теряется только устойчивость загрузки к обрывам.
    void attempt.catch(() => {
      if (dbPromise === attempt) dbPromise = null;
    });
    dbPromise = attempt;
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Ошибка хранилища загрузок"));
        // Chromium отказывает записи блоба («Error preparing Blob/File data to be
        // stored in object store») не ошибкой запроса, а обрывом транзакции.
        transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("Ошибка хранилища загрузок"));
      })
  );
}

/**
 * Задания, которые не влезли в IndexedDB (найдено 22.09.2026: видео к объекту
 * ОБ-000118 — «Error preparing Blob/File data to be stored in object store»).
 *
 * Браузер не может скопировать в своё хранилище файл — гигабайтный ролик, не
 * хватает квоты или места на диске, файл лежит в облаке галереи и читается
 * лишь по ссылке. Раньше отказ записи ронял постановку в очередь целиком, и
 * агент видел английскую ошибку браузера, хотя сам файл отправить можно: у
 * видео он режется через `file.slice`, а тот читает исходный файл с диска.
 *
 * Поэтому такое задание живёт в памяти вкладки: уходит на сервер как обычное,
 * но не переживает перезагрузку страницы (в IndexedDB его нет) — это цена
 * отказа хранилища, а не потеря функции.
 */
const volatileTasks = new Map<string, StoredTask>();

async function readAll(): Promise<StoredTask[]> {
  let stored: StoredTask[] = [];
  try {
    stored = await tx<StoredTask[]>("readonly", (s) => s.getAll() as IDBRequest<StoredTask[]>);
  } catch {
    // Хранилище недоступно целиком (приватный режим) — очередь живёт на памяти.
    if (volatileTasks.size === 0) throw new Error("Хранилище загрузок недоступно");
  }
  if (volatileTasks.size === 0) return stored;
  const byId = new Map(stored.map((t) => [t.id, t]));
  volatileTasks.forEach((t, id) => byId.set(id, t));
  return [...byId.values()];
}

async function put(task: StoredTask): Promise<void> {
  if (!volatileTasks.has(task.id)) {
    try {
      await tx("readwrite", (s) => s.put(task) as IDBRequest<IDBValidKey>);
      return;
    } catch {
      // Не записалось — держим задание в памяти, файл всё равно отправится.
    }
  }
  volatileTasks.set(task.id, task);
}

async function drop(id: string): Promise<void> {
  const wasVolatile = volatileTasks.delete(id);
  try {
    await tx("readwrite", (s) => s.delete(id) as unknown as IDBRequest<undefined>);
  } catch (err) {
    // Задание, которого в хранилище и не было, удалять оттуда не нужно.
    if (!wasVolatile) throw err;
  }
}

// ─────────────────────────── состояние для экрана ───────────────────────────

let state: UploadQueueState = {
  tasks: [],
  activeId: null,
  activeLoaded: 0,
  activeTotal: 0,
  activeSpeedBps: null,
  offline: typeof navigator !== "undefined" && navigator.onLine === false,
  nextAttemptAt: null,
  lastError: null,
};
const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ссылка меняется только при настоящем изменении — иначе useSyncExternalStore зациклится. */
export function getSnapshot(): UploadQueueState {
  return state;
}

function setState(next: Partial<UploadQueueState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

async function refreshTasks() {
  try {
    const tasks = tasksOfAgent(await readAll(), currentAgentId())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ files: _files, ...view }) => view);
    setState({ tasks });
  } catch {
    // Хранилище недоступно — показывать нечего, но и падать не из-за чего.
    setState({ tasks: [] });
  }
}

// ─────────────────────────── постановка в очередь ───────────────────────────

function newKey(): string {
  // crypto.randomUUID есть во всех браузерах, где работает CRM (https + PWA),
  // но запасной путь стоит копейки, а без ключа отправка теряет защиту от повторов.
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function currentAgentId(): string | undefined {
  return useAuthStore.getState().agent?.id;
}

/** Задания, которые вправе видеть и отправлять сотрудник `me`: свои и старые без автора. */
export function tasksOfAgent<T extends { agentId?: string }>(tasks: T[], me: string | undefined): T[] {
  return tasks.filter((t) => !t.agentId || t.agentId === me);
}

async function addTask(task: StoredTask) {
  await put({ ...task, agentId: task.agentId ?? currentAgentId() });
  await refreshTasks();
  void run();
}

/**
 * Фотографии. Сжатие (HEIC с iPhone → JPEG) делается ДО постановки в очередь:
 * так в хранилище лежит то же, что уйдёт на сервер, и повтор не пережимает
 * снимки заново.
 */
export async function enqueuePhotos(
  propertyId: string,
  files: File[],
  compress: (f: File) => Promise<File>,
  propertyShortId?: number
) {
  const prepared = await Promise.all(files.map(compress));

  // Файл, который «сжатие» не сжало (см. HUGE_AFTER_COMPRESS_BYTES), в очередь
  // не идёт вслепую — отправлять 20-40 МБ HEIC на мобильном интернете и молча
  // ловить тот же обрыв, что и весь этот разбор, бессмысленно. Задание сразу
  // ложится как failed, человек видит причину и решает (переснять/пересохранить
  // в JPEG) сам, а не после десяти неудачных попыток.
  const sendable: File[] = [];
  let offset = 0;
  for (const file of prepared) {
    if (file.size > HUGE_AFTER_COMPRESS_BYTES) {
      await addTask({
        id: newKey(),
        kind: "photo",
        propertyId,
        propertyShortId,
        label: file.name,
        files: [file],
        filenames: [file.name],
        uploadKeys: [newKey()],
        totalBytes: file.size,
        status: "failed",
        attempts: 0,
        error: "Формат фото не поддерживается телефоном, сохраните как JPEG",
        createdAt: Date.now() + offset++,
      });
    } else {
      sendable.push(file);
    }
  }

  for (const batch of batchPhotos(sendable)) {
    await addTask({
      id: newKey(),
      kind: "photo",
      propertyId,
      propertyShortId,
      label: batch.length === 1 ? batch[0].name : `${batch.length} фото`,
      files: batch,
      filenames: batch.map((f) => f.name),
      uploadKeys: batch.map(() => newKey()),
      totalBytes: batch.reduce((sum, f) => sum + f.size, 0),
      status: "pending",
      attempts: 0,
      error: null,
      createdAt: Date.now() + offset++,
    });
  }
}

/** Видео — по одному файлу на задание: они великанские, и повтор пачки стоил бы гигабайтов. */
export async function enqueueVideos(propertyId: string, files: File[], propertyShortId?: number) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    await addTask({
      id: newKey(),
      kind: "video",
      propertyId,
      propertyShortId,
      label: file.name,
      files: [file],
      filenames: [file.name],
      uploadKeys: [newKey()],
      totalBytes: file.size,
      status: "pending",
      attempts: 0,
      error: null,
      createdAt: Date.now() + i,
    });
  }
}

/**
 * Короткий ролик карточки объекта — один на объект, повторная загрузка заменяет
 * предыдущий. Сжимает сервер, поэтому здесь файл не трогаем: браузер видео
 * не пережимает, а отдать его как есть дешевле, чем не отдать вовсе.
 */
export async function enqueueClipVideo(propertyId: string, file: File, propertyShortId?: number) {
  await addTask({
    id: newKey(),
    kind: "clip",
    propertyId,
    propertyShortId,
    label: file.name,
    files: [file],
    filenames: [file.name],
    uploadKeys: [newKey()],
    totalBytes: file.size,
    status: "pending",
    attempts: 0,
    error: null,
    createdAt: Date.now(),
  });
}

/** Убрать задание руками — единственный способ потерять файл, и он осознанный. */
export async function removeTask(id: string) {
  // Кнопка «убрать» видна только у остановленных заданий (UploadTaskRow) — то
  // есть у видео это почти всегда та, что уже открыла сессию на сервере.
  // Забираем задание до удаления, чтобы было что отменять.
  const all = await readAll();
  const task = all.find((t) => t.id === id);
  await drop(id);
  await refreshTasks();
  if (task?.kind === "video") void cancelVideoSession(task);
}

/**
 * Отмена незавершённой сессии видео на сервере — чтобы R2 не хранил платно
 * то, от чего человек только что отказался. Не критично: если запрос не дойдёт
 * (человек убрал задание, будучи офлайн), ночная уборка на сервере
 * (lib/videoUploadCleanup.ts) заберёт брошенную сессию сама через 48 часов.
 */
async function cancelVideoSession(task: StoredTask) {
  try {
    const file = task.files[0];
    const start = await api<StartSessionResponse>(`/properties/${task.propertyId}/videos/upload-sessions`, {
      method: "POST",
      body: {
        uploadKey: task.uploadKeys[0],
        filename: task.filenames[0],
        sizeBytes: file.size,
        contentType: file.type || "video/mp4",
      },
    });
    // "done" — файл уже собран прошлой попыткой; удалять здесь нечего и не нужно:
    // это не сессия, а готовое видео, и убирать его из карточки — отдельное
    // действие человека, а не следствие уборки очереди.
    if (start.status === "done" || !start.sessionId) return;
    await api(`/properties/${task.propertyId}/videos/upload-sessions/${start.sessionId}`, { method: "DELETE" });
  } catch {
    // См. комментарий выше — ночная уборка подстрахует.
  }
}

/** «Попробовать ещё раз» для задания, остановленного отказом сервера. */
export async function retryTask(id: string) {
  const all = await readAll();
  const task = all.find((t) => t.id === id);
  if (!task) return;
  await put({ ...task, status: "pending", attempts: 0, error: null });
  await refreshTasks();
  void run();
}

// ─────────────────────────── отправка ───────────────────────────

export interface SendResult {
  status: number;
  error: string | null;
  /** Тело ответа COMPLETE — нужно там, где сам JSON важен вызывающему (докачка
   *  готового ролика от монтажёра, PropertyVideoFixCard.tsx: publishSummary),
   *  не только код ответа. У остальных заданий (raw/photo/clip) не читается. */
  data?: unknown;
  /** id собранного PropertyVideo — только у видео по частям purpose=raw, когда
   *  файл собран (main, 22.09.2026, «Вернуть монтажёру» с новым исходником). */
  videoId?: string;
  /** Часть ушла со статусом 0 (обрыв), но не отдала НИ БАЙТА (нет ни одного
   *  события onprogress с loaded>0) — признак нечитаемого блоба, а не обрыва
   *  связи на середине. Только у частей видео, см. putVideoPart. */
  zeroProgress?: boolean;
  /** Номер части, на которой отправка остановилась — только у неудачи внутри
   *  uploadVideoChunked, чтобы sendVideoTask мог сравнить с прошлой попыткой
   *  (D1, «два повтора подряд одной и той же части» — см. 23.09.2026). */
  failedPartNumber?: number;
  /** Сам кусок файла, на котором остановились: sendVideoTask читает его, прежде чем
   *  объявить файл нечитаемым (WEB-10). Только в памяти, в IndexedDB не пишется. */
  failedPartBlob?: Blob;
  /** Сколько частей видео уже подтверждено / всего — для телеметрии (D2),
   *  только у отказа многочастевой докачки. */
  partsDone?: number;
  partsTotal?: number;
}

/** ApiError → тот же формат результата, что и у прямых XHR-запросов ниже:
 *  один код на оба пути отправки, run() разбирает их одинаково. */
/** 409 на COMPLETE «не все части получены» (routes/properties/videos.ts) несёт
 *  список дошедших частей — только по нему второй круг докачки имеет смысл. */
function isPartsMismatch(data: unknown): boolean {
  return Array.isArray((data as { uploadedPartNumbers?: unknown } | null | undefined)?.uploadedPartNumbers);
}

function apiErrorToResult(err: unknown): SendResult {
  if (err instanceof ApiError) return { status: err.status, error: err.message };
  // Потолок ожидания из withDeadline ниже: не ApiError, но свой честный текст.
  if ((err as { status?: number } | null)?.status === 0 && err instanceof Error) {
    return { status: 0, error: err.message };
  }
  // TypeError сети, обрыв до получения статуса — тот же смысл, что и XHR.onerror.
  return { status: 0, error: "Нет связи" };
}

/**
 * ОБРЫВ ЗАПРОСА И ТИШИНА В КАНАЛЕ — ОТЧЕГО ОЧЕРЕДЬ ВСТАВАЛА НАСОВСЕМ
 * (найдено 21.09.2026 по живой жалобе владельца: грузил видео с телефона,
 * одно ушло, остальные повисли и не двигались).
 *
 * `run()` ведёт задания строго по одному и держит флаг `running`, пока ждёт
 * `sendTask`. Каждая из трёх отправок ниже слушала только `onload`, `onerror`
 * и `ontimeout` — а браузер, обрывая запрос сам, поднимает `abort`. Обещание
 * не исполнялось ничем, `running` оставался поднятым, и очередь была мертва до
 * перезагрузки страницы: ни это задание, ни следующие уже не уходили.
 *
 * Обрывает запрос обычный день агента с телефоном: свёрнутое посреди отдачи
 * приложение, переключение Wi-Fi→LTE, усыплённая вкладка. К тому же `ontimeout`
 * был мёртвой веткой всюду, кроме `sendPhotoTask`: без явного `xhr.timeout`
 * (по умолчанию 0) XHR ждёт ответа бесконечно и этого события не шлёт никогда.
 *
 * ПОЧЕМУ СТОРОЖ ПО ТИШИНЕ, А НЕ ОДИН `xhr.timeout` НА ВСЕХ. `xhr.timeout`
 * считает ВСЁ время запроса, а часть ролика в 8 МБ на медленном мобильном
 * канале честно едет минутами — глухой потолок убивал бы живую отдачу. Сторож
 * смотрит не на общее время, а на движение байт: пока идёт прогресс, он
 * отодвигается. Молчание дольше STALL_MS — запрос мёртв, рвём его сами и
 * отдаём `status 0`, который `run()` уже считает обрывом связи (повтор с
 * нарастающей паузой, попыток человека не тратит).
 *
 * Та же починка — в очереди мастера объекта (`lib/draftUploads.ts::xhrSend`).
 * Очереди две, и дыра была в обеих: чинить надо обе, иначе разъедутся.
 */
export const STALL_MS = 60_000;

/** Текст один на обрыв и на тишину: для человека это один и тот же случай. */
export const STALLED_ERROR = "Связь пропала — попробуем ещё раз";

/**
 * Обвязка XHR, общая для всех трёх отправок: честный конец на `abort` и сторож
 * по тишине. `settle` заменяет прямой `resolve` (обещание исполняется ровно
 * один раз), `beat()` отодвигает сторожа и вызывается на каждом движении байт.
 */
export function guardXhr(xhr: XMLHttpRequest, resolve: (result: SendResult) => void) {
  let settled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (result: SendResult) => {
    if (settled) return;
    settled = true;
    if (stallTimer) clearTimeout(stallTimer);
    resolve(result);
  };
  const beat = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      // abort() поднимет onabort, тот и исполнит обещание — но настаиваем
      // сами на случай, если событие не придёт.
      xhr.abort();
      settle({ status: 0, error: STALLED_ERROR });
    }, STALL_MS);
  };
  xhr.onabort = () => settle({ status: 0, error: STALLED_ERROR });
  return { settle, beat };
}

/**
 * СЕССИЯ И СБОРКА ВИДЕО ХОДЯТ `fetch`'ем, МИМО СТОРОЖА ВЫШЕ.
 *
 * `api()` — это `fetch`, а у `fetch` нет никакого потолка ожидания по
 * умолчанию: зависший ответ держал бы `sendVideoTask` (а с ним и `running`)
 * ровно так же, как обрыв части. Сторож по тишине здесь не годится — прогресса
 * у этих запросов нет, — поэтому им честный потолок по общему времени. Тела
 * крошечные, оба шага идемпотентны: повтор круга открывает ту же сессию по
 * тому же `uploadKey` и досылает недостающие части.
 */
const SESSION_DEADLINE_MS = 30_000;
/** Сборка ждёт дольше: сервер склеивает части на диске. */
const COMPLETE_DEADLINE_MS = 120_000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      // status 0 — тот же смысл, что у обрыва связи: очередь подождёт сети и
      // повторит круг, не тратя попыток человека.
      () => reject(Object.assign(new Error(STALLED_ERROR), { status: 0 })),
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
 * Короткий ролик — одним запросом на маршрут сжатия. Сессий докачки у него нет
 * (сервер принимает файл целиком и ставит задание ffmpeg), поэтому при обрыве
 * очередь повторяет ролик заново — как и пачку фотографий.
 */
function sendClipTask(task: StoredTask, token: string | null, onProgress: (loaded: number, total: number) => void) {
  return new Promise<SendResult>((resolve) => {
    const form = new FormData();
    form.append("video", task.files[0], task.filenames[0]);

    const xhr = new XMLHttpRequest();
    const { settle, beat } = guardXhr(xhr, resolve);
    xhr.open("POST", `/api/v1/properties/${task.propertyId}/clip-video`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Device-Id", getOrCreateDeviceId());
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      beat();
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    // Тело ушло целиком — дальше ждём сервер (ffmpeg ставит задание), и это
    // тоже движение: сторож отсчитывает тишину заново.
    xhr.upload.onload = beat;
    xhr.onerror = () => settle({ status: 0, error: "Нет связи" });
    xhr.ontimeout = () => settle({ status: 0, error: "Превышено время ожидания" });
    xhr.onload = () => {
      let error: string | null = null;
      if (xhr.status < 200 || xhr.status >= 300) {
        try {
          error = (JSON.parse(xhr.responseText) as { error?: string })?.error ?? null;
        } catch {
          error = null;
        }
      }
      settle({ status: xhr.status, error });
    };
    beat();
    xhr.send(form);
  });
}

function sendTask(task: StoredTask, token: string | null, onProgress: (loaded: number, total: number) => void) {
  if (task.kind === "photo") return sendPhotoTask(task, token, onProgress);
  if (task.kind === "clip") return sendClipTask(task, token, onProgress);
  return sendVideoTask(task, onProgress);
}

/** Пачка фотографий — одним запросом, как и раньше. */
function sendPhotoTask(task: StoredTask, token: string | null, onProgress: (loaded: number, total: number) => void) {
  return new Promise<SendResult>((resolve) => {
    const form = new FormData();
    task.files.forEach((file, i) => form.append("photos", file, task.filenames[i]));
    task.uploadKeys.forEach((key) => form.append("uploadKeys", key));

    const xhr = new XMLHttpRequest();
    const { settle, beat } = guardXhr(xhr, resolve);
    xhr.open("POST", `/api/v1/properties/${task.propertyId}/photos`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Device-Id", getOrCreateDeviceId());
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    // Без явного timeout XHR ждёт ответа бесконечно: зависший на сервере или
    // проглоченный где-то по дороге ответ держал бы задание в «отправляется»
    // навсегда — ни ошибки, ни повтора, ни честного баннера (найдено
    // 17.09.2026 при разборе «Внутренняя ошибка сервера» вперемешку с висящей
    // отправкой). 120 с — с запасом больше, чем нужно шести сжатым фото на
    // самом медленном мобильном канале, но не бесконечность.
    xhr.timeout = 120_000;
    // Единственный способ узнать реальный процент: fetch не сообщает браузеру
    // о ходе ОТПРАВКИ байт вообще, ни в одном браузере.
    xhr.upload.onprogress = (e) => {
      beat();
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    // Тело ушло целиком — дальше ждём сервер (sharp по каждому снимку), и это
    // тоже движение: сторож отсчитывает тишину заново.
    xhr.upload.onload = beat;
    // Обрыв связи. status 0 — «до сервера не дошло или ответ не вернулся»:
    // повторяем, за дубли отвечает ключ отправки на сервере.
    xhr.onerror = () => settle({ status: 0, error: "Нет связи" });
    xhr.ontimeout = () => settle({ status: 0, error: "Загрузка заняла слишком долго" });
    xhr.onload = () => {
      let error: string | null = null;
      if (xhr.status < 200 || xhr.status >= 300) {
        try {
          error = (JSON.parse(xhr.responseText) as { error?: string })?.error ?? null;
        } catch {
          error = null;
        }
      }
      settle({ status: xhr.status, error });
    };
    beat();
    xhr.send(form);
  });
}

/** Одна часть многочастевой загрузки видео. Токен читается заново на каждый
 *  вызов, а не берётся параметром: за время долгого ролика (десятки частей)
 *  токен мог обновиться шагом START внутри sendVideoTask, и часть обязана уйти
 *  со свежим. */
function putVideoPart(
  propertyId: string,
  sessionId: string,
  partNumber: number,
  blob: Blob,
  onProgress: (loaded: number) => void
) {
  return new Promise<SendResult>((resolve) => {
    const token = useAuthStore.getState().accessToken;
    const xhr = new XMLHttpRequest();
    // Видел ли этот запрос хоть один байт прогресса — признак того, что часть
    // РЕАЛЬНО читалась и уходила, а не отказала на старте (D1, 23.09.2026: два
    // подряд отказа status 0 без единого байта у одной и той же части — файл,
    // который телефон не даёт прочитать, а не обрыв связи на середине).
    let sawProgress = false;
    const { settle, beat } = guardXhr(xhr, (result) =>
      resolve(result.status === 0 ? { ...result, zeroProgress: !sawProgress } : result)
    );
    xhr.open("PUT", `/api/v1/properties/${propertyId}/videos/upload-sessions/${sessionId}/parts/${partNumber}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Device-Id", getOrCreateDeviceId());
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      beat();
      if (e.loaded > 0) sawProgress = true;
      if (e.lengthComputable) onProgress(e.loaded);
    };
    // Часть ушла целиком — дальше ждём запись на диск, и это тоже движение.
    xhr.upload.onload = beat;
    xhr.onerror = () => settle({ status: 0, error: "Нет связи" });
    xhr.ontimeout = () => settle({ status: 0, error: "Превышено время ожидания" });
    xhr.onload = () => {
      let error: string | null = null;
      if (xhr.status < 200 || xhr.status >= 300) {
        try {
          error = (JSON.parse(xhr.responseText) as { error?: string })?.error ?? null;
        } catch {
          error = null;
        }
      }
      settle({ status: xhr.status, error });
    };
    beat();
    xhr.send(blob);
  });
}

interface StartSessionResponse {
  status: "done" | "started" | "in-progress";
  sessionId?: string;
  partSize?: number;
  totalParts?: number;
  uploadedPartNumbers?: number[];
}

/** Что нужно ЛЮБОМУ вызывающему докачки с середины: сам файл, его ключ повтора
 *  и объект — вне зависимости от того, идёт ли он через очередь (StoredTask,
 *  purpose=raw) или отдельным действием панели (PropertyVideoFixCard.tsx,
 *  purpose=handoff). `purpose` уходит в тело START — сервер решает по нему,
 *  что сделать с собранным файлом (routes/properties/videos.ts).
 *
 * `completePurpose` — НЕ то же самое поле: это флаг тела COMPLETE
 * (`"MONTAJER_SOURCE"`, 22.09.2026, «Вернуть монтажёру» с новым исходником) —
 * независимая от `purpose` ось. `purpose` решает, во ЧТО превратится собранный
 * файл (PropertyVideo при raw, приём хендоффа при handoff); `completePurpose`
 * у raw-файла лишь отменяет автоматический возврат объекта на проверку
 * (revertToReviewAfterVideoUpload на сервере) — сырьё для перемонтажа не
 * новая версия объявления. У purpose=handoff completePurpose не передаётся:
 * сервер там никогда не решает про revert. */
export interface ChunkedVideoUploadInput {
  propertyId: string;
  /** `Blob`, не `File`: задания очереди хранят файлы как `Blob[]` (см. StoredTask
   *  выше — IndexedDB отдаёт их обратно так же), а всё, что здесь нужно от файла
   *  (`size`, `type`, `slice`), есть уже на `Blob`. */
  file: Blob;
  uploadKey: string;
  filename: string;
  purpose: "raw" | "handoff";
  completePurpose?: "MONTAJER_SOURCE";
  /** Загрузка принадлежит этому сотруднику (WEB-02): если вошёл другой, ни следующая
   *  часть, ни START/COMPLETE не уходят его токеном. */
  expectAgentId?: string;
}

/**
 * ДОКАЧКА ВИДЕО С СЕРЕДИНЫ — ОДНА ФУНКЦИЯ НА ОБА НАЗНАЧЕНИЯ (23.09.2026).
 *
 * Раньше это было приватным `sendVideoTask` только для очереди сырых видео
 * (kind: "video", purpose всегда "raw" по смыслу). Приём готового ролика от
 * монтажёра (PropertyVideoFixCard.tsx, «Загрузить готовый ролик») раньше слал
 * файл одним запросом (POST .../video-handoff/upload) — большие ролики упирались
 * в потолок 700 МБ/таймаут одного запроса. Теперь оба пути ходят СЮДА: та же
 * докачка с середины, что и у сырых видео, просто с purpose=handoff в START —
 * не вторая копия этой логики, см. задание.
 *
 * START и COMPLETE — через `api()`: он сам обновляет токен при 401 и разбирает
 * структурированную ошибку. Части — через XHR: только он умеет сообщать о ходе
 * ОТПРАВКИ байт, а без прогресса по частям полоса на минутном ролике простояла
 * бы неподвижной большую часть времени.
 */
export async function uploadVideoChunked(
  input: ChunkedVideoUploadInput,
  onProgress: (loaded: number, total: number) => void
): Promise<SendResult> {
  const { propertyId, file, uploadKey, filename, purpose, completePurpose, expectAgentId } = input;

  // Два круга: если после отправки всех частей сервер при COMPLETE ответит «не
  // все части получены» (409 — расхождение между тем, что дошло, и тем, что мы
  // считали дошедшим), второй круг спрашивает актуальный список у сервера и
  // досылает разницу. Не вечный цикл: два круга покрывают реальный случай,
  // третий — уже как повтор всего задания через обычную очередь/ручной повтор.
  for (let round = 0; round < 2; round++) {
    let start: StartSessionResponse & { video?: unknown };
    try {
      start = await withDeadline(
        api<StartSessionResponse & { video?: unknown }>(`/properties/${propertyId}/videos/upload-sessions`, {
          method: "POST",
          body: { uploadKey, filename, sizeBytes: file.size, contentType: file.type || "video/mp4", purpose },
          expectAgentId,
        }),
        SESSION_DEADLINE_MS
      );
    } catch (err) {
      return apiErrorToResult(err);
    }

    if (start.status === "done") {
      // Файл уже собран с прошлой попытки — сервер сообщил об этом сам. У
      // purpose=handoff такого не бывает (COMPLETE не заводит PropertyVideo,
      // findUnique по uploadKey его никогда не найдёт) — ветка общая на
      // случай раздачи одного uploadKey между вызовами, но реально живёт
      // только у purpose=raw.
      onProgress(file.size, file.size);
      return { status: 200, error: null, data: start.video, videoId: (start.video as { id?: string } | undefined)?.id };
    }

    const sessionId = start.sessionId!;
    const partSize = start.partSize!;
    const totalParts = start.totalParts!;
    const uploaded = new Set(start.uploadedPartNumbers ?? []);

    // Байт короче последней части ровно на «хвост» файла — тот же расчёт, что и
    // на сервере, иначе прогресс на последнем проценте дёргался бы назад.
    const bytesOfPart = (n: number) => (n === totalParts ? file.size - partSize * (totalParts - 1) : partSize);
    let confirmedBytes = [...uploaded].reduce((sum, n) => sum + bytesOfPart(n), 0);
    onProgress(confirmedBytes, file.size);

    let partsDoneCount = uploaded.size;
    let partFailed: SendResult | null = null;
    for (let n = 1; n <= totalParts; n++) {
      if (uploaded.has(n)) continue;
      const from = (n - 1) * partSize;
      const to = n === totalParts ? file.size : from + partSize;
      const blob = file.slice(from, to);
      // Части идут минутами, токен читается заново на каждую (см. putVideoPart):
      // сменился сотрудник, чужим токеном файл не досылаем, очередь повторит позже.
      if (expectAgentId && currentAgentId() !== expectAgentId) {
        return { status: 0, error: "Сессия сменилась — продолжим после входа автора" };
      }
      const result = await putVideoPart(propertyId, sessionId, n, blob, (loaded) => onProgress(confirmedBytes + loaded, file.size));
      if (result.status < 200 || result.status >= 300) {
        partFailed = { ...result, failedPartNumber: n, failedPartBlob: blob, partsDone: partsDoneCount, partsTotal: totalParts };
        break;
      }
      confirmedBytes += blob.size;
      partsDoneCount++;
      onProgress(confirmedBytes, file.size);
    }
    if (partFailed) return partFailed;

    try {
      const data = await withDeadline(
        api<{ id?: string }>(`/properties/${propertyId}/videos/upload-sessions/${sessionId}/complete`, {
          method: "POST",
          body: completePurpose ? { purpose: completePurpose } : undefined,
          expectAgentId,
          // Свой потолок и у самого api(): без него запрос обрывался его
          // обычными 30 с раньше, чем срабатывал потолок сборки выше, — а
          // склейка гигабайтного готового ролика и проверка ffprobe идут
          // дольше (24.09.2026, проверка по классам).
          timeoutMs: COMPLETE_DEADLINE_MS,
        }),
        COMPLETE_DEADLINE_MS
      );
      return { status: 201, error: null, data, videoId: (data as { id?: string } | undefined)?.id };
    } catch (err) {
      // 409 со списком `uploadedPartNumbers` — не отказ, а расхождение состояния:
      // часть, которую мы считали отправленной, до сервера не дошла (или
      // наоборот). Следующий круг узнаёт правду у сервера заново.
      //
      // 409 БЕЗ списка частей — отказ самого приёма (09.10.2026, объект №153):
      // «этот же ролик уже сдан по №154», «нет звука», «это исходник». Сервер к
      // этому моменту сессию уже удалил, поэтому второй круг заводил НОВУЮ сессию
      // и заливал 746 МБ с нуля, получал тот же 409 и возвращал status 0
      // «попробуем ещё раз» — а вызывающий цикл (handleUpload, очередь) повторял
      // всё до десяти раз с нарастающей паузой, держа блок заблокированным.
      // Человек видел «100 % → снова 0 %» и ни разу — причину. Отказ приёма
      // отдаём как есть: 409 с текстом сервера, повторять там нечего.
      if (err instanceof ApiError && err.status === 409 && isPartsMismatch(err.data)) continue;
      return apiErrorToResult(err);
    }
  }

  return { status: 0, error: "Не удалось собрать файл — попробуем ещё раз" };
}

/**
 * Часть, которая дважды подряд отказала status 0 без единого отданного байта
 * (D1, 23.09.2026) — по номеру части и заданию: заводится на первом таком
 * отказе, стирается любым другим исходом (успех, обрыв С прогрессом, другая
 * часть), и решает на втором подряд отказе той же части. Живёт в памяти
 * вкладки — переживать перезагрузку ей незачем: после перезагрузки первый же
 * отказ снова заведёт запись, максимум одна лишняя попытка.
 */
const lastZeroProgressPart = new Map<string, number>();

/** Код ответа 422 здесь не от сервера — синтетическая метка «файл не читается,
 *  дальше пробовать нечем», чтобы run() ниже завершил задание сразу, а не
 *  как обрыв связи (0) или отказ сервера (5xx/429), которые он повторяет. */
const UNREADABLE_PART_STATUS = 422;

// `upload` подменяется только в тесте (WEB-10): внутри модуля иначе не подставить.
export function sendVideoTask(
  task: StoredTask,
  onProgress: (loaded: number, total: number) => void,
  upload: typeof uploadVideoChunked = uploadVideoChunked
): Promise<SendResult> {
  return upload(
    {
      propertyId: task.propertyId,
      file: task.files[0],
      uploadKey: task.uploadKeys[0],
      filename: task.filenames[0],
      purpose: "raw",
      expectAgentId: task.agentId,
    },
    onProgress
  ).then(async (result) => {
    if (result.status === 0 && result.zeroProgress && result.failedPartNumber != null) {
      const prevPart = lastZeroProgressPart.get(task.id);
      if (prevPart === result.failedPartNumber) {
        lastZeroProgressPart.delete(task.id);
        // Два обрыва без байта подряд не доказывают, что файл не читается: так же
        // выглядит обычное отсутствие связи (WEB-10). Нечитаемым объявляем, только
        // если кусок реально не читается; иначе остаётся статус 0, и run() повторит
        // его с паузой, когда связь вернётся.
        if (result.failedPartBlob && !(await isBlobReadable(result.failedPartBlob))) {
          return { ...result, status: UNREADABLE_PART_STATUS, error: unreadableFileMessage(true) };
        }
        return result;
      }
      lastZeroProgressPart.set(task.id, result.failedPartNumber);
    } else {
      lastZeroProgressPart.delete(task.id);
    }
    return result;
  });
}

/**
 * ЗАГРУЗИТЬ ВИДЕО СЕЙЧАС И ДОЖДАТЬСЯ (22.09.2026, «Вернуть монтажёру» с новым
 * исходником). Тот же многочастевый путь, что у очереди (sendVideoTask), но без
 * IndexedDB и фоновых повторов: вызывающему нужен ответ здесь и сейчас — id
 * собранного PropertyVideo, чтобы отправить его в той же форме. Обрыв = честный
 * отказ, и форма не даёт отправить объект без нового исходника.
 */
export async function uploadVideoNow(
  propertyId: string,
  file: File,
  onProgress: (loaded: number, total: number) => void
): Promise<{ ok: true; videoId: string } | { ok: false; error: string }> {
  // purpose="raw": это сырой исходник объекта (PropertyVideo), как обычная
  // загрузка очереди — completePurpose="MONTAJER_SOURCE" лишь отменяет
  // автоматический возврат объекта на проверку (сервер это решает по нему).
  const result = await uploadVideoChunked(
    { propertyId, file, uploadKey: newKey(), filename: file.name, purpose: "raw", completePurpose: "MONTAJER_SOURCE" },
    onProgress
  );
  if (result.status >= 200 && result.status < 300 && result.videoId) return { ok: true, videoId: result.videoId };
  return { ok: false, error: result.error ?? "Загрузка не завершилась — попробуйте ещё раз" };
}

/**
 * Выбор следующего задания из очереди — чистая функция, не трогает
 * хранилище, поэтому тестируется без IndexedDB.
 *
 * Два правила, оба из разбора 17.09.2026:
 *  1. Задание, у которого `nextAttemptAt` ещё не наступил, не берём —
 *     иначе HEARTBEAT_MS (60 с) и событие `online` игнорировали бы
 *     собственный бэкофф задания (5 мин на поздних попытках) и долбили бы
 *     сервер каждую минуту вместо paузы с нарастанием.
 *  2. Среди готовых — сначала задания без единой неудачной попытки: только
 *     что добавленная пачка не должна ждать, пока безуспешно долбится
 *     чужая, зависшая на плохой связи.
 */
export function pickNextPendingTask(
  tasks: StoredTask[],
  now: number = Date.now(),
  /** Чьи задания брать (WEB-02): свои и без автора. Не задан: без отбора по автору. */
  agentId?: string
): StoredTask | undefined {
  const eligible = tasks.filter(
    (t) =>
      t.status === "pending" &&
      (!t.nextAttemptAt || t.nextAttemptAt <= now) &&
      (agentId === undefined || !t.agentId || t.agentId === agentId)
  );
  eligible.sort((a, b) => {
    if (a.attempts === 0 && b.attempts !== 0) return -1;
    if (a.attempts !== 0 && b.attempts === 0) return 1;
    return a.createdAt - b.createdAt;
  });
  return eligible[0];
}

/**
 * Файл, который телефон не даёт прочитать — сказать сразу, а не через 25 минут
 * повторов (D1, 23.09.2026: разбор шести мёртвых сессий 21.09, где браузер
 * отдавал `NotReadableError` на Blob из IndexedDB после перезапуска вкладки, а
 * очередь молча повторяла отправку ~25 минут, прежде чем написать «не ушло»).
 * Читаем первые 64 КБ каждого файла задания — дёшево, но `Blob.slice(...).
 * arrayBuffer()` бросает ровно на том же отказе, что и настоящая отправка,
 * только сразу, а не после начала долгой отдачи.
 */
async function filesReadable(files: Blob[]): Promise<boolean> {
  try {
    for (const file of files) await file.slice(0, 65536).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Подпись объекта для сообщения телеметрии (D2) — тот же формат, что и везде
 *  в интерфейсе (PultActions.tsx, PultCompanySections2026.tsx): «ОБ-000134». */
function propertyLabel(task: StoredTask): string {
  return task.propertyShortId ? `объект ОБ-${String(task.propertyShortId).padStart(6, "0")}` : "объект без номера";
}

let running = false;
let retryTimer: number | null = null;

/** Точки (время, отдано байт) активного задания за последние ~5 с — сбрасываются
 *  при каждой смене активного задания, расчёт скорости — чистой функцией
 *  computeSpeedBps (uploadFormat.ts). */
let activeSamples: ProgressSample[] = [];

/**
 * Один проход очереди. Задания идут строго по одному: параллельная отправка на
 * мобильном интернете делит и без того узкий канал и роняет обе загрузки.
 */
async function run(): Promise<void> {
  if (running) return;
  // Не в сети — ждём события online, а не крутим пустые попытки. Баннеру
  // нужно знать об этом явно (offline), а не догадываться по «отправка не
  // идёт»: именно эта путаница показывала «ждём связи» и при обрыве связи, и
  // при обычном бэкоффе после 500 (найдено 17.09.2026).
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setState({ offline: true });
    return;
  }
  if (state.offline) setState({ offline: false });
  // Некому грузить: вышли из системы. Задания остаются и уйдут после входа.
  if (!useAuthStore.getState().hasSession) return;

  running = true;
  try {
    for (;;) {
      // Сотрудник на этом проходе (WEB-02): берём только его задания и только его
      // токеном. Нет личности (вышел посреди прохода): грузить некому.
      const me = currentAgentId();
      if (!me) return;
      const all = await readAll();
      // Задания без автора (созданы до исправления) достаются тому, кто вошёл.
      for (const t of all) {
        if (!t.agentId) {
          t.agentId = me;
          await put(t);
        }
      }
      const task = pickNextPendingTask(all, Date.now(), me);
      if (!task) return;

      // D1 — файл, который телефон не даёт прочитать: сказать сразу, до
      // начала долгой отдачи, а не через ~25 минут повторов (см. filesReadable).
      if (!(await filesReadable(task.files))) {
        const errorText = unreadableFileMessage(false);
        await put({ ...task, status: "failed", attempts: task.attempts + 1, error: errorText, nextAttemptAt: undefined });
        await refreshTasks();
        reportUploadIssue({
          kind: task.kind,
          name: task.label,
          sizeBytes: task.totalBytes,
          propertyLabel: propertyLabel(task),
          attempts: task.attempts + 1,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          status: 0,
          error: errorText,
          online: typeof navigator !== "undefined" ? navigator.onLine : true,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        });
        continue;
      }

      await put({ ...task, status: "uploading" });
      // Задание пошло в работу — прежний бэкофф (если баннер его показывал)
      // больше не актуален, а новый текст ошибки появится только на новом отказе.
      activeSamples = [];
      setState({ activeId: task.id, activeLoaded: 0, activeTotal: task.totalBytes, activeSpeedBps: null, nextAttemptAt: null, lastError: null });
      await refreshTasks();

      // Скользящая скорость (uploadFormat.ts, ~5с окно) — честная строка
      // задания (UploadTaskRow) читает activeSpeedBps, а не считает сама.
      const onSendProgress = (loaded: number, total: number) => {
        activeSamples.push({ t: Date.now(), loaded });
        setState({ activeId: task.id, activeLoaded: loaded, activeTotal: total, activeSpeedBps: computeSpeedBps(activeSamples) });
      };

      // Сотрудник мог смениться за время await выше (А вышел, вошёл Б): токен Б
      // для задания А не берём, задание ждёт своего автора. Проверка и чтение
      // токена ниже: один синхронный тик.
      const handBack = async () => {
        await put({ ...task, status: "pending" });
        setState({ activeId: null, activeLoaded: 0, activeTotal: 0, activeSpeedBps: null });
        await refreshTasks();
      };
      if (currentAgentId() !== me) {
        await handBack();
        continue;
      }
      let token = useAuthStore.getState().accessToken;
      let result = await sendTask(task, token, onSendProgress);
      if (result.status === 401 && useAuthStore.getState().hasSession) {
        token = await refreshAccessToken();
        if (token) {
          // refresh мог пройти уже под другим аккаунтом: файл А его токеном не шлём.
          if (currentAgentId() !== me) {
            await handBack();
            continue;
          }
          result = await sendTask(task, token, onSendProgress);
        }
      }

      setState({ activeId: null, activeLoaded: 0, activeTotal: 0, activeSpeedBps: null });

      if (result.status >= 200 && result.status < 300) {
        await drop(task.id);
        // Карточка обязана показать появившиеся файлы сама: агент мог уйти на
        // другой экран и вернуться, пока пачка шла.
        // Ролик карточки живёт полями самого объекта (clipVideoStatus/clipVideoUrl),
        // а не отдельным списком — обновлять надо карточку, как и после фотографий.
        // Видео: загрузка при «Ждём видео» двигает объект по конвейеру и меняет
        // `videoCount` карточки, поэтому сбрасывается и карточка, и список (06.10.2026).
        if (task.kind === "video") {
          queryClient.invalidateQueries({ queryKey: ["property-videos", task.propertyId] });
          queryClient.invalidateQueries({ queryKey: ["properties"] });
        }
        queryClient.invalidateQueries({ queryKey: ["property"] });
        await refreshTasks();
        continue;
      }

      /**
       * Что повторяем, а что нет.
       *
       * Обрыв (0), 5xx и 429 — сторона сервера или сети: повторяем с нарастающей
       * паузой. 4xx — сторона файла или прав (не тот формат, лимит объекта, чужая
       * карточка): повтор не изменит ничего, и вечно долбить сервер нельзя.
       * Такое задание останавливается и ЖДЁТ человека, а не исчезает молча.
       */
      const retryable = result.status === 0 || result.status >= 500 || result.status === 429;
      const attempts = task.attempts + 1;
      const giveUp = attempts >= MAX_RETRY_ATTEMPTS;
      const errorText = giveUp
        ? `Не ушло за ${attempts} попыток — файл мог повредиться при сохранении. Уберите и добавьте заново.`
        : result.error ?? (retryable ? "Связь прервалась — попробуем ещё раз" : httpStatusMessage(result.status));
      const delay = retryDelayMs(attempts);
      const nextAttemptAt = retryable && !giveUp ? Date.now() + delay : undefined;
      await put({ ...task, status: retryable && !giveUp ? "pending" : "failed", attempts, error: errorText, nextAttemptAt });
      await refreshTasks();

      // D2 — телеметрия отказов (ErrorLog, source `web`, читает утренний отчёт
      // директора): при каждом переходе в failed и при каждом повторе начиная
      // со 2-й попытки (первая попытка — обычное дело, не сигнал).
      // Ролик — с ПЕРВОЙ попытки (13.10.2026, ОБ-000160): агент с iPhone
      // жаловался на ошибку дозагрузки роликов, а в журнале не нашлось ни
      // строки — первый обрыв не писался, а после него Safari закрыл вкладку,
      // и второй попытки не было. Ролик — штучная отправка, шума не даст.
      if (!retryable || giveUp || attempts >= 2 || task.kind === "video") {
        reportUploadIssue({
          kind: task.kind,
          name: task.label,
          sizeBytes: task.totalBytes,
          propertyLabel: propertyLabel(task),
          attempts,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          status: result.status,
          error: errorText,
          online: typeof navigator !== "undefined" ? navigator.onLine : true,
          partsDone: result.partsDone,
          partsTotal: result.partsTotal,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        });
      }

      if (retryable && !giveUp) {
        // Баннер переиспользует ровно этот текст (UploadTaskRow показывает
        // task.error) — не придумываем для верхней строки отдельную формулировку.
        setState({ nextAttemptAt: nextAttemptAt ?? null, lastError: errorText });
        scheduleRetry(delay);
        return;
      }
      // Задание остановлено окончательно (failed) — бэкофф по нему больше не
      // идёт, баннер должен вернуться к обычному счётчику «не ушло: N».
      setState({ nextAttemptAt: null, lastError: null });
    }
  } catch {
    // Сюда попадают только отказы хранилища. Задания на месте, следующий запуск
    // приложения или появление сети попробуют снова.
  } finally {
    running = false;
  }
}

function scheduleRetry(delay: number) {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void run();
  }, delay);
}

/**
 * Каждую минуту — на случай, если повод разбудить очередь потерялся.
 *
 * Поводов четыре: старт приложения, постановка задания, появление сети и вход в
 * систему. Каждый из них можно не получить: браузер умеет не прислать `online`,
 * а таймер повтора не переживает выгрузку страницы. Пустой обход очереди стоит
 * одного чтения из IndexedDB, а пропущенный повод стоит потерянных фотографий —
 * то есть ровно того, ради чего очередь и написана.
 */
const HEARTBEAT_MS = 60_000;

/** Запуск при старте приложения. Вызывать один раз — из main.tsx. */
export function startUploadQueue() {
  void refreshTasks().then(() => {
    /**
     * Задания, застрявшие в `uploading`, — это прерванные посреди отправки:
     * вкладку закрыли, телефон уснул, браузер выгрузил страницу. Сами они уже
     * никогда не сдвинутся, поэтому возвращаем их в очередь. Дублей это не
     * создаст: ключ отправки у файлов прежний.
     */
    void readAll().then(async (all) => {
      const stuck = all.filter((t) => t.status === "uploading");
      for (const t of stuck) await put({ ...t, status: "pending" });
      if (stuck.length) await refreshTasks();
      void run();
    });
  });

  window.addEventListener("online", () => {
    setState({ offline: false });
    void run();
  });
  // Явный сигнал офлайна — без него баннер узнавал бы об обрыве только
  // косвенно, следующей неудачной попыткой отправки (см. разбор бага 17.09.2026).
  window.addEventListener("offline", () => setState({ offline: true }));

  /**
   * ДЕШЁВЫЙ ПИНОК ОЧЕРЕДИ ПОСЛЕ СВОРАЧИВАНИЯ (D1, 23.09.2026). Телефон не
   * грузит в фоне (вкладка/приложение свёрнуты — сеть у обрыва запросов та же
   * причина), и до HEARTBEAT_MS (минута) очередь могла молчать. `visibilitychange`
   * на «снова видим» и `pageshow` (вкладка восстановлена из bfcache — событие
   * `online`/`visibilitychange` на нём не всегда приходит) зовут run()
   * безусловно: если грузить нечего, run() сам выйдет сразу же.
   */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void run();
  });
  window.addEventListener("pageshow", () => void run());

  /**
   * ВХОД В СИСТЕМУ — обязательный повод, а не украшение.
   *
   * При старте приложения сессии обычно ещё нет: экран входа открывается раньше,
   * чем восстанавливается токен. run() в этот момент выходит сразу и НЕ ставит
   * таймер повтора — ставить его некому и незачем. Без подписки ниже задания
   * лежали бы в хранилище до следующего запуска приложения, хотя человек уже
   * вошёл и сеть на месте. Поймано живой проверкой 15.08.2026: файлы пережили
   * перезагрузку, дождались сервера — и не двинулись.
   */
  useAuthStore.subscribe((state, prev) => {
    // Другой сотрудник: список на экране у каждого свой (WEB-02), и очередь
    // просыпается под него.
    if (state.agent?.id !== prev.agent?.id) void refreshTasks();
    if ((state.hasSession && !prev.hasSession) || state.agent?.id !== prev.agent?.id) void run();
  });

  window.setInterval(() => void run(), HEARTBEAT_MS);

  // Очередь карточки в реестре работы (lib/workGuard.ts): пока есть задания, не
  // упавшие насовсем, автообновление и автовыход не перезагружают страницу.
  // Закрытие вкладки не блокируем — задания лежат в IndexedDB и доедут сами.
  let unregisterWork: (() => void) | null = null;
  subscribe(() => {
    const active = state.tasks.some((t) => t.status !== "failed");
    if (active && !unregisterWork) {
      unregisterWork = registerWork({ id: "upload-queue", label: "Загрузка файлов объекта", blocksUnload: false, resume: () => void run() });
    } else if (!active && unregisterWork) {
      unregisterWork();
      unregisterWork = null;
    }
  });
}
