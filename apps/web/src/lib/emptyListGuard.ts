import { queryClient } from "./queryClient";
import { clearPersistedQueryCache, buildVersion } from "./queryPersist";
import { dropSwApiCache } from "./swApiCache";
import { reportEmptyListGuard } from "./errorReporter";

/**
 * ЕДИНАЯ ДВЕРЬ САМОЛЕЧЕНИЯ СПИСКОВ КЛИЕНТОВ (06.11.2026).
 *
 * Жалоба: у агента «ничего не показывает: ни клиентов, ни продавцов», сервер при
 * этом чист (ответы 200, данные в базе есть). Причина не найдена, поэтому вместо
 * охоты за одним слоем (service worker api-cache, снимок queryPersist, React Query)
 * стоит сторож на симптоме: список пуст, а сводка говорит, что клиенты есть, либо
 * запрос в ошибке. Тогда: один молчаливый перезапрос, затем плашка с кнопкой,
 * которая сносит ВСЕ слои старых данных и грузит заново. Пустой экран при
 * непустых данных больше не держится молча.
 */

export type EmptyListReason = "empty-vs-summary" | "error";

export interface EmptyListFacts {
  isLoading: boolean;
  isFetching: boolean;
  hasData: boolean;
  hasError: boolean;
  itemCount: number;
  /** Сколько клиентов в срезе по сводке; null, если срез нельзя сравнить со сводкой
   *  (фильтры, поиск, особые разделы). */
  expected: number | null | undefined;
}

/**
 * "pending" — идёт загрузка, судить рано; null — всё хорошо; иначе причина поломки.
 * Чистая функция — вся логика решения проверяется тестом без React.
 */
export function judgeEmptyList(f: EmptyListFacts): EmptyListReason | "pending" | null {
  if (f.isLoading || f.isFetching) return "pending";
  if (f.hasError) return "error";
  if (f.hasData && f.itemCount === 0 && typeof f.expected === "number" && f.expected > 0) return "empty-vs-summary";
  return null;
}

/** Все слои старых данных: снимок на диске, кэш воркера, кэш React Query. */
export async function purgeListCaches(): Promise<void> {
  // allSettled + потолок ожидания: заблокированная IndexedDB (iOS, приватный режим)
  // не должна ни ронять, ни подвешивать кнопку «Обновить».
  const withCeiling = (p: Promise<unknown>) =>
    Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
  await Promise.allSettled([withCeiling(clearPersistedQueryCache()), withCeiling(dropSwApiCache())]);
  queryClient.removeQueries({ queryKey: ["clients"] });
}

const THROTTLE_KEY = "royal-home-empty-list-guard-at";
const THROTTLE_MS = 60 * 60 * 1000;

/** Не чаще раза в час на устройство и срез. Хранилище недоступно — шлём (дедуп есть выше). */
function throttled(slice: string): boolean {
  try {
    const all = JSON.parse(localStorage.getItem(THROTTLE_KEY) ?? "{}") as Record<string, number>;
    const now = Date.now();
    if (all[slice] && now - all[slice] < THROTTLE_MS) return true;
    all[slice] = now;
    localStorage.setItem(THROTTLE_KEY, JSON.stringify(all));
  } catch {
    /* без хранилища — не ограничиваем */
  }
  return false;
}

export interface EmptyListReportInfo {
  slice: string;
  reason: EmptyListReason;
  expected: number | null | undefined;
  itemCount: number;
  /** Возраст данных запроса в секундах. */
  dataAgeSec?: number;
  errorStatus?: number;
}

/** Только технические факты: ни телефонов, ни имён, ни id клиентов. */
export function formatEmptyListMessage(i: EmptyListReportInfo): string {
  const sw = typeof navigator !== "undefined" && navigator.serviceWorker?.controller ? "есть" : "нет";
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  return (
    `[empty-list-guard] срез ${i.slice}, причина ${i.reason}, по сводке ${i.expected ?? "?"}, на экране ${i.itemCount}, ` +
    `возраст данных ${i.dataAgeSec ?? "?"} с, статус ${i.errorStatus ?? "-"}, воркер ${sw}, online=${online}, сборка ${buildVersion() || "?"}`
  );
}

export function reportEmptyList(info: EmptyListReportInfo): void {
  if (throttled(info.slice)) return;
  reportEmptyListGuard(formatEmptyListMessage(info));
}
