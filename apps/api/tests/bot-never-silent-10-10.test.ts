import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * БОТ НЕ МОЛЧИТ ИЗ-ЗА СВОИХ ЖЕ ФИЛЬТРОВ (аудит ботов 10.10.2026, P0-1,
 * docs/audit-bots-2026-10-10-real-failures.md).
 *
 * За 30 дней: 84 хода «ответ целиком вычистили наши проверки», 99 — «повтор
 * дословно, не отправлен», и клиенту не уходило ничего. Здесь — каждый путь
 * messengers/replyChain.ts::finalizeBotReply:
 *  - стражи съели ответ → второй ход модели с поправкой, его текст уходит;
 *  - второй ход тоже пуст/съеден → короткая нейтральная реплика, а не тишина и
 *    не заглушка «нужно больше времени»;
 *  - дословный повтор → не молчим, и нейтральная реплика ДРУГАЯ, чем недавние;
 *  - щит исходящих не выпустил бы повтор → то же, что повтор;
 *  - все заготовки уже звучали (петля) → молчим с громкой записью;
 *  - модель сама ничего не сказала → прежняя заглушка, без второго хода.
 */

const { logSystemError, guardFired } = vi.hoisted(() => ({ logSystemError: vi.fn(), guardFired: vi.fn() }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));
vi.mock("../src/ai/guardMetrics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/guardMetrics.js")>()),
  guardFired,
}));

const { finalizeBotReply, NEUTRAL_REPLIES, FALLBACK_AI_DOWN, neutralKindFor } = await import(
  "../src/messengers/replyChain.js"
);
const { MAX_PHONE_ASKS } = await import("../src/ai/replyRepeatGuard.js");
type Input = Parameters<typeof finalizeBotReply>[0];

const PHONE_ASK_RU = "Оставьте, пожалуйста, ваш номер телефона, и агент вам позвонит.";
const LAST_BOT = "Квартира трёхкомнатная, 75 метров, цена 920 000 сомони.";

/** Русский покупатель, бот уже исчерпал просьбы номера — любая просьба номера вырезается. */
function input(over: Partial<Input> = {}): Input {
  return {
    reply: [PHONE_ASK_RU],
    conversationId: "conv-never-silent",
    channelLabel: "INSTAGRAM",
    openUrl: "/messages?open=conv-never-silent",
    botSpokeBefore: true,
    botSaidBefore: [PHONE_ASK_RU, LAST_BOT],
    clientSaidTrusted: "Здравствуйте, ищу трёхкомнатную квартиру в центре",
    clientTurnText: "Здравствуйте, скажите пожалуйста, а торг возможен?",
    previousBotText: LAST_BOT,
    language: "ru",
    draft: { intent: "buy", stage: "chatting" },
    jobConversation: false,
    phoneAsksSent: MAX_PHONE_ASKS,
    phoneKnown: false,
    fallbackLanguageWords: ["Здравствуйте, скажите пожалуйста, а торг возможен?"],
    ...over,
  };
}

const logged = (): string => logSystemError.mock.calls.map((c) => String(c[1])).join("\n");
const fired = (name: string): boolean => guardFired.mock.calls.some((c) => c[0] === name);

beforeEach(() => {
  logSystemError.mockReset();
  guardFired.mockReset();
});

describe("ответ целиком съели фильтры", () => {
  it("второй ход модели с поправкой — его текст уходит клиенту", async () => {
    const regenerate = vi.fn(async (_directive: string) => ["Торг обсуждается с собственником при просмотре."]);
    const out = await finalizeBotReply(input(), { regenerate });

    expect(regenerate).toHaveBeenCalledTimes(1);
    const directive = regenerate.mock.calls[0][0];
    expect(directive).toMatch(/ПОВТОРНАЯ ПОПЫТКА/);
    expect(directive).toMatch(/не проси номер/);
    // Модель видит, какой вариант отвергнут, — иначе вернёт его же.
    expect(directive).toContain(PHONE_ASK_RU.slice(0, 30));
    expect(out.recovery).toBe("regenerated");
    expect(out.bubbles).toHaveLength(1);
    expect(out.bubbles[0]).toMatch(/^Торг обсуждается с собственником при просмотре/);
    expect(fired("reply_regenerated")).toBe(true);
  });

  it("второй ход тоже съеден — нейтральная реплика на языке клиента, не тишина и не «нужно больше времени»", async () => {
    const regenerate = vi.fn(async () => [PHONE_ASK_RU]);
    const out = await finalizeBotReply(input(), { regenerate });

    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(out.recovery).toBe("neutral");
    expect(out.bubbles).toEqual([NEUTRAL_REPLIES.question.ru]);
    expect(out.bubbles[0]).not.toBe(FALLBACK_AI_DOWN.ru);
    expect(fired("reply_neutral_fallback")).toBe(true);
    expect(logged()).toMatch(/нейтральная реплика вместо молчания/);
  });

  it("второй ход вернул пустоту — тоже нейтральная реплика, а не заглушка про сбой ИИ", async () => {
    const out = await finalizeBotReply(input(), { regenerate: async () => [] });
    expect(out.recovery).toBe("neutral");
    expect(out.bubbles[0]).not.toMatch(/больше времени/);
  });

  it("второй ход упал исключением — нейтральная реплика, ход не роняется", async () => {
    const out = await finalizeBotReply(input(), {
      regenerate: async () => {
        throw new Error("Gemini HTTP 503");
      },
    });
    expect(out.recovery).toBe("neutral");
    expect(out.bubbles).toHaveLength(1);
  });

  it("канал без повтора хода (Telegram) — сразу нейтральная реплика по-таджикски таджику", async () => {
    const out = await finalizeBotReply(
      input({
        reply: ["Рақами телефонатонро нависед, то агент занг занад."],
        botSaidBefore: ["Рақами телефонатонро нависед."],
        clientTurnText: "Салом",
        fallbackLanguageWords: ["Салом", "Хона дар Сино мехарам"],
        language: "tg",
      })
    );
    expect(out.recovery).toBe("neutral");
    expect(out.bubbles).toEqual([NEUTRAL_REPLIES.presence.tg]);
  });
});

