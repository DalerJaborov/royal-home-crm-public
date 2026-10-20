import type { QueryKey } from "@tanstack/react-query";
import { queryClient } from "./queryClient";

/**
 * Свой персистер кэша React Query (perf/web-instant-11-09) — react-query-persist-client
 * НЕ установлен, npm install запрещён (общий node_modules воркспейса).
 * Снимок успешных ответов по белому списку экранов лежит в IndexedDB (fallback —
 * localStorage). main.tsx восстанавливает его ДО первого рендера: экран открывается
 * со старыми данными, а staleTime=0 по умолчанию сам уводит React Query за свежими.
 *
 * ТЕЛЕФОНЫ КЛИЕНТОВ (проверено по заданию): GET /clients отдаёт `phone` в открытом
 * виде агентам с правом clients.viewPhone (presentClient, apps/api/src/routes/
 * clients/{shared,list}.ts) — список МОЖЕТ нести настоящий номер, не маску. Список
 * не исключён из белого списка целиком (руководителю мгновенное открытие нужно там
 * же), а поле `phone` вырезается перед записью на диск (см. redact).
 */

const DB_NAME = "royal-home-query-cache";
const STORE = "snapshots";
const KEY = "v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const SIZE_LIMIT = 2 * 1024 * 1024; // 2 МБ — общий предел на весь снимок
// Profile/preferences must come from a fresh /me, including an immediate reload
// before this persister's debounce/IndexedDB write can finish.
const WHITELIST = ["mission-control", "mission-control-ticker", "clients", "conversations", "properties"];
const LS_KEY = "royal-home-query-cache-v1";

interface Entry {
  key: QueryKey;
  data: unknown;
  dataUpdatedAt: number;
}
interface Snapshot {
  userId: string;
  permissions?: string;
  savedAt: number;
  /**
   * Версия сборки, при которой снимок записан (ночная проверка 24.09.2026, P2).
   * Тот же источник, что у sw.ts/UpdatePrompt.tsx/appUpdate.ts — `__APP_VERSION__`
   * из vite.config.ts (define). Без этого поля снимок старой формы ответа
   * подставлялся в кэш новой версии экрана до первого её собственного рефетча —
   * ровно то, что для api-cache воркера уже чинили 17.09.2026 (sw.ts:97-125,
   * коммит 32ea9a71b). См. buildVersion() и проверку в restoreQueryCache.
   */
  build: string;
  entries: Entry[];
}

/**
 * `typeof`, а не прямое обращение: в тестах (vitest, свой vitest.config.ts без
 * `define`) `__APP_VERSION__` не подставляется esbuild'ом и остаётся неразрешённым
 * идентификатором — прямое чтение бросило бы ReferenceError на каждом вызове
 * save()/restoreQueryCache(). `typeof` на неопределённый идентификатор такого
 * исключения не даёт (единственное такое место в языке) и мирно даёт "undefined".
 */
export function buildVersion(): string {
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";
}

function redact(key: QueryKey, data: unknown): unknown {
  if (key[0] !== "clients" || !data || typeof data !== "object") return data;
  const strip = (c: unknown) => (c && typeof c === "object" ? { ...c, phone: undefined } : c);
  const items = (data as { items?: unknown[] }).items;
  return Array.isArray(items) ? { ...data, items: items.map(strip) } : data;
}

function currentUserId(): string | null {
  try {
    const raw = localStorage.getItem("royal-home-auth");
    return raw ? JSON.parse(raw)?.state?.agent?.id ?? null : null;
  } catch {
    return null;
  }
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return reqToPromise(req);
}

async function idbRead(): Promise<Snapshot | null> {
  try {
    const db = await openDb();
    const r = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(KEY));
    return (r as Snapshot) ?? null;
  } catch {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  }
}

async function idbWrite(snap: Snapshot): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(snap, KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(snap));
    } catch {
      /* квота кончилась — снимок теряется, не критично */
    }
  }
}

