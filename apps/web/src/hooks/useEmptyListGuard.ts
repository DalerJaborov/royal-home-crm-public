import { useCallback, useEffect, useRef, useState } from "react";
import {
  judgeEmptyList,
  nextGuardStep,
  purgeListCaches,
  reportEmptyList,
  shouldPurgeCaches,
  type EmptyListReason,
} from "../lib/emptyListGuard";

export interface EmptyListGuardInput {
  /** Запрос списка включён. Выключенный (закрытый раздел) сторож не трогает вовсе. */
  enabled: boolean;
  /** Устойчивый ключ среза (раздел + условия): смена ключа даёт одну новую попытку. */
  sliceKey: string;
  /** Короткое имя среза для журнала: buyers, sellers… */
  sliceName: string;
  isLoading: boolean;
  isFetching: boolean;
  hasData: boolean;
  error: unknown;
  itemCount: number;
  /** Число по сводке; null, если срез нельзя с ней сравнить; undefined, пока сводки нет. */
  expected: number | null | undefined;
  /** Сводка ещё грузится или перечитывается. */
  summaryPending: boolean;
  dataUpdatedAt?: number;
  /** Мягкий перезапрос списка и сводки (не обрывая идущий). */
  refetchAll: () => Promise<unknown> | void;
}

export interface EmptyListGuard {
  /** Показывать плашку «Список не загрузился». Не гаснет от фонового обновления. */
  broken: boolean;
  healing: boolean;
  /** Кнопка «Обновить»: при пустом списке чистит снимок, кэш воркера и кэш запросов, при ошибке только перезапрашивает. */
  repair: () => Promise<void>;
}

/**
 * Общий сторож пустых списков клиентов (ПК и телефон): см. lib/emptyListGuard.ts.
 * Шаги: 1) сломано → один тихий перезапрос; 2) всё ещё сломано → плашка и тихая
 * запись в журнал; 3) «Обновить» → чистка слоёв (только при пустом списке и сети)
 * и новая загрузка. На возврате приложения на передний план при уже найденной
 * поломке — ещё один мягкий перезапрос.
 */
export function useEmptyListGuard(input: EmptyListGuardInput): EmptyListGuard {
  const verdict = judgeEmptyList({
    enabled: input.enabled,
    summaryPending: input.summaryPending,
    isLoading: input.isLoading,
    isFetching: input.isFetching,
    hasData: input.hasData,
    hasError: !!input.error,
    itemCount: input.itemCount,
    expected: input.expected,
  });
  const reason: EmptyListReason | null = verdict === "pending" || verdict === null ? null : verdict;
  const [autoKey, setAutoKey] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [healing, setHealing] = useState(false);
  const reportedKey = useRef<string | null>(null);
  /** Срез, по которому тихий перезапрос уже начат (ждём его конца, а не повторяем). */
  const startedKey = useRef<string | null>(null);
  const refetchRef = useRef(input.refetchAll);
  refetchRef.current = input.refetchAll;
  const latest = useRef(input);
  latest.current = input;
  const shownReason = useRef<EmptyListReason | null>(null);
  const latestReason = useRef(reason);
  latestReason.current = reason;

  useEffect(() => {
    const step = nextGuardStep({ verdict, autoKey, sliceKey: input.sliceKey, reportedKey: reportedKey.current });
    if (step === "reset") {
      if (autoKey !== null) setAutoKey(null);
      if (shownKey !== null) setShownKey(null);
      reportedKey.current = null;
      startedKey.current = null;
    } else if (step === "auto-retry") {
      // Плашка и запись только ПОСЛЕ того, как перезапрос закончился: иначе при
      // задержке флага isFetching поломка засчитывалась бы до результата перезапроса.
      if (startedKey.current === input.sliceKey) return;
      const key = input.sliceKey;
      startedKey.current = key;
      const done = () => setAutoKey(key);
      Promise.resolve(refetchRef.current()).then(done, done);
    } else if (step === "report" && reason) {
      reportedKey.current = input.sliceKey;
      setShownKey(input.sliceKey);
      shownReason.current = reason;
      const cur = latest.current;
      const status = (cur.error as { status?: unknown } | null)?.status;
      reportEmptyList({
        slice: cur.sliceName,
        reason,
        expected: typeof cur.expected === "number" ? cur.expected : null,
        itemCount: cur.itemCount,
        dataAgeSec: cur.dataUpdatedAt ? Math.round((Date.now() - cur.dataUpdatedAt) / 1000) : undefined,
        errorStatus: typeof status === "number" ? status : undefined,
      });
    }
  }, [verdict, reason, autoKey, shownKey, input.sliceKey]);

  // Возврат приложения на передний план (iOS Safari/PWA морозит вкладку в фоне и сам
  // вычищает IndexedDB и кэш воркера): экран не перемонтируется, поэтому проверяем
  // здесь. Только при уже найденной поломке и без обрыва идущего обновления.
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState === "hidden") return;
      if (!latestReason.current) return;
      void latest.current.refetchAll();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("pageshow", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("pageshow", onForeground);
    };
  }, []);

  const repair = useCallback(async () => {
    if (!latest.current.enabled) return;
    setHealing(true);
    try {
      if (shouldPurgeCaches(latestReason.current ?? shownReason.current, typeof navigator === "undefined" || navigator.onLine !== false)) {
        await purgeListCaches();
      }
      await refetchRef.current();
    } finally {
      setHealing(false);
    }
  }, []);

  return { broken: shownKey !== null && shownKey === input.sliceKey && latest.current.enabled, healing, repair };
}
