import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { runCommentNeedsHumanSweep, commentTag, plainCommentReason, commentNeed } = await import("../src/lib/commentWaitingAlert.js");

/**
 * КОММЕНТАРИЙ БЕЗ ОТВЕТА БОТА — ЧЕЛОВЕКУ (15.11.2026). Живой случай: 14.11 новое
 * ядро не ответило на комментарий в Instagram (FAILED,
 * `unsupported_decision_evidence`) — ни одного уведомления, человек под постом
 * ждал. Старый путь комментариев звал человека сам, новое ядро — нет.
 */

const runId = Date.now().toString(36);
const now = new Date();
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
let staffId = "";
const ids: string[] = [];

async function comment(status: string, opts: { note?: string; updatedMinAgo?: number; createdMinAgo?: number; channel?: string } = {}) {
  const commentId = `c-${runId}-${ids.length}`;
  ids.push(commentId);
  await prisma.instagramComment.create({
    data: { commentId, mediaId: `media-${runId}`, authorId: `a-${runId}`, authorName: "client_tj", text: "Нарх чанд?",
      replyDueAt: minutesAgo(30), status, note: opts.note ?? null, createdAt: minutesAgo(opts.createdMinAgo ?? 30), channel: opts.channel ?? "INSTAGRAM" },
  });
  // updatedAt ставит Prisma сама — двигаем в прошлое напрямую.
  await prisma.$executeRaw`UPDATE "InstagramComment" SET "updatedAt"=${minutesAgo(opts.updatedMinAgo ?? 10)} WHERE "commentId"=${commentId}`;
  return commentId;
}
const pushesFor = (commentId: string) => sendPushToAgents.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === commentTag(commentId));
/** Пуши этого тика про эти комментарии: сводка или одиночный пуш с их тегом. */
const summariesWith = (commentIds: string[]) => sendPushToAgents.mock.calls.filter(([, p]) => {
  const tag = (p as { tag?: string }).tag;
  return tag === "comments-need-human" || commentIds.some((id) => tag === commentTag(id));
});

