import { ApiError, isInProgressError, isReadOnlyRoleError } from "./apiError";
import { queryClient } from "./queryClient";
import { toast } from "../store/toast";

/**
 * Очередь отложенных записей для офлайна (PWA): создание клиента/взаимодействия/объекта,
 * не ушедшее из-за отсутствия сети, сохраняется в localStorage и автоматически
 * отправляется при появлении соединения (событие online + старт приложения).
 *
 * Отправщик передаётся снаружи, а не импортируется из `api.ts`. Иначе получался
 * цикл: `api.ts` кладёт неудавшийся запрос в очередь, а очередь зовёт `api.ts`,
 * чтобы его отправить. Цикл работал, но делал порядок инициализации неявным —
 * ровно тот класс проблем, который однажды уронил дашборд ошибкой «Cannot access
 * ... before initialization». Теперь единственную связь задаёт main.tsx.
 */

/** Как очередь отправляет отложенный запрос. Совпадает по форме с `api()`. */
type SendRequest = (
  path: string,
  init: { method: string; body: unknown; idempotencyKey?: string; expectAgentId?: string }
) => Promise<unknown>;

/** Кто сейчас вошёл (agent.id) или null, если сессии нет. Передаётся из main.tsx —
 *  импортировать store/auth напрямую нельзя: auth чистит эту же очередь при выходе,
 *  и получился бы цикл модулей (см. шапку про api.ts). */
type CurrentAgentId = () => string | null;

let send: SendRequest | null = null;
let currentAgentId: CurrentAgentId = () => null;

const KEY = "royal-home-offline-queue";
export const OFFLINE_QUEUE_EVENT = "rh:offline-queue-change";

export interface QueuedRequest {
  id: string;
  path: string;
  method: string;
  body: unknown;
  ts: number;
  /** Author of the write. Historical unowned entries are never sent as a new user. */
  agentId?: string;
  /** Ключ повтора первой попытки (apps/api/src/lib/idempotency.ts). Записи до
   *  23.09.2026 его не имеют и отправляются как раньше. */
  idempotencyKey?: string;
  rejection?: { status: number; message: string; rejectedAt: number };
}

/** Ошибка-маркер: запрос не ушёл, но сохранён и отправится сам. UI показывает message как есть. */
export class OfflineQueuedError extends Error {
  constructor() {
    super("Нет соединения — данные сохранены на устройстве и отправятся автоматически при появлении сети");
    this.name = "OfflineQueuedError";
  }
}

