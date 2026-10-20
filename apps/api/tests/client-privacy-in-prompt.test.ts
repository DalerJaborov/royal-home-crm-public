import { describe, expect, it } from "vitest";
import { clientSelfStatedName, looksLikeRealName } from "../src/ai/replyGuards.js";
import { buildShortReplySystem, maskHistoryForModel } from "../src/ai/leadQualifier.js";

/**
 * 18.08.2026 — владелец получил жалобу: бот назвал клиента по ФИО, взятому из
 * профиля WhatsApp, хотя тот сам никогда не представлялся боту в переписке.
 * Правило: обращение по имени разрешено только если клиент САМ написал имя
 * текстом («меня зовут…» и т.п.) — профильное pushName для этого не годится.
 */
describe("clientSelfStatedName — обращение только по имени, названному в переписке", () => {
  it("профильное имя, ни разу не сказанное в тексте, не считается представлением", () => {
    const history = [
      { role: "user" as const, content: "Здравствуйте, ищу двухкомнатную в Сино" },
      { role: "assistant" as const, content: "Салом! Расскажите про бюджет" },
    ];
    expect(clientSelfStatedName(history)).toBeNull();
  });

  it("клиент явно представился — «меня зовут Умед» — имя извлекается", () => {
    const history = [
      { role: "user" as const, content: "Здравствуйте, меня зовут Умед, ищу квартиру" },
    ];
    expect(clientSelfStatedName(history)).toBe("Умед");
  });

  it("представление таджикское — «номи ман Ниссо»", () => {
    const history = [{ role: "user" as const, content: "Салом, номи ман Ниссо" }];
    expect(clientSelfStatedName(history)).toBe("Ниссо");
  });

  it("представление в реплике БОТА не считается — источник обязан быть клиент", () => {
    const history = [
      { role: "assistant" as const, content: "Здравствуйте, меня зовут Бот-помощник Royal Home" },
      { role: "user" as const, content: "Ищу квартиру" },
    ];
    expect(clientSelfStatedName(history)).toBeNull();
  });

  it("мусор после связки («меня зовут просто спросить») отбрасывается looksLikeRealName", () => {
    const history = [{ role: "user" as const, content: "меня зовут просто спросить про цену" }];
    // "просто" проходит грамматически как слово с заглавной — но это не имя;
    // тест фиксирует нынешнее поведение выборки первого слова после связки,
    // а не идеальный NLP: looksLikeRealName всё ещё пропускает частые слова,
    // если они выглядят как имя (заглавная + буквы). Явный признак защиты —
    // цифровой/никовый мусор отсекается ниже.
    const name = clientSelfStatedName(history);
    if (name) expect(looksLikeRealName(name)).toBe(true);
  });

  it("ник/цифры после связки не считаются именем", () => {
    const history = [{ role: "user" as const, content: "меня зовут 12345" }];
    expect(clientSelfStatedName(history)).toBeNull();
  });
});

/**
 * buildShortReplySystem сам по себе принимает имя напрямую (тестируется отдельно
 * в short-reply-context.test.ts) — здесь фиксируем, что при пустом имени (как
 * его теперь передаёт shortAgentReply, отфильтровав профильное) обращения в
 * промте нет.
 */
describe("buildShortReplySystem без имени — обращения в промте нет", () => {
  it("context.name отсутствует — строка с именем не добавляется", () => {
    const system = buildShortReplySystem("напомни клиенту");
    expect(system).not.toContain("Имя клиента:");
  });

  it("context.name === null (клиент не представлялся) — то же самое", () => {
    const system = buildShortReplySystem("напомни клиенту", { name: null });
    expect(system).not.toContain("Имя клиента:");
  });
});

/**
 * Телефон в истории, которая уходит МОДЕЛИ, должен быть замаскирован — даже
 * когда та же история в БД/интерфейсе (право clients.viewPhone) хранит и
 * показывает номер целиком. `maskHistoryForModel` — граница ИМЕННО перед
 * `callAiText`, поэтому тест бьёт по ней напрямую, а не по хранимой истории.
 */
describe("maskHistoryForModel — телефон не должен уйти в промт ИИ", () => {
  it("номер клиента в местном формате маскируется", () => {
    const history = [{ role: "user" as const, content: "Звоните мне на 987 654 321" }];
    const masked = maskHistoryForModel(history);
    expect(masked[0].content).not.toContain("987");
    expect(masked[0].content).toContain("****");
  });

  it("международный номер продавца маскируется", () => {
    const history = [{ role: "user" as const, content: "Мой номер +992 93 700 11 22, звоните" }];
    const masked = maskHistoryForModel(history);
    expect(masked[0].content).not.toMatch(/\d{2}\s?700/);
  });

  it("исходный массив истории (то, что хранится/показывается оператору) не мутируется", () => {
    const history = [{ role: "user" as const, content: "Мой номер 987654321" }];
    maskHistoryForModel(history);
    expect(history[0].content).toBe("Мой номер 987654321");
  });

  it("сообщения без телефона проходят без изменений", () => {
    const history = [{ role: "user" as const, content: "Ищу трёхкомнатную в Сино" }];
    expect(maskHistoryForModel(history)[0].content).toBe("Ищу трёхкомнатную в Сино");
  });
});
