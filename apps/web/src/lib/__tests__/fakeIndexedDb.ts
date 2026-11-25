/**
 * Маленький IndexedDB для тестов (в окружении node его нет, а пакета fake-indexeddb в проекте
 * нет). Умеет ровно то, чем пользуются склады загрузок: версии и onupgradeneeded, несколько
 * хранилищ, транзакции по нескольким хранилищам с фиксацией по завершении и откатом при
 * обрыве, get/getAll/put/delete/openCursor. Отказ записи (квота, «Error preparing Blob»)
 * задаётся `failPut` — транзакция обрывается целиком, как в Chromium.
 */

type Key = string | number;

interface StoreData {
  keyPath?: string;
  data: Map<Key, unknown>;
}

interface DbData {
  version: number;
  stores: Map<string, StoreData>;
}

interface Req<T> {
  result: T | undefined;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

export interface FakeIdb {
  indexedDB: { open(name: string, version?: number): unknown };
  /** Содержимое хранилища (после фиксации), для проверок. */
  dump(db: string, store: string): Map<Key, unknown>;
  /** Положить запись напрямую — как будто её оставила прежняя сборка. */
  seed(db: string, version: number, stores: Record<string, { keyPath?: string; rows: Array<[Key, unknown]> }>): void;
  /** Отказ записи: вернуть true — транзакция обрывается (квота). */
  failPut: ((store: string, value: unknown) => boolean) | null;
  /** Сколько раз писали в хранилище (для проверки «файл кладётся один раз»). */
  putCount: Map<string, number>;
  /**
   * Открыть базу «из другой вкладки» старой версии и НЕ закрывать её по `versionchange`:
   * следующее открытие с большей версией получит `onblocked`, как в настоящих браузерах.
   * Возвращает функцию «закрыть вкладку» — после неё отложенное открытие дойдёт до конца.
   */
  holdOpen(name: string, onversionchange?: () => void): () => void;
  /** Вызывается при создании КАЖДОЙ транзакции — до того, как она увидит данные: чужая правка «между». */
  onTx: ((mode: string, stores: string[]) => void) | null;
  /** Поменять данные хранилища напрямую (как будто это сделала другая транзакция). */
  mutate(db: string, store: string, fn: (rows: Map<Key, unknown>) => void): void;
  /** Сколько соединений с базой открыто сейчас. */
  openConnections(name: string): number;
}

const sortKeys = (keys: Key[]) => [...keys].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));

