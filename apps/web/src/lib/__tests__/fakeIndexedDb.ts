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
  };

  function request<T>(): Req<T> {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }

  function makeDb(db: DbData) {
    return {
      objectStoreNames: { contains: (n: string) => db.stores.has(n) },
      createObjectStore(n: string, opts?: { keyPath?: string }) {
        db.stores.set(n, { keyPath: opts?.keyPath, data: new Map() });
        return {};
      },
      transaction(names: string | string[], _mode?: string) {
        return makeTx(db, Array.isArray(names) ? names : [names]);
      },
      close() {},
    };
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
    const req = request<unknown>() as Req<unknown> & { onupgradeneeded: ((e: { oldVersion: number }) => void) | null };
    req.onupgradeneeded = null;
    queueMicrotask(() => {
      let db = dbs.get(name);
      const old = db?.version ?? 0;
      if (!db) {
        db = { version: 0, stores: new Map() };
        dbs.set(name, db);
      }
      req.result = makeDb(db);
      if (version > old) {
        db.version = version;
        req.onupgradeneeded?.({ oldVersion: old });
      }
      req.onsuccess?.();
    });
    return req;
  }

  return fake;
}
