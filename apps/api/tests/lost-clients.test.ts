import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { learnedRulesBlock } from "../src/lib/botLessons.js";
import { LOST_LESSON_KIND, findLostCandidates } from "../src/lib/lostConversations.js";

/**
 * Разбор переписок с плохим исходом.
 *
 * Два риска, и оба дорогие.
 *
 * Первый — нагрести лишнего. Каждый лишний кандидат это лишний вызов ИИ (деньги) и
 * лишняя строка мусора в сводке владельцу. Поэтому больше всего проверок на то, кто
 * в разбор НЕ попадает: диалог с заявкой, свежий, короткий, взятый живым сотрудником.
 *
 * Второй, главный — чтобы догадка из слабого сигнала сама уехала в промт бота.
 * Предложения заводятся выключенными; тест держит это требование зубами.
 *
 * ИИ здесь не вызывается нарочно: отбор кандидатов — чистая работа с базой, и
 * проверять его надо без сети и без счёта за токены.
 */

const runId = Date.now().toString(36);
const NOW = new Date("2026-07-20T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
/** Разговор считается мёртвым после 36 часов тишины — берём с запасом. */
const DEAD = new Date(NOW.getTime() - 60 * HOUR);
const FRESH = new Date(NOW.getTime() - 2 * HOUR);

const conversationIds: string[] = [];
const lessonIds: string[] = [];
let clientId = "";

interface ConvOptions {
  clientMessages?: number;
  lastMessageAt?: Date;
  followUpsSent?: number;
  optedOutAt?: Date | null;
  pausedUntil?: Date | null;
  withClient?: boolean;
}

async function makeConversation(tag: string, options: ConvOptions = {}): Promise<string> {
  const count = options.clientMessages ?? 2;
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "user", content: `клиент-${runId}-${tag} реплика ${i + 1}` });
    messages.push({ role: "assistant", content: `бот-${runId}-${tag} ответ ${i + 1}` });
  }
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      // Уникальный подписчик на прогон: база общая с другими наборами тестов.
      subscriberId: `lost-${runId}-${tag}`,
      messages: messages as never,
      leadDraft: { stage: "chatting" } as never,
      lastMessageAt: options.lastMessageAt ?? DEAD,
      followUpsSent: options.followUpsSent ?? 0,
      optedOutAt: options.optedOutAt ?? null,
      pausedUntil: options.pausedUntil ?? null,
      clientId: options.withClient ? clientId : null,
    },
  });
  conversationIds.push(conv.id);
  return conv.id;
}

beforeAll(async () => {
  const client = await prisma.client.create({
    data: {
      fullName: `Тестовый клиент ${runId}`,
      phone: `+99290${runId.slice(-7).padStart(7, "0")}`,
      source: "INSTAGRAM",
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.lostConversation.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.botLesson.deleteMany({ where: { id: { in: lessonIds } } });
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
});

describe("кого разбираем", () => {
  it("замолчавший без заявки попадает в разбор", async () => {
    const id = await makeConversation("silent");
    const found = await findLostCandidates(NOW, 500);
    const mine = found.find((c) => c.conversationId === id);
    expect(mine).toBeDefined();
    expect(mine!.reason).toBe("silent");
    expect(mine!.clientMessages).toBe(2);
    // Первоисточник для владельца: последняя реплика каждой стороны.
    expect(mine!.lastClientMessage).toContain("реплика 2");
    expect(mine!.lastBotMessage).toContain("ответ 2");
  });

  it("исчерпанные напоминания и просьба не писать различаются причиной", async () => {
    const exhausted = await makeConversation("exhausted", { followUpsSent: 3 });
    const optedOut = await makeConversation("optout", { optedOutAt: DEAD, followUpsSent: 1 });
    const found = await findLostCandidates(NOW, 500);
    expect(found.find((c) => c.conversationId === exhausted)?.reason).toBe("follow_ups_exhausted");
    // Прямой отказ важнее счётчика напоминаний — проверяем именно приоритет.
    expect(found.find((c) => c.conversationId === optedOut)?.reason).toBe("opted_out");
  });
});

describe("кого НЕ разбираем — тут дороже всего ошибиться", () => {
  it("диалог с заявкой не разбирается: компания получила своё", async () => {
    const id = await makeConversation("won", { withClient: true });
    const found = await findLostCandidates(NOW, 500);
    expect(found.some((c) => c.conversationId === id)).toBe(false);
  });

  it("свежий диалог не разбирается: человек может ответить через час", async () => {
    const id = await makeConversation("fresh", { lastMessageAt: FRESH });
    const found = await findLostCandidates(NOW, 500);
    expect(found.some((c) => c.conversationId === id)).toBe(false);
  });

  it("одна реплика клиента — не разговор, а случайный тык", async () => {
    const id = await makeConversation("short", { clientMessages: 1 });
    const found = await findLostCandidates(NOW, 500);
    expect(found.some((c) => c.conversationId === id)).toBe(false);
  });

  it("диалог, который забрал живой сотрудник, — не провал бота", async () => {
    const id = await makeConversation("paused", { pausedUntil: DEAD });
    const found = await findLostCandidates(NOW, 500);
    expect(found.some((c) => c.conversationId === id)).toBe(false);
  });

  it("уже разобранный второй раз не берётся — иначе платили бы за него каждую ночь", async () => {
    const id = await makeConversation("once");
    expect((await findLostCandidates(NOW, 500)).some((c) => c.conversationId === id)).toBe(true);
    await prisma.lostConversation.create({
      data: {
        conversationId: id,
        channel: "INSTAGRAM",
        reason: "silent",
        stage: "budget",
        lastMessageAt: DEAD,
        clientMessages: 2,
        followUpsSent: 0,
        finding: `находка-${runId}`,
        suggestion: "",
        botMessage: "бот сказал",
        clientMessage: "клиент сказал",
      },
    });
    expect((await findLostCandidates(NOW, 500)).some((c) => c.conversationId === id)).toBe(false);
  });

  it("потолок за прогон соблюдается — счёт за ИИ не должен быть сюрпризом", async () => {
    const found = await findLostCandidates(NOW, 2);
    expect(found.length).toBeLessThanOrEqual(2);
  });
});

describe("предложение из сводки не попадает в промт само", () => {
  const marker = `предложение-из-сводки-${runId}`;

  it("выключенное предложение бот не видит", async () => {
    const proposal = await prisma.botLesson.create({
      data: {
        kind: LOST_LESSON_KIND,
        channel: "ALL",
        botMessage: "Разбор оборванных переписок за неделю",
        humanMessage: "Номер не оставил никто из них",
        lesson: marker,
        // Ровно то, ради чего всё затевалось: слабый сигнал не учит бота сам.
        active: false,
      },
    });
    lessonIds.push(proposal.id);
    const block = await learnedRulesBlock();
    expect(block).not.toContain(marker);
  });

  it("после того как владелец включил — становится обычным действующим правилом", async () => {
    await prisma.botLesson.updateMany({ where: { id: { in: lessonIds } }, data: { active: true } });
    const block = await learnedRulesBlock();
    expect(block).toContain(marker);
  });
});
