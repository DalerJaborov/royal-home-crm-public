/** Share each import promise between intent warming and the actual lazy route. */
export function memoizedChunk<T>(importer: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      const attempt = Promise.resolve().then(importer);
      pending = attempt;
      void attempt.catch(() => { if (pending === attempt) pending = undefined; });
    }
    return pending;
  };
}

export const loadCleanPult = memoizedChunk(() => import("../pages/PultClean").then((m) => ({ default: m.PultClean })));
export const loadCleanClients = memoizedChunk(() => import("../pages/Clients").then((m) => ({ default: m.Clients })));
export const loadCleanMessages = memoizedChunk(() => import("../pages/Messages").then((m) => ({ default: m.Messages })));
export const loadCleanProperties = memoizedChunk(() => import("../pages/Properties").then((m) => ({ default: m.Properties })));
export const loadCleanDeals = memoizedChunk(() => import("../pages/Deals").then((m) => ({ default: m.Deals })));
export const loadCleanFinance = memoizedChunk(() => import("../pages/Finance").then((m) => ({ default: m.Finance })));

// This maps code chunks only. The caller supplies permission-filtered registry paths.
const CHUNKS: Readonly<Record<string, () => Promise<unknown>>> = {
  "/clients": loadCleanClients, "/messages": loadCleanMessages,
  "/properties": loadCleanProperties, "/deals": loadCleanDeals, "/finance": loadCleanFinance,
};

/** No page mounting, data requests, or route navigation. Failures belong to lazyWithReload on navigation. */
export async function warmCleanRouteChunk(path: string): Promise<boolean> {
  const load = Object.prototype.hasOwnProperty.call(CHUNKS, path) ? CHUNKS[path] : undefined;
  if (!load) return false;
  await load();
  return true;
}

export interface WarmConnection { saveData?: boolean; effectiveType?: string }
export function permitsCleanChunkWarming(connection?: WarmConnection): boolean {
  return !connection?.saveData && !["slow-2g", "2g", "3g"].includes(connection?.effectiveType ?? "");
}

interface IdleWarmOptions {
  /** Recheck current account/layout eligibility before every import. */
  isActive?: () => boolean;
  canWarm?: () => boolean;
  warm?: (path: string) => Promise<unknown>;
  requestIdle?: (run: () => void) => () => void;
  onError?: (error: unknown, path: string) => void;
}

function browserIdle(run: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run);
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 0);
  return () => window.clearTimeout(id);
}

function browserCanWarm(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: WarmConnection }).connection;
  return navigator.onLine !== false && permitsCleanChunkWarming(connection);
}

/** One code chunk per idle slot, sequentially. Cancellation cannot abort an import already in flight. */
export function scheduleCleanRouteChunks(paths: readonly string[], options: IdleWarmOptions = {}): () => void {
  const queue = [...new Set(paths)].filter((path) => Object.prototype.hasOwnProperty.call(CHUNKS, path));
  const idle = options.requestIdle ?? browserIdle;
  const canWarm = options.canWarm ?? browserCanWarm;
  const warm = options.warm ?? warmCleanRouteChunk;
  let cancelled = false;
  let cancelIdle: (() => void) | undefined;
  const active = () => !cancelled && (options.isActive?.() ?? true) && canWarm();
  const next = () => {
    if (!queue.length || !active()) return;
    cancelIdle = idle(() => {
      cancelIdle = undefined;
      if (!active()) return;
      const path = queue.shift()!;
      void Promise.resolve().then(() => warm(path)).catch((error: unknown) => {
        options.onError?.(error, path);
      }).finally(next);
    });
  };
  next();
  return () => { cancelled = true; cancelIdle?.(); };
}