export function createFakeIndexedDb(): FakeIdb {
  const dbs = new Map<string, DbData>();
  const fake: FakeIdb = {
    indexedDB: { open },
    dump: (db, store) => new Map(dbs.get(db)?.stores.get(store)?.data ?? []),
    seed(db, version, stores) {
      const d: DbData = { version, stores: new Map() };
      for (const [name, s] of Object.entries(stores)) d.stores.set(name, { keyPath: s.keyPath, data: new Map(s.rows) });
      dbs.set(db, d);
    },
    failPut: null,
    putCount: new Map(),
    holdOpen(name, onversionchange) {
      const db = dbs.get(name) ?? { version: 1, stores: new Map() };
      dbs.set(name, db);
      const conn = { onversionchange: (onversionchange ? () => onversionchange() : null) as (() => void) | null, closed: false, close() {} };
      conns.get(db)?.add(conn) ?? conns.set(db, new Set([conn]));
      return () => closeConn(db, conn);
    },
    onTx: null,
    mutate(db, store, fn) {
      fn(dbs.get(db)!.stores.get(store)!.data);
    },
    openConnections: (name) => (dbs.get(name) ? [...(conns.get(dbs.get(name)!) ?? [])].filter((c) => !c.closed).length : 0),
  };

  interface Conn {
    onversionchange: (() => void) | null;
    closed: boolean;
    close(): void;
  }
  const conns = new Map<DbData, Set<Conn>>();
  const waiting = new Map<DbData, Array<() => void>>();
  function closeConn(db: DbData, c: Conn) {
    c.closed = true;
    if ([...(conns.get(db) ?? [])].every((x) => x.closed)) {
      const w = waiting.get(db) ?? [];
      waiting.set(db, []);
      w.forEach((fn) => fn());
    }
  }

  function request<T>(): Req<T> {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }

  function makeDb(db: DbData) {
    const conn: Conn = { onversionchange: null, closed: false, close: () => closeConn(db, conn) };
    (conns.get(db) ?? conns.set(db, new Set()).get(db)!).add(conn);
    const api = {
      get onversionchange() {
        return conn.onversionchange;
      },
      set onversionchange(fn: (() => void) | null) {
        conn.onversionchange = fn;
      },
      objectStoreNames: { contains: (n: string) => db.stores.has(n) },
      createObjectStore(n: string, opts?: { keyPath?: string }) {
        db.stores.set(n, { keyPath: opts?.keyPath, data: new Map() });
        return {};
      },
      transaction(names: string | string[], mode?: string) {
        fake.onTx?.(mode ?? "readonly", Array.isArray(names) ? names : [names]);
        return makeTx(db, Array.isArray(names) ? names : [names]);
      },
      close: () => conn.close(),
    };
    return api;
  }

  function makeTx(db: DbData, names: string[]) {
    const staged = new Map<string, Map<Key, unknown>>();
    for (const n of names) {
      const s = db.stores.get(n);
      if (!s) throw Object.assign(new Error(`нет хранилища ${n}`), { name: "NotFoundError" });
      staged.set(n, new Map(s.data));
    }
    let pending = 0;
    let finished = false;
    const tx = {
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: (n: string) => storeApi(n),
    };
    const check = () => {
      queueMicrotask(() => {
        if (finished || pending > 0) return;
        finished = true;
        for (const [n, data] of staged) db.stores.get(n)!.data = data;
        tx.oncomplete?.();
      });
    };
    const abort = (err: unknown) => {
      if (finished) return;
      finished = true;
      tx.error = err;
      queueMicrotask(() => tx.onabort?.());
    };
    function run<T>(action: () => T): Req<T> {
      const req = request<T>();
      pending++;
      queueMicrotask(() => {
        if (finished) return;
        try {
          req.result = action();
          req.onsuccess?.();
        } catch (err) {
          req.error = err;
          req.onerror?.();
          abort(err);
        }
        pending--;
        check();
      });
      return req;
    }
    function storeApi(n: string) {
      const keyPath = db.stores.get(n)?.keyPath;
      const data = () => staged.get(n)!;
      return {
        get: (key: Key) => run(() => data().get(key)),
        getAll: () => run(() => sortKeys([...data().keys()]).map((k) => data().get(k))),
        put: (value: unknown, key?: Key) =>
          run(() => {
            if (fake.failPut?.(n, value)) throw Object.assign(new Error("Error preparing Blob/File data to be stored in object store"), { name: "UnknownError" });
            const k = keyPath ? ((value as Record<string, Key>)[keyPath] as Key) : (key as Key);
            fake.putCount.set(n, (fake.putCount.get(n) ?? 0) + 1);
            data().set(k, value);
            return k;
          }),
        delete: (key: Key) =>
          run(() => {
            data().delete(key);
            return undefined;
          }),
        openCursor: () => {
          const keys = sortKeys([...data().keys()]);
          let i = 0;
          const req = request<unknown>();
          const step = () =>
            run(() => {
              const key = keys[i++];
              req.result =
                key === undefined
                  ? null
                  : {
                      key,
                      value: data().get(key),
                      continue: () => void step(),
                      delete: () => run(() => void data().delete(key)),
                    };
              req.onsuccess?.();
              return undefined;
            });
          step();
          return req;
        },
      };
    }
    return tx;
  }

  function open(name: string, version = 1) {
    const req = request<unknown>() as Req<unknown> & {
      onupgradeneeded: ((e: { oldVersion: number }) => void) | null;
      onblocked: (() => void) | null;
    };
    req.onupgradeneeded = null;
    req.onblocked = null;
    queueMicrotask(() => {
      let db = dbs.get(name);
      const old = db?.version ?? 0;
      if (!db) {
        db = { version: 0, stores: new Map() };
        dbs.set(name, db);
      }
      const target = db;
      const proceed = () => {
        req.result = makeDb(target);
        if (version > old) {
          target.version = version;
          req.onupgradeneeded?.({ oldVersion: old });
        }
        req.onsuccess?.();
      };
      if (version > old) {
        // Повышение версии: открытые соединения получают `versionchange`; кто не закрылся — блокирует.
        const open = [...(conns.get(target) ?? [])].filter((c) => !c.closed);
        for (const c of open) c.onversionchange?.();
        if ([...(conns.get(target) ?? [])].some((c) => !c.closed)) {
          req.onblocked?.();
          waiting.set(target, [...(waiting.get(target) ?? []), proceed]);
          return;
        }
      }
      proceed();
    });
    return req;
  }

  return fake;
}
