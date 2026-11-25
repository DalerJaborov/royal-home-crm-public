/**
 * IndexedDB-склад ещё НЕ отправленных файлов черновика мастера — переживает
 * перезагрузку вкладки (21.09.2026, жалоба владельца: «агент добавил 15-20
 * фото — сервер сбросился, всё потерялось»; при разборе выяснилось, что
 * очередь `draftUploads.ts` жила только в памяти модуля — закрыл вкладку до
 * того, как файл ушёл, и он пропадал молча).
 *
 * ОТДЕЛЬНАЯ БАЗА ОТ `lib/uploadQueue.ts`, А НЕ ОБЩАЯ. Та хранит ЗАДАНИЯ на
 * уже существующий объект — ключ записи там id задания, само задание может
 * нести пачку из нескольких файлов, и обязательное поле `propertyId`. Здесь
 * же черновик БЕЗ id объекта, а ключ — `uploadKey` ОДНОГО файла (тот же
 * ключ, которым сервер отличает повтор от новой отправки, см.
 * `apps/api/src/routes/properties/drafts.ts`). Пытаться натянуть чужую
 * форму данных на другую сущность стоило бы условных веток в горячем модуле
 * ради экономии одного `indexedDB.open()`.
 *
 * ФАЙЛ КЛАДЁТСЯ ОДИН РАЗ, ОТМЕТКИ — ОТДЕЛЬНО (версия 2, 25.11.2026, находка 2).
 * Раньше запись была одна — метаданные вместе с блобом, и каждое продление срока
 * (`touchDraftFiles`), отметка старой записи и привязка к черновику перекладывали
 * её целиком. В Chromium каждая такая запись копирует блоб заново: ролик 271 МБ
 * на каждое движение отметки — квота кончалась, и браузер отказывал записи
 * («Error preparing Blob/File data…»), а затем и чтению. Теперь:
 *  - `files` — только метаданные (ключ uploadKey);
 *  - `blobs` — сам файл по тому же ключу, пишется один раз.
 * Записи прежней версии (блоб внутри `files`) читаются как есть, а при первой же
 * правке отметки файл переезжает в `blobs` — один раз, без потери незавершённых.
 */

import { PROPERTY_DRAFT_TTL_MS } from "@royal-home/shared";

export interface StoredDraftFile {
  uploadKey: string;
  kind: "photo" | "video";
  name: string;
  size: number;
  /** Чужого агента (общий браузер/устройство) не подхватываем при чтении. */
  agentId: string;
  /** Absent only for files stored by a build before draft session identities. */
  draftId?: string | null;
  blob: Blob;
  /** Когда файл положили (мс). Без метки — запись старой сборки: при чтении ей
   *  ставят «сейчас», и срок жизни считается с этого дня. */
  savedAt?: number;
}

/** Метаданные без файла (версия 2). У записей версии 1 `blob` ещё лежит внутри. */
type DraftFileMeta = Omit<StoredDraftFile, "blob"> & { blob?: Blob };

const DB_NAME = "royal-home-draft-media";
const STORE = "files";
const BLOBS = "blobs";
const DB_VERSION = 2;

/**
 * Ролик тяжелее — не храним вовсе (задание, пункт 3). IndexedDB на слабом
 * телефоне и в приватном режиме не резиновая, а положить в неё несколько
 * гигабайт видео ради одного обрыва вкладки стоит дороже, чем находка:
 * агенту придётся выбрать ролик заново, зато квота не забита для всех
 * остальных файлов черновика.
 */
export const MAX_STORED_VIDEO_BYTES = 300 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB недоступна"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // Обновление 1 → 2 только заводит хранилище файлов: данные не переносим здесь,
      // чтобы отказ квоты посреди переноса не оборвал обновление базы целиком.
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "uploadKey" });
        if (!req.result.objectStoreNames.contains(BLOBS)) req.result.createObjectStore(BLOBS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB недоступна"));
    });
    // Неудачную попытку не запоминаем: приватный режим или запрет хранилища —
    // состояние временное (тот же приём, что и в lib/uploadQueue.ts).
    void attempt.catch(() => {
      if (dbPromise === attempt) dbPromise = null;
    });
    dbPromise = attempt;
  }
  return dbPromise;
}

/** Транзакция по нескольким хранилищам; обещание — по её завершению (или отказу целиком). */
function txRun<T>(stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => () => T): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(stores, mode);
        let result: () => T = () => undefined as T;
        transaction.oncomplete = () => resolve(result());
        transaction.onerror = () => reject(transaction.error ?? new Error("Ошибка хранилища черновика"));
        // Chromium отказывает записи блоба обрывом транзакции, а не ошибкой запроса.
        transaction.onabort = () => reject(transaction.error ?? new Error("Ошибка хранилища черновика"));
        result = body(transaction);
      })
  );
}

function metaOf(rec: StoredDraftFile | DraftFileMeta): DraftFileMeta {
  const { blob: _blob, ...meta } = rec as StoredDraftFile;
  return meta;
}

/**
 * Положить файл. Вызывающая сторона решает, класть ли (видео тяжелее
 * MAX_STORED_VIDEO_BYTES сюда не отдаёт вовсе) — здесь только защита от
 * невнимательного вызова. Файл и метаданные — одной транзакцией.
 */
