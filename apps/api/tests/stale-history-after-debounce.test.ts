import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { waitFor } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ОТВЕТ БОТА НА ХОД A ВИДЕН МОДЕЛИ НА ХОДЕ B (ночная проверка 24.09.2026,
 * «бот и каналы» №4).
 *
 * Снимок истории снимался в начале хода, до окна склейки. Клиент пишет A; бот
 * закрывает окно и ждёт модель. Пока модель думает, клиент пишет B: его снимок
 * уже содержит реплику A (она сохранена до обращения к модели), но ещё не
 * содержит ответа бота на A — тот ложится в историю позже, пока B ждёт своё
 * окно. В промт хода B уходил старый снимок, модель не видела собственного
 * ответа на A и отвечала на A заново, другими словами; сторож дословного
 * повтора этого не ловит. Теперь после окна склейки история перечитывается.
 *
 * Модель подменена: первый ход квалификатора держится на «воротах», пока тест
 * не запустит второй ход, — так ответ на A гарантированно ложится в историю
 * ПОСЛЕ снимка хода B и ДО сборки его промта.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const runId = Date.now().toString(36);
const SUBSCRIBER = `stale-history-${runId}`;
const TEXT_A = "Ман хона мехарам, се хонагӣ";
const TEXT_B = "Нархаш чанд аст?";
/** Метка в ответе на A: защиты реплики могут срезать вводные слова, метку — нет. */
const MARK_A = `[${runId}]`;
const REPLY_A = `Се хонагӣ дар кадом ноҳия? ${MARK_A}`;
const REPLY_B = "Аз 350 000 сомонӣ.";

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Окно настоящее: ход B должен успеть снять снимок, пока A ещё ждёт модель, и
  // дождаться ответа на A внутри своего окна.
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 2, botReplyMaxWaitSec: 5 } });
  const conv = await fixture.ensureConversation(SUBSCRIBER);
  await prisma.botConversation.update({ where: { id: conv.id }, data: { messages: [], leadDraft: { stage: "chatting" } } });
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.dispose();
});

type PromptMessage = { role: string; content: string };

describe("Два хода подряд: второй начинается, пока первый ждёт модель", () => {
  it("в промте хода B есть ответ бота на ход A", async () => {
    const qualifyPrompts: PromptMessage[][] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    callAi.mockReset();
    callAi.mockImplementation(async (params: { endpoint?: string; messages?: PromptMessage[] }) => {
      if (params?.endpoint !== "lead-qualify") return {};
      qualifyPrompts.push(params.messages ?? []);
      if (qualifyPrompts.length === 1) {
        await gateA;
        return { reply: [REPLY_A], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false };
      }
      return { reply: [REPLY_B], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false };
    });

    const turnA = processMessengerTurn({ ...fixture.turnInput(SUBSCRIBER), text: TEXT_A });
    // Ход A закрыл окно и сохранил свою реплику — и стоит у модели на «воротах».
    await waitFor(
      async () => {
        const conv = await prisma.botConversation.findFirst({
          where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId: SUBSCRIBER },
          select: { messages: true },
        });
        const messages = (Array.isArray(conv?.messages) ? conv!.messages : []) as PromptMessage[];
        return messages.some((m) => m.role === "user" && m.content === TEXT_A);
      },
      { timeoutMs: 8_000, label: "реплика A в переписке" }
    );
    await waitFor(() => qualifyPrompts.length >= 1, { timeoutMs: 8_000, label: "ход A дошёл до модели" });

    // Ход B снимает снимок истории сейчас: реплика A там уже есть, ответа на A ещё нет.
    const turnB = processMessengerTurn({ ...fixture.turnInput(SUBSCRIBER), text: TEXT_B });
    await new Promise((r) => setTimeout(r, 300));
    // Открываем ворота: ответ на A ложится в историю, пока B ждёт своё окно.
    releaseA();
    const resultA = await turnA;
    expect(resultA.reply).toContain(MARK_A);

    const resultB = await turnB;
    expect(resultB.shouldReply).not.toBe(false);
    expect(qualifyPrompts.length).toBe(2);

    const promptB = qualifyPrompts[1];
    // Без починки: промт B собран из снимка с входа, ответа бота на A в нём нет —
    // модель отвечает на A заново.
    expect(promptB.some((m) => m.role === "assistant" && m.content.includes(MARK_A))).toBe(true);
    // Порядок сохранён: сначала A и ответ на A, последней — реплика B.
    const last = promptB[promptB.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain(TEXT_B);
    // И реплика B в промте одна, не задвоена перечитыванием.
    expect(promptB.filter((m) => m.role === "user" && m.content.includes(TEXT_B))).toHaveLength(1);
  });
});
