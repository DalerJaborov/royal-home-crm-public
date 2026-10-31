import { useAuthStore } from "../store/auth";
import type { AssistantMessage } from "./assistantStream";

/**
 * ИСТОРИЯ ДИАЛОГА С ПОМОЩНИКОМ В `sessionStorage` (31.10.2026, аудит п. 12).
 *
 * Раньше история жила в `useState` панели и пропадала при каждом закрытии: человек
 * спрашивал, переходил по ссылке из ответа (панель закрывается) и возвращался к
 * пустому окну. `sessionStorage`, а не `localStorage`: диалог относится к открытой
 * вкладке и не должен пережить закрытие браузера на общем компьютере. Ключ несёт
 * id сотрудника — в одной вкладке вошёл другой человек, чужой разговор ему не
 * показываем (тот же класс, что эпоха сессии в assistantStream.ts).
 *
 * Хранилище может не работать (приватное окно, запрет сайта, переполнение) —
 * каждый доступ в try/catch, без него панель просто начинает с пустой переписки.
 * Карточки результата не сохраняются: это ответ на момент вопроса, а не история.
 */
const KEY_PREFIX = "rh.assistant.history.v1:";
/** Сервер принимает до 30 реплик за запрос; хранить больше окна нет смысла. */
const MAX_STORED = 30;

function storageKey(): string | null {
  const agentId = useAuthStore.getState().agent?.id;
  return agentId ? `${KEY_PREFIX}${agentId}` : null;
}

function isMessage(value: unknown): value is AssistantMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as { role?: unknown; content?: unknown };
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0;
}

export function loadAssistantHistory(): AssistantMessage[] {
  try {
    const key = storageKey();
    if (!key) return [];
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isMessage).slice(-MAX_STORED) : [];
  } catch {
    return [];
  }
}

export function saveAssistantHistory(messages: AssistantMessage[]): void {
  try {
    const key = storageKey();
    if (!key) return;
    if (messages.length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(messages.slice(-MAX_STORED)));
  } catch {
    // Хранилище недоступно — диалог просто не переживёт закрытие панели.
  }
}