export async function putDraftFile(rec: StoredDraftFile): Promise<void> {
  if (rec.kind === "video" && rec.size > MAX_STORED_VIDEO_BYTES) return;
  await txRun([STORE, BLOBS], "readwrite", (t) => {
    t.objectStore(BLOBS).put(rec.blob, rec.uploadKey);
    t.objectStore(STORE).put({ ...metaOf(rec), savedAt: rec.savedAt ?? Date.now() });
    return () => undefined;
  });
}

/**
 * Поправить метаданные (срок, черновик), НЕ перекладывая файл. Запись прежней версии
 * (файл внутри) при этом один раз переезжает: файл — в `blobs`, метаданные — без него.
 * Записи нет — ничего не делаем.
 */
export async function updateDraftFileMeta(uploadKey: string, patch: Partial<Pick<StoredDraftFile, "savedAt" | "draftId">>): Promise<void> {
  await txRun([STORE, BLOBS], "readwrite", (t) => {
    const files = t.objectStore(STORE);
    const req = files.get(uploadKey);
    req.onsuccess = () => {
      const rec = req.result as DraftFileMeta | undefined;
      if (!rec) return;
      if (rec.blob) t.objectStore(BLOBS).put(rec.blob, uploadKey);
      files.put({ ...metaOf(rec), ...patch });
    };
    return () => undefined;
  });
}

export async function deleteDraftFile(uploadKey: string): Promise<void> {
  await txRun([STORE, BLOBS], "readwrite", (t) => {
    t.objectStore(STORE).delete(uploadKey);
    t.objectStore(BLOBS).delete(uploadKey);
    return () => undefined;
  });
}

/** Все метаданные и файлы: метаданные целиком, файлы — по ключу (блоб из базы — ссылка, не копия). */
async function readEverything(): Promise<{ metas: DraftFileMeta[]; blobs: Map<string, Blob> }> {
  return txRun([STORE, BLOBS], "readonly", (t) => {
    let metas: DraftFileMeta[] = [];
    const blobs = new Map<string, Blob>();
    const all = t.objectStore(STORE).getAll();
    all.onsuccess = () => {
      metas = (all.result as DraftFileMeta[]) ?? [];
    };
    const cursor = t.objectStore(BLOBS).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      blobs.set(String(c.key), c.value as Blob);
      c.continue();
    };
    return () => ({ metas, blobs });
  });
}

/**
 * Продлить срок локальных файлов: черновик на сервере только что сохранился, значит он жив,
 * и срок (4 ч) считается от ЭТОГО сохранения, а не от момента, когда файл положили.
 * Без этого при плохой связи на объекте неотправленные фото молча стирались бы через 4 ч
 * от добавления, хотя сам черновик жив. Трогаем файлы этого агента из этого черновика и
 * ещё не привязанные к черновику. Только метаданные — файл не перекладывается.
 */
export async function touchDraftFiles(agentId: string, draftId: string | null, now: number = Date.now()): Promise<void> {
  const { metas } = await readEverything();
  for (const f of metas) {
    if (f.agentId !== agentId) continue;
    if (f.draftId != null && f.draftId !== draftId) continue;
    await updateDraftFileMeta(f.uploadKey, { savedAt: now }).catch(() => undefined);
  }
}

/** Всё, что лежит в хранилище для этого агента — остальное (чужой агент на
 *  том же устройстве) не возвращаем. */
export async function readAllDraftFiles(agentId: string, now: number = Date.now()): Promise<StoredDraftFile[]> {
  const { metas, blobs } = await readEverything();
  const own = metas.filter((f) => f.agentId === agentId);
  // Срок жизни локальной копии — тот же, что у черновика на сервере
  // (PROPERTY_DRAFT_TTL_MS): сервер такой черновик уже стёр, и без этой
  // уборки файлы лежали бы в браузере вечно, а «Продолжить черновик» висел бы
  // в каталоге объектов (22.11.2026, владелец: «черновик висит вечно»).
  const ttlMs = PROPERTY_DRAFT_TTL_MS;
  const live: StoredDraftFile[] = [];
  for (const f of own) {
    const blob = f.blob ?? blobs.get(f.uploadKey);
    if (!blob) {
      // Метаданные без файла (запись файла не удалась) — докачивать нечем.
      await deleteDraftFile(f.uploadKey).catch(() => undefined);
      continue;
    }
    if (typeof f.savedAt !== "number") {
      await updateDraftFileMeta(f.uploadKey, { savedAt: now }).catch(() => undefined);
      live.push({ ...metaOf(f), blob, savedAt: now });
    } else if (now - f.savedAt > ttlMs) {
      await deleteDraftFile(f.uploadKey).catch(() => undefined);
    } else {
      live.push({ ...metaOf(f), blob });
    }
  }
  return live;
}

/** Clear one actor and one draft generation. A shared browser may still contain
 * another employee's offline files, or recoverable files from an older draft. */
export async function clearAllDraftFiles(agentId: string, draftId: string | null): Promise<void> {
  await txRun([STORE, BLOBS], "readwrite", (t) => {
    const blobs = t.objectStore(BLOBS);
    const cursorRequest = t.objectStore(STORE).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const record = cursor.value as DraftFileMeta;
      if (record.agentId === agentId && (record.draftId ?? null) === draftId) {
        cursor.delete();
        blobs.delete(record.uploadKey);
      }
      cursor.continue();
    };
    return () => undefined;
  });
}