function read(): QueuedRequest[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

function write(queue: QueuedRequest[]) {
  localStorage.setItem(KEY, JSON.stringify(queue));
  if (typeof window !== "undefined") window.dispatchEvent?.(new Event(OFFLINE_QUEUE_EVENT));
}

export function enqueueOffline(path: string, method: string, body: unknown, idempotencyKey?: string, actorId = currentAgentId() ?? undefined) {
  if (!actorId) throw new ApiError("Сессия сменилась — данные не сохранены в очередь", 401, undefined);
  const queue = read();
  queue.push({
    id: crypto.randomUUID(),
    path,
    method,
    body,
    ts: Date.now(),
    agentId: actorId,
    idempotencyKey,
  });
  write(queue);
}

/** Only the signed-in owner can inspect or recover locally rejected data. */
export function getRejectedOfflineRequests(): QueuedRequest[] {
  const actor = currentAgentId();
  return actor ? read().filter((item) => item.agentId === actor && !!item.rejection) : [];
}

export function retryRejectedOfflineRequest(id: string, correctedBody?: unknown): boolean {
  const actor = currentAgentId();
  const queue = read();
  const item = queue.find((entry) => entry.id === id && entry.agentId === actor && !!entry.rejection);
  if (!actor || !item) return false;
  if (correctedBody !== undefined) item.body = correctedBody;
  // The rejected attempt may have a cached idempotent response; a deliberate
  // correction/retry is a new attempt, not a resend of an uncertain network result.
  item.idempotencyKey = crypto.randomUUID();
  delete item.rejection;
  write(queue);
  return true;
}

export function discardRejectedOfflineRequest(id: string): boolean {
  const actor = currentAgentId();
  const queue = read();
  if (!actor || !queue.some((entry) => entry.id === id && entry.agentId === actor && !!entry.rejection)) return false;
  write(queue.filter((entry) => entry.id !== id));
  return true;
}

/** Убирает ровно одну запись из АКТУАЛЬНОГО хранилища, не трогая добавленные позже. */
function removeQueued(id: string) {
  write(read().filter((r) => r.id !== id));
}

let flushing = false;

/** Sends owned entries in order. Permanent rejections stay locally recoverable
 * without blocking other entries; network failures pause the pass. */
export async function flushOfflineQueue(): Promise<void> {
  // Отправщик появляется в startOfflineQueue при старте приложения. До этого
  // отправлять нечем — но записи в очереди лежат и уйдут при следующем проходе.
  if (flushing || !send) return;
  // Без живой сессии не отправляем вовсе: каждый запрос получил бы 401, а до
  // 26.08.2026 ветка 4xx при этом БЕЗВОЗВРАТНО выбрасывала все накопленные офлайн
  // записи — истёкшая сессия молча уничтожала сделанную без сети работу.
  const me = currentAgentId();
  if (!me) return;
  flushing = true;
  let sentAny = false;
  try {
    // Очередь перечитывается на КАЖДОМ шаге, а отправленная запись удаляется по id
    // из актуального хранилища. Раньше список читался один раз, и write() затирал
    // хранилище целиком: всё, что человек успевал сделать за время отправки (а это
    // сетевой запрос на каждую запись), молча исчезало — ровно в режиме, который и
    // создан для плохой связи.
    // Записи, на которые сервер в этом проходе ответил 403: остаются в очереди,
    // но не держат собой остальные (см. ветку 403 ниже).
    const held = new Set<string>();
    for (;;) {
      // Аккаунт сменился посреди прохода (А вышел, вошёл Б; вход Б запустил свой
      // flush, но тот сразу вышел — `flushing` занят нами). Дальше цикл идёт от
      // имени А, а токен у api() уже Б: запись А ушла бы чужим токеном (аудит
      // 04.10.2026, №2). Проверка и send ниже — один синхронный тик: api() читает
      // токен до первого await.
      if (currentAgentId() !== me) break;
      const queue = read();
      // Чужие записи (общий телефон: без сети работал агент А, вошёл агент Б) не
      // отправляются под текущим токеном — лежат до входа их автора. Записи без
      // доказанного автора не отправляются под новой сессией.
      const item = queue.find((r) => r.agentId === me && !r.rejection && !held.has(r.id));
      if (!item) break;
      try {
        await send(item.path, {
          method: item.method,
          body: item.body,
          idempotencyKey: item.idempotencyKey,
          // api() сверит личность перед сетью и после обновления токена по 401.
          expectAgentId: me,
        });
        sentAny = true;
        removeQueued(item.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Сессия потеряна — записи не трогаем, проход прерываем до следующего
          // появления сети или входа.
          console.warn("[offline-queue] отправка приостановлена: нет входа:", item.path, err.message);
          break;
        }
        if (err instanceof ApiError && (err.status === 428 || (err.status === 403 && !isReadOnlyRoleError(err)))) {
          // Отказ в доступе к ОДНОЙ записи (карточка ушла другому агенту, пока
          // запись ждала сети) — не повод держать все остальные. До 23.09.2026
          // здесь стоял break: одна заметка по переданному клиенту навсегда
          // запирала в телефоне новых клиентов, объекты и прочие заметки агента.
          // Саму запись не выбрасываем — доступ могут вернуть.
          console.warn("[offline-queue] запись отклонена по доступу, остальные идут дальше:", item.path, err.message);
          held.add(item.id);
          continue;
        }
        // Первая попытка ещё выполняется на сервере (обрыв был по нашему
        // таймеру) — не выбрасываем запись: если та попытка умрёт, досылка
        // позже займёт ключ заново.
        if (isInProgressError(err)) {
          break;
        }
        // «Слишком часто» (429) и «не дождались» (408) — не отказ по сути, а
        // просьба прийти позже: запись ждёт следующего прохода. Раньше любая 4xx
        // выбрасывала запись, хотя агенту обещано «отправится автоматически»
        // (аудит 23.09.2026, №13).
        if (err instanceof ApiError && (err.status === 429 || err.status === 408)) {
          break;
        }
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          // Retain the promised local data for inspection/correction; don't keep
          // resending an unchanged permanent refusal on every heartbeat.
          const latest = read();
          const rejected = latest.find((entry) => entry.id === item.id);
          if (rejected) {
            rejected.rejection = { status: err.status, message: err.message, rejectedAt: Date.now() };
            write(latest);
          }
          if (currentAgentId() === me) toast.error(`Не удалось отправить сохранённые данные: ${err.message}. Запись сохранена в офлайн-очереди для исправления.`);
          continue;
        }
        break; // сеть всё ещё недоступна — попробуем позже
      }
    }
  } finally {
    flushing = false;
  }
  // После отправки отложенных записей обновляем все кэши: оптимистичные значения
  // (принятие/статус/сделки, применённые локально офлайн) заменяются серверной правдой.
  if (sentAny) queryClient.invalidateQueries();
  // Проход прервала смена аккаунта: очередь нового агента ждала нас (его flush
  // вышел на `flushing`), без этого она лежала бы до следующего сердцебиения (60 с).
  if (currentAgentId() !== me) flushOfflineQueue().catch(() => {});
}

/**
 * Как часто пробуем досылать отложенное, пока приложение открыто.
 *
 * Событие «online» — недостаточный триггер (аудит №4, 27.08): в очередь запись
 * попадает на ЛЮБОМ обрыве fetch, в том числе при мёртвом Wi-Fi, captive-портале
 * или тридцатисекундной недоступности сервера — а navigator.onLine при этом
 * остаётся true, и события браузер не пришлёт никогда. Агент видел «не
 * сохранилось», делал правку заново, а назавтра при перезапуске PWA очередь
 * досылала вчерашнюю. Тот же приём, что у uploadQueue: сердцебиение + вход.
 */
const HEARTBEAT_MS = 60_000;

export function startOfflineQueue(
  sender: SendRequest,
  agentId: CurrentAgentId,
  /**
   * Подписка «человек вошёл» — передаётся из main.tsx по той же причине, что и
   * currentAgentId: импортировать auth-store здесь нельзя, получился бы цикл.
   *
   * ВХОД — обязательный повод (та же дыра, что чинили у uploadQueue 15.08): при
   * старте сессии обычно ещё нет, flush выходит сразу, и записи лежали бы до
   * следующего запуска приложения, хотя человек уже вошёл и сеть на месте.
   */
  onSignIn?: (cb: () => void) => void
) {
  send = sender;
  currentAgentId = agentId;
  window.addEventListener("online", () => {
    flushOfflineQueue().catch(() => {});
  });
  onSignIn?.(() => {
    flushOfflineQueue().catch(() => {});
  });
  window.setInterval(() => {
    flushOfflineQueue().catch(() => {});
  }, HEARTBEAT_MS);
  if (navigator.onLine) flushOfflineQueue().catch(() => {});
}
