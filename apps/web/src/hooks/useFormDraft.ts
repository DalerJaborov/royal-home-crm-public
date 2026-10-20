import { useEffect, useRef, useState } from "react";

/**
 * ЧЕРНОВИК ЗАПОЛНЕННОЙ ФОРМЫ В ПАМЯТИ УСТРОЙСТВА (совет экспертов 26.08, п. 10).
 *
 * Зачем. Обязательное окно «Итог показа» агент заполняет стоя на объекте, где
 * связь ловит через раз: отправка падает, экран пересоздаётся при возврате в
 * приложение — и всё написанное пропадает. Система при этом ШТРАФУЕТ за
 * незаполненный итог, то есть наказывает ровно за то, чему сама не помогла.
 *
 * Что делает. Держит снимок состояния формы в localStorage под ключом и отдаёт
 * его обратно при следующем открытии. Ничего не отправляет и не «додумывает»:
 * это именно черновик — восстановили, агент дописал, отправил, черновик стёрся.
 *
 * Чего НЕ делает. Не хранит ничего после успешной отправки (clear вызывает сам
 * вызывающий) и не живёт дольше суток: итог вчерашнего показа сегодня уже не
 * тот разговор, и подставлять его — хуже, чем пустая форма.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = "royal-home-draft:";

export interface StoredDraft<T> {
  at: number;
  value: T;
  context?: { draftId: string | null; baseRevision: number | null; dirty: boolean };
}

export function loadFormDraft<T>(key: string, ttlMs = TTL_MS): T | null {
  return loadFormDraftSnapshot<T>(key, ttlMs)?.value ?? null;
}

export function loadFormDraftSnapshot<T>(key: string, ttlMs = TTL_MS): StoredDraft<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    if (!parsed || typeof parsed.at !== "number" || Date.now() - parsed.at > ttlMs) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return parsed;
  } catch {
    // Хранилище недоступно (приватный режим, переполнение) — работаем как раньше.
    return null;
  }
}

export function clearFormDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Нечего чистить — и ладно.
  }
}

/**
 * Сохраняет снимок формы при каждом изменении (кроме пустого — пустой черновик
 * незачем хранить и незачем предлагать).
 *
 * @param key       стабильный ключ формы, обычно с id сущности
 * @param value     текущее состояние формы
 * @param isEmpty   что считать «ничего не заполнено»
 */
export function useFormDraft<T>(key: string | null, value: T, isEmpty: (v: T) => boolean, delayMs = 400, context?: StoredDraft<T>["context"]): boolean | null {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  // Пишем не на каждый кадр набора текста, а с небольшой задержкой: localStorage
  // синхронный, и запись на каждый символ подтормаживала бы поле ввода.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!key) return;
    if (timer.current) clearTimeout(timer.current);
    const write = () => {
      try {
        if (isEmpty(value)) localStorage.removeItem(PREFIX + key);
        else localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value, ...(context ? { context } : {}) } satisfies StoredDraft<T>));
        setPersisted(true);
      } catch {
        setPersisted(false);
        // Переполнение или запрет хранилища — форма продолжает работать как есть.
      }
    };
    if (delayMs === 0) write();
    else timer.current = setTimeout(write, delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // isEmpty намеренно вне зависимостей: это чистый предикат, и его пересоздание
    // на каждый рендер вызывающего не должно перезапускать таймер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value, delayMs, context?.draftId, context?.baseRevision, context?.dirty]);
  return persisted;
}
