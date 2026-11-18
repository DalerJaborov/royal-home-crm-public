import type { ConversationMessage } from "../types";

/**
 * БЫСТРЫЕ ОТВЕТЫ над полем ввода — одна дверь для обоих видов переписки
 * (телефонный MobileChatView и «Новый вид» инбокса, 18.11.2026).
 *
 * Словаря шаблонов в API нет — ни эндпоинта, ни таблицы. Придумывать фразы за
 * агента нельзя, поэтому лента собирается из ТОГО, ЧТО ЛЮДИ УЖЕ ПИСАЛИ РУКАМИ в
 * этом диалоге: три последние короткие реплики живого человека (агент из CRM
 * или ответ вручную из мессенджера), без повторов. Реплики бота не берутся —
 * их и так шлёт бот. Нечего показать — пустой список, ленты нет вовсе.
 *
 * Ничего не запрашивает: работает по уже загруженной переписке.
 */
export function chatQuickReplies(messages: readonly ConversationMessage[], limit = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (m.by?.kind !== "agent" && m.by?.kind !== "manual") continue;
    const t = m.content.trim();
    // Длинные ответы в чип не помещаются и обрезкой теряют смысл.
    if (!t || t.length > 80) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
