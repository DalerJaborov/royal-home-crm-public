import { describe, expect, it } from "vitest";

/**
 * Разговор, уходящий в модель, обязан заканчиваться репликой клиента.
 *
 * Anthropic отвечает 400 на историю, кончающуюся сообщением ассистента: «This
 * model does not support assistant message prefill. The conversation must end
 * with a user message». Случай не редкий, а самый обычный: напоминание молчащему
 * клиенту пишется ВСЛЕД своему же сообщению.
 *
 * 01.08.2026 это дало 657 ошибок за сутки. Claude отвергал запрос, запасной
 * Gemini упирался в квоту, и клиент вместо ответа получал заглушку «ҳозир каме
 * банд» — дважды подряд одному человеку.
 *
 * Тест проверяет саму склейку, а не сетевой вызов: логика в двух клиентах должна
 * быть одинаковой, иначе поставщики начнут отвечать по-разному на одну историю.
 */

type Msg = { role: "user" | "assistant"; content: string };

/** Та же операция, что в ai/client.ts и ai/geminiClient.ts. */
function withUserTail(messages: Msg[]): Msg[] {
  return messages.length > 0 && messages[messages.length - 1].role === "assistant"
    ? [...messages, { role: "user" as const, content: "(продолжи по задаче из системного промта)" }]
    : messages;
}

describe("хвост истории для модели", () => {
  it("после реплики бота дописывается служебная реплика клиента", () => {
    const history: Msg[] = [
      { role: "user", content: "Салом, хона даркор" },
      { role: "assistant", content: "Кадом тараф?" },
    ];
    const result = withUserTail(history);
    expect(result).toHaveLength(3);
    expect(result[result.length - 1].role).toBe("user");
  });

  it("слова бота не теряются — именно от них надо оттолкнуться", () => {
    const history: Msg[] = [{ role: "assistant", content: "Кадом тараф?" }];
    expect(withUserTail(history)[0].content).toBe("Кадом тараф?");
  });

  it("история, кончающаяся клиентом, не трогается", () => {
    const history: Msg[] = [
      { role: "assistant", content: "Кадом тараф?" },
      { role: "user", content: "Сино" },
    ];
    expect(withUserTail(history)).toEqual(history);
  });

  it("пустая история остаётся пустой, а не получает реплику из ниоткуда", () => {
    expect(withUserTail([])).toEqual([]);
  });
});
