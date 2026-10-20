import { refreshAccessToken } from "./api";
import { getOrCreateDeviceId } from "./deviceId";
import { httpStatusMessage } from "./httpStatusMessage";
import { currentSessionEpoch } from "./sessionGuard";
import { useAuthStore } from "../store/auth";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
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
 */
export async function streamAssistant(messages: AssistantMessage[], onStatus: (message: string) => void): Promise<string> {
  const doFetch = (token: string | null) =>
    fetch("/api/v1/ai/assistant", {
      method: "POST",
      credentials: "include",
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
    if (currentSessionEpoch() !== epoch) throw new Error("Сессия сменилась — запрос не отправлен");
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
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply: string | null = null;
  let errorMessage: string | null = null;

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
      let data: { message?: string; reply?: string; error?: string };
      try {
        data = JSON.parse(dataLine.slice("data: ".length));
      } catch {
        continue;
      }
      const event = eventLine.slice("event: ".length);
      if (event === "status" && data.message) onStatus(data.message);
      else if (event === "done") reply = data.reply ?? "";
      else if (event === "error") errorMessage = data.error ?? "ИИ недоступен, попробуйте позже";
    }
  }

  // Ответ чужой сессии панели не отдаём (вошёл другой, пока шёл поток).
  assertSameSession();
  if (errorMessage) throw new Error(errorMessage);
  if (reply === null) throw new Error("ИИ недоступен, попробуйте позже");
  return reply;
}
