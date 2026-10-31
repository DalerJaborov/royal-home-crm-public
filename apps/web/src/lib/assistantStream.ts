import { ASSISTANT_HISTORY_WINDOW, type AssistantCard, type AssistantTokenEvent } from "@royal-home/shared";
import { refreshAccessToken } from "./api";
import { getOrCreateDeviceId } from "./deviceId";
import { httpStatusMessage } from "./httpStatusMessage";
import { currentSessionEpoch } from "./sessionGuard";
import { useAuthStore } from "../store/auth";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

/** Потолок ожидания ответа. Сервер сам укладывается раньше (план: 25 с), клиент даёт запас на сеть. */
export const ASSISTANT_TIMEOUT_MS = 30_000;
/** Сервер принимает реплику до 4000 символов (assistantRequestSchema) — длиннее режем, а не получаем 400. */
const MAX_MESSAGE_CHARS = 4000;

export type AssistantErrorCode = "aborted" | "timeout" | "network" | "http" | "server" | "session";

/**
 * Ошибка потока помощника с кодом: панель решает по нему, показывать ли «Повторить»,
 * а отмену самим пользователем (`aborted`) не показывает как ошибку вовсе.
 */
export class AssistantStreamError extends Error {
  readonly code: AssistantErrorCode;
  /** Имеет ли смысл нажать «Повторить»: сбой сети/таймаут/перегрузка — да, «выключен» или «нет прав» — нет. */
  readonly retryable: boolean;
  constructor(code: AssistantErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "AssistantStreamError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Окно истории, уходящее на сервер: последние ASSISTANT_HISTORY_WINDOW реплик.
 * Сервер принимает до 30, а клиент раньше слал ВСЮ переписку и на 16-й паре получал
 * 400 «Неверные данные» (аудит 31.10.2026, п. 12). Окно обязано начинаться с реплики
 * человека — модель не должна открывать разговор «своим» ответом.
 */
export function windowMessages(messages: AssistantMessage[]): AssistantMessage[] {
  const tail = messages.slice(-ASSISTANT_HISTORY_WINDOW);
  const firstUser = tail.findIndex((m) => m.role === "user");
  return (firstUser === -1 ? [] : tail.slice(firstUser)).map((m) => ({
    role: m.role,
    content: m.content.length > MAX_MESSAGE_CHARS ? m.content.slice(0, MAX_MESSAGE_CHARS) : m.content,
  }));
}

export interface StreamAssistantOptions {
  /** Отмена снаружи (закрытие панели, кнопка «Стоп»). Запрос и чтение потока обрываются. */
  signal?: AbortSignal;
  /** Своё значение потолка, по умолчанию ASSISTANT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Карточка результата, пришедшая раньше финального текста (быстрый путь без модели). */
  onCard?: (card: AssistantCard) => void;
  /**
   * Текст ответа по мере генерации (SSE-событие `token`, задача 1.6): в колбэк
   * приходит ВЕСЬ накопленный на сей момент текст, а не дельта. Окончательный
   * ответ — всё равно возвращаемое значение (текст из `done`).
   */
  onToken?: (textSoFar: string) => void;
}

interface SseData {
  message?: string;
  reply?: string;
  error?: string;
}

/**
 * SSE-клиент для POST /ai/assistant (план B3, docs/ai-bots-audit-13-09.md).
 *
 * Не через общий хелпер api() — тот ждёт один JSON-ответ, а этот эндпоинт
 * отдаёт поток событий (`text/event-stream`) с телом в POST-запросе: обычный
 * EventSource для такого не подходит (умеет только GET без тела), поэтому
 * здесь прямой fetch + ручной разбор SSE-кадров построчно из reader'а.
 * Авторизация — тот же приём, что в api.ts (Bearer-токен + один повтор через
 * refreshAccessToken при 401), сокращённый до нужного здесь минимума.
 *
 * ОТМЕНА И ТАЙМАУТ (31.10.2026). Раньше у запроса не было ни того ни другого:
 * закрытая панель оставляла запрос жить (и ответ приходил в размонтированный
 * компонент), а зависший сервер означал вечное «Думаю…». Теперь один
 * AbortController на запрос: его рвёт внешний `signal`, либо таймер потолка.
 * Причина различается — `aborted` (человек сам) и `timeout` (ждали слишком долго).
 * Историю сюда передаёт вызывающий как есть — окно из 12 реплик режется здесь.
 */
export async function streamAssistant(
  messages: AssistantMessage[],
  onStatus: (message: string) => void,
  options: StreamAssistantOptions = {},
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? ASSISTANT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    return await run(windowMessages(messages), onStatus, options, controller.signal);
  } catch (err) {
    throw normalizeError(err, timedOut, options.signal?.aborted === true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function normalizeError(err: unknown, timedOut: boolean, abortedOutside: boolean): AssistantStreamError {
  if (err instanceof AssistantStreamError) return err;
  if (timedOut) {
    return new AssistantStreamError("timeout", "Помощник отвечает слишком долго. Попробуйте ещё раз", true);
  }
  if (abortedOutside || (err instanceof DOMException && err.name === "AbortError")) {
    return new AssistantStreamError("aborted", "Запрос остановлен", false);
  }
  if (err instanceof TypeError) {
    return new AssistantStreamError("network", "Нет связи с сервером. Проверьте интернет и повторите", true);
  }
  const message = err instanceof Error ? err.message : "ИИ недоступен, попробуйте позже";
  return new AssistantStreamError("server", message, true);
}

async function run(
  messages: AssistantMessage[],
  onStatus: (message: string) => void,
  { onCard, onToken }: Pick<StreamAssistantOptions, "onCard" | "onToken">,
  signal: AbortSignal,
): Promise<string> {
  const doFetch = (token: string | null) =>
    fetch("/api/v1/ai/assistant", {
      method: "POST",
      credentials: "include",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": getOrCreateDeviceId(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages }),
    });

  // Запрос принадлежит той сессии, в которой отправлен (аудит 04.10.2026, CHAT01).
  // Если за время ожидания А вышел, а вошёл Б, refreshAccessToken вернёт токен Б, и
  // история А ушла бы к ассистенту с правами Б (он может создавать задачи). Тот же
  // механизм, что expectAgentId в api(): эпоха из стора, второго не заводим.
  const epoch = currentSessionEpoch();
  const assertSameSession = () => {
    if (currentSessionEpoch() !== epoch) {
      throw new AssistantStreamError("session", "Сессия сменилась — запрос не отправлен", false);
    }
  };

  let token = useAuthStore.getState().accessToken;
  let res = await doFetch(token);
  if (res.status === 401 && useAuthStore.getState().hasSession) {
    token = await refreshAccessToken();
    assertSameSession();
    if (token) res = await doFetch(token);
  }
  assertSameSession();

  if (!res.ok || !res.body) {
    // Лимитер (429), рубильник (403), неверные данные (400) — всё это обычный
    // JSON-ответ БЕЗ event-stream: заголовки SSE роут выставляет только после
    // этих проверок (routes/ai.ts).
    let message = httpStatusMessage(res.status);
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // Тело не JSON — остаётся текст по коду ответа.
    }
    // Повторять имеет смысл при сбое сервера и таймауте шлюза; 400/403/429 от повтора не изменятся.
    throw new AssistantStreamError("http", message, res.status >= 500);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply: string | null = null;
  let errorMessage: string | null = null;
  let streamed = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // Кадры SSE разделены пустой строкой.
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) continue; // строки-комментарии (": ping") и т.п.
        let data: unknown;
        try {
          data = JSON.parse(dataLine.slice("data: ".length));
        } catch {
          continue;
        }
        const event = eventLine.slice("event: ".length);
        if (event === "card") {
          if (isCard(data)) onCard?.(data);
          continue;
        }
        if (event === "token") {
          if (isToken(data)) {
            streamed = data.reset ? data.text : streamed + data.text;
            onToken?.(streamed);
          }
          continue;
        }
        const payload = data as SseData;
        if (event === "status" && payload.message) onStatus(payload.message);
        else if (event === "done") reply = payload.reply ?? "";
        else if (event === "error") errorMessage = payload.error ?? "ИИ недоступен, попробуйте позже";
      }
    }
  } finally {
    // Не дочитали (отмена/ошибка) — освобождаем соединение, а не держим его до таймаута сервера.
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Поток уже закрыт — освобождать нечего.
    }
  }

  // Ответ чужой сессии панели не отдаём (вошёл другой, пока шёл поток).
  assertSameSession();
  if (errorMessage) throw new AssistantStreamError("server", errorMessage, true);
  if (reply === null) throw new AssistantStreamError("server", "Ответ оборвался. Попробуйте ещё раз", true);
  // `done` — окончательный текст. Пустой `done` при показанных токенах (старый
  // сервер так не делает, но сверка дешёвая) — берём накопленное, а не пустоту.
  return reply || streamed;
}

function isToken(value: unknown): value is AssistantTokenEvent {
  return !!value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string";
}

function isCard(value: unknown): value is AssistantCard {
  if (!value || typeof value !== "object") return false;
  const card = value as { kind?: unknown; href?: unknown };
  return (card.kind === "property" || card.kind === "client") && typeof card.href === "string" && card.href.startsWith("/");
}
