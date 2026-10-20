/**
 * Черновик поля/формы, который переживает принудительную перезагрузку при
 * автообновлении приложения (находка ночной проверки 24.09.2026, №246/К2-4).
 *
 * ЗАЧЕМ. Автообновление сайта (`UpdatePrompt.tsx`) откладывается, пока человек
 * занят (`lib/isUserActivelyTyping.ts`), но не больше пяти минут (решение
 * владельца 10.09.2026) — после чего вкладка перезагружается ПРИНУДИТЕЛЬНО,
 * даже посреди набора текста. Перед подменой `UpdatePrompt.tsx` шлёт
 * `window.dispatchEvent(new CustomEvent("rh:before-app-update"))`, но раньше
 * его никто не слушал: набранный, но не отправленный ответ в чате
 * (`Messages.tsx`/`MobileChatView.tsx`) и незавершённая правка карточки
 * клиента (`ClientFormModal.tsx`) терялись молча. Потолок в 5 минут решением
 * владельца остаётся как есть — чинится только потеря черновика.
 *
 * ПОЧЕМУ НЕ `useFormDraft.ts`. Тот хук решает другую задачу (обрыв связи в
 * поле на объекте, живёт сутки в localStorage, пишет с дебаунсом на каждое
 * изменение). Здесь снимок нужен РОВНО в момент события, ничего не пишется
 * до и после него, и хранилище — sessionStorage: черновик касается именно
 * этой вкладки и именно этой перезагрузки, как и метка «обновление
 * применилось» в `appUpdateNotice.ts`.
 */
const PREFIX = "rh:draft-before-update:";

/** Событие шлёт `UpdatePrompt.tsx` перед принудительной подменой сборки. */
const EVENT = "rh:before-app-update";

interface DraftSession { actorId: string | undefined; epoch: number }
let currentSession: () => DraftSession = () => ({ actorId: undefined, epoch: 0 });
/** Auth supplies this reader to keep the draft helper free of an auth import cycle. */
export function configureDraftBeforeUpdateSession(reader: () => DraftSession): void {
  currentSession = reader;
}

function storageKey(key: string, actorId: string): string {
  return `${PREFIX}v2:${encodeURIComponent(actorId)}:${key}`;
}

/** Session transitions invalidate both scoped and historical unowned snapshots. */
export function clearDraftsBeforeUpdate(): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch { /* Storage may be unavailable; no snapshot can be consumed then. */ }
}

/** Сохранить снимок значения под ключом — вызывается по сигналу
 *  `rh:before-app-update`. Пустое значение не хранится (нечего восстанавливать
 *  и незачем занимать место). */
export function saveDraftBeforeUpdate<T>(key: string, value: T, isEmpty: (v: T) => boolean): void {
  const { actorId } = currentSession();
  if (!actorId) return;
  const scopedKey = storageKey(key, actorId);
  try {
    if (isEmpty(value)) {
      sessionStorage.removeItem(scopedKey);
      return;
    }
    sessionStorage.setItem(scopedKey, JSON.stringify(value));
  } catch {
    // Приватный режим/переполненное хранилище — черновик просто не переживёт
    // перезагрузку, само поле продолжает работать как есть.
  }
}

/** Забрать снимок по ключу — один раз: ключ удаляется сразу же, повторное
 *  открытие того же ключа ничего не найдёт. */
export function consumeDraftBeforeUpdate<T>(key: string): T | null {
  const { actorId } = currentSession();
  try {
    // Historical snapshots have no provable owner. Discard them instead of
    // interpreting an old user's client/contact data as the new user's draft.
    sessionStorage.removeItem(PREFIX + key);
    if (!actorId) return null;
    const scopedKey = storageKey(key, actorId);
    const raw = sessionStorage.getItem(scopedKey);
    if (raw === null) return null;
    sessionStorage.removeItem(scopedKey);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Подписка на `rh:before-app-update`: в момент сигнала спрашивает самое
 * свежее значение через `getValue` (не замыкает его на момент подписки — к
 * моменту сигнала оно почти всегда уже другое) и сохраняет им. Вынесена из
 * `hooks/useDraftBeforeUpdate.ts` голой функцией — без обёртки React,
 * которую негде смонтировать в тестах этого воркспейса (jsdom не установлен,
 * см. vitest.config.ts, тот же приём — `lib/isUserActivelyTyping.ts`).
 * Возвращает функцию отписки.
 */
export function subscribeDraftBeforeUpdate<T>(
  key: string,
  getValue: () => T,
  isEmpty: (value: T) => boolean
): () => void {
  const bound = currentSession();
  function onBeforeUpdate() {
    const live = currentSession();
    if (!bound.actorId || live.actorId !== bound.actorId || live.epoch !== bound.epoch) return;
    saveDraftBeforeUpdate(key, getValue(), isEmpty);
  }
  window.addEventListener(EVENT, onBeforeUpdate);
  return () => window.removeEventListener(EVENT, onBeforeUpdate);
}
