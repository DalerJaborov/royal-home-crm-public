/**
 * НЕ ДАТЬ ЭКРАНУ ПОГАСНУТЬ, ПОКА ИДЁТ ЗАГРУЗКА (25.11.2026).
 *
 * На iPhone блокировка экрана рвёт запрос посреди отдачи: Safari усыпляет вкладку,
 * часть ролика обрывается, и до возврата в приложение очередь стоит. Агент кладёт
 * телефон в карман «пока грузится» — и через минуту экран гаснет. Wake Lock API
 * (`navigator.wakeLock.request("screen")`) держит экран включённым, пока вкладка видна.
 *
 * Счётчик держателей: загрузок может идти несколько (очередь карточки, мастер, чат),
 * экран держим, пока жив хоть один. Браузер сам снимает блокировку, когда вкладка
 * уходит в фон, — при возврате берём её снова. Нет API (старый Safari, Firefox) или
 * браузер отказал — работаем как раньше, без падения.
 */

interface SentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", fn: () => void): void;
}

let holders = 0;
let sentinel: SentinelLike | null = null;
let requesting = false;
let listening = false;

function api(): { request(type: "screen"): Promise<SentinelLike> } | null {
  if (typeof navigator === "undefined") return null;
  const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<SentinelLike> } }).wakeLock;
  return wl && typeof wl.request === "function" ? wl : null;
}

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function acquire(): void {
  const wl = api();
  if (!wl || sentinel || requesting || holders === 0 || !visible()) return;
  requesting = true;
  let pending: Promise<SentinelLike>;
  try {
    pending = wl.request("screen");
  } catch {
    requesting = false;
    return;
  }
  void Promise.resolve(pending).then(
    (s) => {
      requesting = false;
      if (holders === 0) {
        void s.release().catch(() => undefined);
        return;
      }
      sentinel = s;
      s.addEventListener?.("release", () => {
        if (sentinel === s) sentinel = null;
      });
    },
    () => {
      // Отказ (низкий заряд, экономия энергии, политика) — без блокировки, но и без шума.
      requesting = false;
    }
  );
}

function onVisibility(): void {
  if (visible()) acquire();
}

/** Держать экран включённым. Возвращает функцию «отпустить» (повторный вызов — без эффекта). */
export function holdScreenAwake(): () => void {
  holders++;
  if (!listening && typeof document !== "undefined") {
    listening = true;
    document.addEventListener("visibilitychange", onVisibility);
  }
  acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    const s = sentinel;
    sentinel = null;
    if (s) void s.release().catch(() => undefined);
    if (listening && typeof document !== "undefined") {
      listening = false;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

/** Сколько загрузок держат экран сейчас — для тестов и индикатора. */
export function screenAwakeHolders(): number {
  return holders;
}

/** Только для тестов: сбросить состояние модуля. */
export function resetScreenAwakeForTests(): void {
  holders = 0;
  sentinel = null;
  requesting = false;
  if (listening && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  listening = false;
}

/** Подсказка под полосой загрузки ролика: Wake Lock есть не везде, а слова работают всегда. */
export const KEEP_SCREEN_ON_HINT = "Не блокируйте экран, пока идёт загрузка";
