/**
 * РЕЕСТР «ИДЁТ РАБОТА, КОТОРУЮ НЕЛЬЗЯ ОБОРВАТЬ» (владелец 07.10.2026: «ролики и
 * фото, которые выбрал агент, всегда дозагружались без проблем, и он видел
 * процесс»).
 *
 * ЗАЧЕМ ОДНО МЕСТО. Загрузка файлов мастера живёт в памяти вкладки
 * (lib/draftUploads.ts), и три вещи убивали её молча: закрытие вкладки без
 * вопроса, автообновление PWA (UpdatePrompt) и автовыход (useIdleLogout), а на
 * телефоне ещё и «приложение свернули — вернулись, а очередь спит»: события
 * возврата никто не слушал. Раньше каждый из этих сторожей вешал бы свои
 * слушатели; теперь они висят в ОДНОМ месте и только пока в реестре что-то
 * есть.
 *
 * Контракт: кто ведёт долгую работу, регистрирует её и получает функцию отмены
 * регистрации. `resume()` зовётся, когда у работы появился шанс идти дальше
 * (вернулись в приложение, появилась сеть, раз в 30 с). `flush()` зовётся, когда
 * вкладка уходит в фон или закрывается — последний момент что-то досохранить.
 *
 * Без зависимостей от React и от остальных модулей приложения.
 */

/** online — появилась сеть; visible — вернулись в приложение; heartbeat — плановый тик. */
export type ResumeReason = "online" | "visible" | "heartbeat";

export interface WorkItem {
  /** Один id — одна запись: повторная регистрация заменяет прежнюю. */
  id: string;
  /** Подпись для человека («Загрузка файлов объекта»). */
  label: string;
  /** true — закрытие вкладки должно спросить подтверждение браузера. */
  blocksUnload: boolean;
  /**
   * Вернулись в приложение / появилась сеть / тик — подтолкнуть работу. Повод передаётся
   * (25.11.2026, находка 3): сердцебиение раз в 30 с не должно стирать паузу после отказа
   * сервера — иначе 10 попыток сгорали за пять минут вместо двадцати пяти. Сбрасывать
   * паузу честно только по `online` и возврату в приложение, и только у обрыва связи.
   */
  resume?: (reason: ResumeReason) => void;
  /** Вкладка ушла в фон или закрывается — досохранить то, что ещё не уехало. */
  flush?: () => void;
}

/** Период сердцебиения: пока работа есть, раз в столько зовём `resume()`. */
export const WORK_HEARTBEAT_MS = 30_000;

const registry = new Map<string, WorkItem>();
const subscribers = new Set<() => void>();

let attached = false;
let unloadAttached = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function safeCall(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    /* работа одного не должна ломать остальных */
  }
}

function resumeAll(reason: ResumeReason): void {
  for (const item of [...registry.values()]) safeCall(item.resume && (() => item.resume!(reason)));
}

const resumeOnline = () => resumeAll("online");
const resumeVisible = () => resumeAll("visible");
const resumeHeartbeat = () => resumeAll("heartbeat");

function flushAll(): void {
  for (const item of [...registry.values()]) safeCall(item.flush);
}

function onVisibilityChange(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") resumeAll("visible");
  else if (document.visibilityState === "hidden") flushAll();
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!isBlockingUnload()) return;
  // Стандартное подтверждение браузера: текст он подставляет сам.
  e.preventDefault();
  e.returnValue = "";
}

function notify(): void {
  for (const fn of [...subscribers]) safeCall(fn);
}

/** Слушатели вешаются, когда в реестре появилась работа, и снимаются, когда он опустел. */
function syncListeners(): void {
  if (typeof window === "undefined") return;
  const hasWork = registry.size > 0;

  if (hasWork && !attached) {
    attached = true;
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("pageshow", resumeVisible);
    window.addEventListener("online", resumeOnline);
    heartbeat = setInterval(resumeHeartbeat, WORK_HEARTBEAT_MS);
  } else if (!hasWork && attached) {
    attached = false;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", flushAll);
    window.removeEventListener("pageshow", resumeVisible);
    window.removeEventListener("online", resumeOnline);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  const needUnload = isBlockingUnload();
  if (needUnload && !unloadAttached) {
    unloadAttached = true;
    window.addEventListener("beforeunload", onBeforeUnload);
  } else if (!needUnload && unloadAttached) {
    unloadAttached = false;
    window.removeEventListener("beforeunload", onBeforeUnload);
  }
}

/** Зарегистрировать работу. Возвращает функцию снятия — зови её, когда работа кончилась. */
export function registerWork(item: WorkItem): () => void {
  registry.set(item.id, item);
  syncListeners();
  notify();
  return () => {
    // Снимаем только СВОЮ запись: иначе устаревшая функция снятия убрала бы
    // заново зарегистрированную работу с тем же id.
    if (registry.get(item.id) !== item) return;
    registry.delete(item.id);
    syncListeners();
    notify();
  };
}

/** Идёт ли хоть какая-то работа — автообновление и автовыход в это время не вмешиваются. */
export function isBusy(): boolean {
  return registry.size > 0;
}

/**
 * Последний шанс досохранить — зовёт автообновление, когда ждать работу дольше
 * потолка нельзя (store/appUpdate.ts, MAX_WORK_DEFER_MS): та же `flush()`, что
 * при уходе вкладки в фон.
 */
export function flushWork(): void {
  flushAll();
}

/** Есть ли работа, при которой закрытие вкладки обязано переспросить. */
export function isBlockingUnload(): boolean {
  for (const item of registry.values()) if (item.blocksUnload) return true;
  return false;
}

/** Подписи идущей работы — для индикатора. */
export function listWork(): string[] {
  return [...registry.values()].map((i) => i.label);
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