/** store/auth.ts вызывает при входе другим пользователем и при выходе. */
export async function clearPersistedQueryCache(): Promise<void> {
  pendingSnapshot = null;
  lastPermissions = undefined;
  if (saveTimer) clearTimeout(saveTimer);
  try {
    const db = await openDb();
    db.transaction(STORE, "readwrite").objectStore(STORE).clear();
  } catch {
    /* IndexedDB недоступна — ниже чистим localStorage */
  }
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* нет доступа к localStorage */
  }
}

/** main.tsx вызывает и ждёт ДО первого рендера. */
export async function restoreQueryCache(): Promise<void> {
  const userId = currentUserId();
  if (!userId) return;
  const snap = await idbRead();
  if (!snap || snap.userId !== userId) return;
  // Снимок с другой сборки (или записанный до этой правки — build там пустой)
  // несёт данные в форме, которую новый код мог ещё не научиться читать —
  // не подставляем и стираем, следующее сохранение запишет актуальный build.
  if (snap.build !== buildVersion()) {
    await clearPersistedQueryCache();
    return;
  }
  pendingSnapshot = snap;
  // No private data is hydrated until the current session gets a fresh /me.
  // A matching user/build does not imply that their permissions are unchanged.
}

let pendingSnapshot: Snapshot | null = null;
let lastPermissions: string | undefined;
function permissionFingerprint(profile: unknown): string | undefined {
  if (!profile || typeof profile !== "object" || !("permissions" in profile) || !Array.isArray(profile.permissions)) return undefined;
  return JSON.stringify(["role" in profile ? profile.role : null, [...profile.permissions].sort()]);
}
function acceptCurrentPermissions(profile: unknown) {
  if (!profile || typeof profile !== "object" || !("id" in profile) || profile.id !== currentUserId()) return;
  const fingerprint = permissionFingerprint(profile);
  if (!fingerprint) return;
  if (lastPermissions && fingerprint !== lastPermissions) {
    queryClient.removeQueries({ predicate: (query) => WHITELIST.includes(String(query.queryKey[0])) });
    void clearPersistedQueryCache();
  }
  lastPermissions = fingerprint;
  const snap = pendingSnapshot;
  pendingSnapshot = null;
  if (!snap || snap.userId !== currentUserId() || snap.permissions !== fingerprint) return;
  const now = Date.now();
  for (const e of snap.entries) {
    // Old snapshots still include /me. Never let them hydrate stale preferences
    // or permissions and suppress the current profile's first network fetch.
    if (!WHITELIST.includes(String(e.key[0])) || queryClient.getQueryData(e.key) !== undefined) continue;
    if (now - e.dataUpdatedAt <= TTL_MS) queryClient.setQueryData(e.key, e.data, { updatedAt: e.dataUpdatedAt });
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1_000);
}

function save(): void {
  const userId = currentUserId();
  if (!userId) return;
  let entries = queryClient
    .getQueryCache()
    .getAll()
    .filter((q) => q.state.status === "success" && typeof q.queryKey[0] === "string" && WHITELIST.includes(q.queryKey[0] as string))
    .map((q) => ({ key: q.queryKey, data: redact(q.queryKey, q.state.data), dataUpdatedAt: q.state.dataUpdatedAt }));
  entries.sort((a, b) => b.dataUpdatedAt - a.dataUpdatedAt);
  const build = buildVersion();
  const permissions = permissionFingerprint(queryClient.getQueryData(["me"]));
  if (!permissions) return;
  let json = JSON.stringify({ userId, savedAt: Date.now(), build, permissions, entries });
  while (json.length > SIZE_LIMIT && entries.length > 1) {
    entries = entries.slice(0, -1); // старые ключи выбрасываем первыми
    json = JSON.stringify({ userId, savedAt: Date.now(), build, permissions, entries });
  }
  if (entries.length > 0) void idbWrite(JSON.parse(json) as Snapshot);
}

// Живёт с момента импорта модуля (main.tsx импортирует его ради restoreQueryCache).
// "updated" со статусом success покрывает первый fetch и рефетчи по интервалу/фокусу.
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.query.state.status !== "success") return;
  const first = event.query.queryKey[0];
  if (first === "me" && event.query.queryKey.length === 1) acceptCurrentPermissions(event.query.state.data);
  if (typeof first === "string" && WHITELIST.includes(first)) scheduleSave();
});
