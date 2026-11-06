import { useCallback, useEffect, useRef, useState } from "react";
import { judgeEmptyList, purgeListCaches, reportEmptyList, type EmptyListReason } from "../lib/emptyListGuard";

export interface EmptyListGuardInput {
  /** Устойчивый ключ среза (раздел + условия): смена ключа даёт одну новую попытку. */
  sliceKey: string;
  /** Короткое имя среза для журнала: buyers, sellers… */
  sliceName: string;
  isLoading: boolean;
  isFetching: boolean;
  hasData: boolean;
  error: unknown;
  itemCount: number;
  /** Число по сводке или null, если срез нельзя с ней сравнить. */
  expected: number | null | undefined;
  dataUpdatedAt?: number;
  /** Перезапрос списка и сводки. */
  refetchAll: () => Promise<unknown> | void;
}

export interface EmptyListGuard {
  /** Показывать плашку «Список не загрузился». */
  broken: boolean;
  healing: boolean;
  /** Кнопка «Обновить»: чистит снимок, кэш воркера, кэш запросов и грузит заново. */
  repair: () => Promise<void>;
}

/**
 * Общий сторож пустых списков клиентов (ПК и телефон): см. lib/emptyListGuard.ts.
 * Шаги: 1) сломано → один тихий перезапрос; 2) всё ещё сломано → плашка и тихая
 * запись в журнал; 3) «Обновить» → полная чистка слоёв и новая загрузка.
 */
export function useEmptyListGuard(input: EmptyListGuardInput): EmptyListGuard {
  const verdict = judgeEmptyList({
    isLoading: input.isLoading,
    isFetching: input.isFetching,
    hasData: input.hasData,
    hasError: !!input.error,
    itemCount: input.itemCount,
    expected: input.expected,
  });
  const reason: EmptyListReason | null = verdict === "pending" || verdict === null ? null : verdict;
  const [autoKey, setAutoKey] = useState<string | null>(null);
  const [healing, setHealing] = useState(false);
  const reportedKey = useRef<string | null>(null);
  const refetchRef = useRef(input.refetchAll);
  refetchRef.current = input.refetchAll;
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    if (verdict === "pending") return;
    if (!reason) {
      if (autoKey !== null) setAutoKey(null);
      reportedKey.current = null;
      return;
    }
    if (autoKey !== input.sliceKey) {
      setAutoKey(input.sliceKey);
      void refetchRef.current();
      return;
    }
    if (reportedKey.current !== input.sliceKey) {
      reportedKey.current = input.sliceKey;
      const cur = latest.current;
      const status = (cur.error as { status?: unknown } | null)?.status;
      reportEmptyList({
        slice: cur.sliceName,
        reason,
        expected: cur.expected,
        itemCount: cur.itemCount,
        dataAgeSec: cur.dataUpdatedAt ? Math.round((Date.now() - cur.dataUpdatedAt) / 1000) : undefined,
        errorStatus: typeof status === "number" ? status : undefined,
      });
    }
  }, [verdict, reason, autoKey, input.sliceKey]);

  // Возврат приложения на передний план (iOS Safari/PWA морозит вкладку в фоне и сам
  // вычищает IndexedDB и кэш воркера): экран не перемонтируется, поэтому проверяем
  // заново здесь. Пустой или упавший список получает новую попытку; если и она не
  // помогла, плашка вернётся обычным путём.
  useEffect(() => {
    const onForeground = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const cur = latest.current;
      if (cur.isLoading || cur.isFetching) return;
      if (cur.error || cur.itemCount === 0) {
        setAutoKey(null);
        void refetchRef.current();
      }
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("pageshow", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("pageshow", onForeground);
    };
  }, []);

  const repair = useCallback(async () => {
    setHealing(true);
    try {
      await purgeListCaches();
      await refetchRef.current();
    } finally {
      setHealing(false);
    }
  }, []);

  return { broken: !!reason && autoKey === input.sliceKey, healing, repair };
}
