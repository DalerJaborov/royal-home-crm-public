import { useAuthStore } from "../store/auth";
import { getOrCreateDeviceId } from "./deviceId";

/**
 * ЕДИНСТВЕННЫЙ выход из аккаунта.
 *
 * До 30.08.2026 выход жил в четырёх местах (меню профиля, раздел «Ещё»,
 * автовыход по бездействию, принудительный выход из api.ts) и НИ ОДНО из них не
 * снимало push-подписку: `PushSubscription` привязана к агенту и живёт вечно.
 * Человек выходил из PWA на телефоне — и продолжал получать уведомления с именем
 * клиента и сутью обращения на устройстве, где никто не залогинен. На сданном или
 * чужом телефоне это прямая утечка данных клиентов.
 *
 * ПОРЯДОК ШАГОВ ЗДЕСЬ — ЧАСТЬ ИСПРАВЛЕНИЯ, менять нельзя:
 *   0) ЗАБРАТЬ access-токен в переменную — до всего остального;
 *   1) сказать серверу «сними эту подписку» этим токеном;
 *   2) снять подписку в браузере (`subscription.unsubscribe()`);
 *   3) погасить сессию на сервере (тем же запросом сообщив endpoint — подстраховка
 *      на случай, если шаг 1 не прошёл).
 * Если брать токен из хранилища ПОСЛЕ очистки состояния, запросы уйдут без
 * Authorization, сервер ответит 401, и строка подписки останется в базе навсегда.
 *
 * Локальное состояние при этом гасится СРАЗУ (шаг 0), а не в конце: интерфейс не
 * имеет права ждать сеть, а держать сессию живой ещё несколько секунд опасно —
 * человек за это время успевает войти другим сотрудником, и наш отложенный
 * `logout()` стёр бы уже ЧУЖУЮ, новую сессию. Токен из переменной делает раннюю
 * очистку безопасной для шагов 1–2 (они идут с токеном А). Шаг 3 токена не несёт:
 * сервер узнаёт сессию по refresh-cookie БРАУЗЕРА, а к моменту шага 3 (до трёх
 * ожиданий по 3 с) там уже может лежать cookie Б. Поэтому в теле шага 3 уходит
 * `agentId` вышедшего, и сервер не отзывает сессию, чья cookie принадлежит другому
 * (аудит 04.10.2026, №3).
 *
 * ШАГ 2 ВАЖНЕЕ ШАГА 1. Снятая в браузере подписка делает endpoint мёртвым: push-сервис
 * начинает отвечать 410, и сервер удаляет строку сам (push.ts). Поэтому выход
 * закрывает утечку даже там, где серверу нечем нас авторизовать — например при
 * принудительном выходе после отказа /auth/refresh.
 *
 * ВСЁ — best-effort и под таймаутом. Сети может не быть, разрешение могли отозвать,
 * `pushManager` может отсутствовать (http, старый браузер), а `serviceWorker.ready`
 * умеет не резолвиться никогда. Человек обязан выйти в любом случае и без задержки.
 */

const BASE_URL = "/api/v1";

/** Больше ждать выход нельзя: за это время человек уже решит, что кнопка сломана. */
const STEP_TIMEOUT_MS = 3000;

/** Раз шаг best-effort — его отказ и его зависание для нас одно и то же. */
function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), STEP_TIMEOUT_MS)),
  ]);
}

/**
 * Запрос в обход `api()` намеренно: тот на 401 уходит обновлять токен, а при выходе
 * обновлять нечего — гонка с уже отозванной сессией здесь только мешает. Плюс
 * `api()` импортирует этот модуль (принудительный выход), и обратный импорт замкнул
 * бы цикл.
 */
function post(path: string, token: string | null, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Device-Id": getOrCreateDeviceId(),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Текущая push-подписка этого браузера — или null, если её нет/не добраться. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/**
 * Шаги 1–2. Возвращает endpoint снятой подписки, чтобы шаг 3 мог передать его
 * серверу как подстраховку.
 */
async function tearDownPush(token: string | null): Promise<string | null> {
  const sub = await withTimeout(currentSubscription(), null);
  if (!sub) return null;
  const { endpoint } = sub;
  await withTimeout(post("/push/unsubscribe", token, { endpoint }), null);
  await withTimeout(sub.unsubscribe(), false);
  return endpoint;
}

/**
 * Выход из аккаунта: снимает push-подписку устройства, гасит сессию на сервере и
 * чистит локальное состояние. Никогда не бросает и не висит дольше нескольких секунд.
 *
 * Переход на /login оставлен вызывающему: в меню и в «Ещё» это `navigate`, а в
 * api.ts — жёсткий `location.href`.
 */
export async function signOut(): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  // Кто выходит — запоминаем ДО logout(): после него стор уже пуст или чужой.
  const agentId = useAuthStore.getState().agent?.id;
  useAuthStore.getState().logout();
  let pushEndpoint: string | null = null;
  try {
    pushEndpoint = await tearDownPush(token);
  } catch {
    /* подписку снять не удалось — выход всё равно продолжается */
  }
  // pushEndpoint отдаём серверу: подписка в базе привязана к агенту, а не к
  // устройству, и без endpoint сервер не знает, ЧЬЮ из них удалять (удалить все —
  // значит выключить уведомления и на компьютере того же сотрудника).
  const logoutBody = { ...(pushEndpoint ? { pushEndpoint } : {}), ...(agentId ? { agentId } : {}) };
  await withTimeout(post("/auth/logout", token, Object.keys(logoutBody).length ? logoutBody : undefined), null);
}
