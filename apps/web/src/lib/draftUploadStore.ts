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

const DB_NAME = "royal-home-draft-media";
const STORE = "files";
const DB_VERSION = 1;

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
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "uploadKey" });
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

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Ошибка хранилища черновика"));
      })
  );
}

/**
 * Положить файл. Вызывающая сторона решает, класть ли (видео тяжелее
 * MAX_STORED_VIDEO_BYTES сюда не отдаёт вовсе) — здесь только защита от
 * невнимательного вызова.
 */
export async function putDraftFile(rec: StoredDraftFile): Promise<void> {
  if (rec.kind === "video" && rec.size > MAX_STORED_VIDEO_BYTES) return;
  await tx("readwrite", (s) => s.put({ ...rec, savedAt: rec.savedAt ?? Date.now() }) as IDBRequest<IDBValidKey>);
}

export async function deleteDraftFile(uploadKey: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(uploadKey) as unknown as IDBRequest<undefined>);
}

/**
 * Продлить срок локальных файлов: черновик на сервере только что сохранился, значит он жив,
 * и срок (4 ч) считается от ЭТОГО сохранения, а не от момента, когда файл положили.
 * Без этого при плохой связи на объекте неотправленные фото молча стирались бы через 4 ч
 * от добавления, хотя сам черновик жив. Трогаем файлы этого агента из этого черновика и
 * ещё не привязанные к черновику.
 */
export async function touchDraftFiles(agentId: string, draftId: string | null, now: number = Date.now()): Promise<void> {
  const all = await tx<StoredDraftFile[]>("readonly", (s) => s.getAll() as IDBRequest<StoredDraftFile[]>);
  for (const f of all) {
    if (f.agentId !== agentId) continue;
    if (f.draftId != null && f.draftId !== draftId) continue;
    await tx("readwrite", (s) => s.put({ ...f, savedAt: now }) as IDBRequest<IDBValidKey>).catch(() => undefined);
  }
}

/** Всё, что лежит в хранилище для этого агента — остальное (чужой агент на
 *  том же устройстве) не возвращаем. */
export async function readAllDraftFiles(agentId: string, now: number = Date.now()): Promise<StoredDraftFile[]> {
  const all = await tx<StoredDraftFile[]>("readonly", (s) => s.getAll() as IDBRequest<StoredDraftFile[]>);
  const own = all.filter((f) => f.agentId === agentId);
  // Срок жизни локальной копии — тот же, что у черновика на сервере
  // (PROPERTY_DRAFT_TTL_MS): сервер такой черновик уже стёр, и без этой
  // уборки файлы лежали бы в браузере вечно, а «Продолжить черновик» висел бы
  // в каталоге объектов (22.11.2026, владелец: «черновик висит вечно»).
  const ttlMs = PROPERTY_DRAFT_TTL_MS;
  const live: StoredDraftFile[] = [];
  for (const f of own) {
    if (typeof f.savedAt !== "number") {
      const stamped = { ...f, savedAt: now };
      await tx("readwrite", (s) => s.put(stamped) as IDBRequest<IDBValidKey>).catch(() => undefined);
      live.push(stamped);
    } else if (now - f.savedAt > ttlMs) {
      await deleteDraftFile(f.uploadKey).catch(() => undefined);
    } else {
      live.push(f);
    }
  }
  return live;
}

/** Clear one actor and one draft generation. A shared browser may still contain
 * another employee's offline files, or recoverable files from an older draft. */
export async function clearAllDraftFiles(agentId: string, draftId: string | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const cursorRequest = transaction.objectStore(STORE).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const record = cursor.value as StoredDraftFile;
      if (record.agentId === agentId && (record.draftId ?? null) === draftId) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Не удалось удалить локальные файлы черновика"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Удаление локальных файлов прервано"));
  });
}