describe("дословный повтор — не молчим, и заготовка другая", () => {
  it("модель повторила свою прошлую реплику — уходит не повтор, а нейтральная реплика", async () => {
    const out = await finalizeBotReply(
      input({ reply: [LAST_BOT], phoneAsksSent: 0, botSaidBefore: [LAST_BOT], clientTurnText: "Хорошо, после двух часов подойду, спасибо" })
    );
    expect(out.recovery).toBe("neutral");
    expect(out.bubbles).toHaveLength(1);
    expect(out.bubbles[0]).not.toBe(LAST_BOT);
    expect(out.bubbles[0]).toBe(NEUTRAL_REPLIES.statement.ru);
  });

  it("предпочтительная заготовка звучала недавно — берётся другая, а не повтор заготовки", async () => {
    const out = await finalizeBotReply(
      input({
        reply: [LAST_BOT],
        phoneAsksSent: 0,
        botSaidBefore: [NEUTRAL_REPLIES.question.ru, LAST_BOT],
      })
    );
    expect(out.recovery).toBe("neutral");
    expect(out.bubbles[0]).not.toBe(NEUTRAL_REPLIES.question.ru);
    expect(out.bubbles[0]).not.toBe(LAST_BOT);
  });

  it("все заготовки уже звучали — петля: молчим и зовём живого сотрудника", async () => {
    const out = await finalizeBotReply(
      input({
        reply: [LAST_BOT],
        phoneAsksSent: 0,
        botSaidBefore: [NEUTRAL_REPLIES.presence.ru, NEUTRAL_REPLIES.question.ru, NEUTRAL_REPLIES.statement.ru, LAST_BOT],
      })
    );
    expect(out.recovery).toBe("silent_loop");
    expect(out.bubbles).toEqual([]);
    expect(logged()).toMatch(/Нужен живой сотрудник/);
  });
});

describe("щит исходящих спрашиваем заранее", () => {
  it("щит не выпустил бы ответ (третий повтор за сутки) — уходит другая реплика, а не блок на транспорте", async () => {
    const answer = "Эта квартира ещё свободна, показ можем устроить сегодня вечером.";
    // Нормализация ответа срезает точку в конце — сверяем по смыслу, как сам щит.
    const shieldBlocked = vi.fn(async (bubbles: string[]) => bubbles.filter((b) => answer.startsWith(b)));
    const out = await finalizeBotReply(input({ reply: [answer], phoneAsksSent: 0, botSaidBefore: [] }), { shieldBlocked });
    expect(out.recovery).toBe("neutral");
    expect(out.bubbles).toHaveLength(1);
    expect(out.bubbles[0]).not.toBe(answer);
  });

  it("щит молчит — ответ уходит как есть, второй ход модели не зовётся", async () => {
    const regenerate = vi.fn();
    const out = await finalizeBotReply(input({ reply: ["Да, торг возможен."], phoneAsksSent: 0 }), {
      regenerate,
      shieldBlocked: async () => [],
    });
    expect(out.recovery).toBe("none");
    expect(out.bubbles).toEqual(["Да, торг возможен"]);
    expect(regenerate).not.toHaveBeenCalled();
  });
});

describe("прежнее поведение, которое не меняется", () => {
  it("модель сама ничего не сказала — заглушка про задержку, второго хода нет", async () => {
    const regenerate = vi.fn();
    const out = await finalizeBotReply(input({ reply: [], phoneAsksSent: 0 }), { regenerate });
    expect(regenerate).not.toHaveBeenCalled();
    expect(out.recovery).toBe("none");
    expect(out.bubbles).toEqual([FALLBACK_AI_DOWN.ru]);
  });

  it("род сообщения клиента выбирает заготовку", () => {
    expect(neutralKindFor("Алло")).toBe("presence");
    expect(neutralKindFor("Салом")).toBe("presence");
    expect(neutralKindFor("Нархаш чанд?")).toBe("question");
    expect(neutralKindFor("сколько стоит")).toBe("question");
    expect(neutralKindFor("подвал, ещё два этажа есть")).toBe("statement");
    expect(neutralKindFor("Майлаш, баъдтар")).toBe("statement");
    expect(neutralKindFor("Ассалому алейкум")).toBe("presence");
  });
});