beforeAll(async () => {
  staffId = (
    await prisma.agent.create({
      data: { fullName: `Читает комментарии ${runId}`, phone: `+99295${String(Date.now()).slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
});
beforeEach(() => sendPushToAgents.mockClear());
afterAll(async () => {
  await prisma.processedMessage.deleteMany({ where: { messageId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { tag: { in: ids.map(commentTag) } } });
  await prisma.instagramComment.deleteMany({ where: { commentId: { in: ids } } });
  await prisma.agent.delete({ where: { id: staffId } }).catch(() => {});
});

describe("runCommentNeedsHumanSweep", () => {
  it("FAILED ядра — пуш людям с правом «Сообщения», один раз", async () => {
    const id = await comment("FAILED", { note: "managed_core:failed:unsupported_decision_evidence" });
    await runCommentNeedsHumanSweep(now);
    const pushes = pushesFor(id);
    expect(pushes).toHaveLength(1);
    const [recipients, payload] = pushes[0]! as [string[], { title: string; body: string; kind: string }];
    expect(recipients).toContain(staffId);
    expect(payload.kind).toBe("message");
    expect(payload.title).toContain("ответьте на комментарий вручную");
    expect(payload.body).toContain("Нарх чанд?");
    expect(payload.body).not.toContain("unsupported_decision_evidence"); // служебные коды сотрудникам не показываем
    sendPushToAgents.mockClear();
    await runCommentNeedsHumanSweep(now);
    expect(pushesFor(id)).toHaveLength(0);
  });

  it("ESCALATED ядра (модерация) — тоже человеку, своими словами", async () => {
    const id = await comment("ESCALATED", { note: "managed_core:moderation_hide_spam" });
    await runCommentNeedsHumanSweep(now);
    expect(pushesFor(id)).toHaveLength(1);
    expect(plainCommentReason("ESCALATED", "managed_core:moderation_hide_spam")).toContain("скрывать");
  });

  it("старый путь уже позвал человека (уведомление с тем же тегом) — второго пуша нет", async () => {
    const id = await comment("ESCALATED");
    await prisma.notification.create({ data: { agentId: staffId, kind: "message", title: "💬 Instagram: бот не знает ответа", body: "x", tag: commentTag(id) } });
    await runCommentNeedsHumanSweep(now);
    expect(pushesFor(id)).toHaveLength(0);
  });

  it("ответ дан, слишком свежо или слишком давно — молчим", async () => {
    const replied = await comment("REPLIED");
    const fresh = await comment("FAILED", { updatedMinAgo: 1 });
    const stale = await comment("FAILED", { updatedMinAgo: 60 * 30 });
    await runCommentNeedsHumanSweep(now);
    for (const id of [replied, fresh, stale]) expect(pushesFor(id)).toHaveLength(0);
  });

  it("В2 (15.11): удалённый комментарий, спам и ответ сотрудника — человека не зовём", async () => {
    const quiet = [
      await comment("FAILED", { note: "gone" }),
      await comment("FAILED", { note: "spam: ссылка; hide:gone" }),
      await comment("FAILED", { note: "manual_reply_unknown" }),
      await comment("SKIPPED", { note: "bot_off" }),
    ];
    await runCommentNeedsHumanSweep(now);
    for (const id of quiet) expect(pushesFor(id), id).toHaveLength(0);
    expect(summariesWith(quiet)).toHaveLength(0);
    expect(commentNeed("ESCALATED", "x; gone")).toBe("no");
  });

  it("В2 (15.11): ИИ недоступен после повторов и технические отказы ядра — теперь человеку (решение 30.08 отменено)", async () => {
    const technical = [
      await comment("FAILED", { note: "ai_down" }),
      await comment("FAILED", { note: "managed_core:failed:public_core_unavailable" }),
      await comment("FAILED", { note: "managed_core:failed:expired;first=managed_core:failed:turn_unavailable" }),
      await comment("FAILED", { note: "managed_core:failed:turn_deadline" }),
    ];
    await runCommentNeedsHumanSweep(now);
    const summaries = summariesWith(technical);
    expect(summaries).toHaveLength(1);
    expect((summaries[0]![1] as { title: string }).title).toMatch(/4 комментариев ждут ответа/);
    expect(commentNeed("FAILED", "ai_down")).toBe("technical");
    expect(commentNeed("FAILED", "что-то новое")).toBe("human"); // незнакомый код по умолчанию зовёт человека
    expect(commentNeed("FAILED", "no_answer")).toBe("human");
    expect(plainCommentReason("FAILED", "ai_down")).toContain("ИИ был недоступен");
  });

  it("В2 (15.11): комментарий застрял в очереди дольше 30 минут — человеку; свежий в очереди — нет", async () => {
    const stuck = await comment("PENDING", { createdMinAgo: 45 });
    const working = await comment("WORKING", { createdMinAgo: 90 });
    const fresh = await comment("PENDING", { createdMinAgo: 5 });
    await runCommentNeedsHumanSweep(now);
    expect(summariesWith([stuck, working])).toHaveLength(1);
    expect(await prisma.processedMessage.count({ where: { channel: "comment-needs-human", messageId: { in: [stuck, working] } } })).toBe(2);
    expect(await prisma.processedMessage.count({ where: { channel: "comment-needs-human", messageId: fresh } })).toBe(0);
    expect(plainCommentReason("PENDING", null)).toContain("полчаса");
  });

  it("рубильник выключен — технические отказы и застрявшие не зовём и не отмечаем; передачу человеку (ESCALATED) — зовём", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { commentFailureWatchEnabled: false } });
    try {
      const tech = await comment("FAILED", { note: "ai_down" });
      const stuck = await comment("PENDING", { createdMinAgo: 60 });
      const escalated = await comment("ESCALATED", { note: "Спросили про рассрочку" });
      await runCommentNeedsHumanSweep(now);
      expect(pushesFor(escalated)).toHaveLength(1);
      expect(summariesWith([tech, stuck])).toHaveLength(0);
      expect(await prisma.processedMessage.count({ where: { channel: "comment-needs-human", messageId: { in: [tech, stuck] } } })).toBe(0);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { commentFailureWatchEnabled: true } });
    }
  });

  it("197-1: рубильник выключен и техотказов больше предела выборки — передача человеку (ESCALATED) всё равно доходит за один тик", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { commentFailureWatchEnabled: false } });
    try {
      // Пачка техотказов старше ESCALATED: при сортировке по времени они стояли бы первыми и съедали предел 50.
      for (let i = 0; i < 55; i++) await comment("FAILED", { note: "managed_core:failed:turn_unavailable", updatedMinAgo: 120 });
      const escalated = await comment("ESCALATED", { note: "Спросили про рассрочку", updatedMinAgo: 10 });
      await runCommentNeedsHumanSweep(now);
      expect(pushesFor(escalated)).toHaveLength(1);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { commentFailureWatchEnabled: true } });
      // Техотказы этого теста — не мешать следующим.
      await prisma.processedMessage.createMany({ data: ids.map((id) => ({ channel: "comment-needs-human", messageId: id, completedAt: new Date() })), skipDuplicates: true });
    }
  });

  it("197-4: застрявшие YouTube и групп Telegram не судим (свои очереди); общий ползунок «Отвечать на комментарии» выключен — тоже", async () => {
    const yt = await comment("PENDING", { createdMinAgo: 60, channel: "YOUTUBE" });
    const tg = await comment("PENDING", { createdMinAgo: 60, channel: "TELEGRAM" });
    await runCommentNeedsHumanSweep(now);
    expect(await prisma.processedMessage.count({ where: { channel: "comment-needs-human", messageId: { in: [yt, tg] } } })).toBe(0);
    const saved = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanAnswerComments: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanAnswerComments: false } });
    try {
      const ig = await comment("PENDING", { createdMinAgo: 60 });
      await runCommentNeedsHumanSweep(now);
      expect(await prisma.processedMessage.count({ where: { channel: "comment-needs-human", messageId: ig } })).toBe(0);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    }
  });

  it("197-2: список техотказов — один с ядром; «не смог подтвердить данными» зовёт человека и при выключенном рубильнике", () => {
    expect(commentNeed("FAILED", "managed_core:failed:unsupported_decision_evidence")).toBe("human");
    expect(commentNeed("FAILED", "managed_core:failed:round_limit")).toBe("technical");
  });

  it("192-6: много комментариев за тик — одна сводка, а не пуш на каждый", async () => {
    const many: string[] = [];
    for (let i = 0; i < 4; i++) many.push(await comment("ESCALATED", { note: "managed_core:moderation_hide_spam" }));
    await runCommentNeedsHumanSweep(now);
    const summaries = sendPushToAgents.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === "comments-need-human");
    expect(summaries).toHaveLength(1);
    expect((summaries[0]![1] as { title: string }).title).toMatch(/\d+ комментариев ждут ответа/);
    for (const id of many) expect(pushesFor(id)).toHaveLength(0);
  });

  it("пуш не ушёл — отметка снята, следующий тик пробует снова", async () => {
    const id = await comment("FAILED", { note: "no_answer" });
    sendPushToAgents.mockImplementationOnce(async () => { throw new Error("push down"); });
    await runCommentNeedsHumanSweep(now);
    expect(await prisma.processedMessage.count({ where: { channel: "comment-needs-human", messageId: id } })).toBe(0);
    await runCommentNeedsHumanSweep(now);
    const again = sendPushToAgents.mock.calls.filter(([, p]) => [commentTag(id), "comments-need-human"].includes(String((p as { tag?: string }).tag)));
    expect(again.length).toBeGreaterThanOrEqual(1);
  });
});
