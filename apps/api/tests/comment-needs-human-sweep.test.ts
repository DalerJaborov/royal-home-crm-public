import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { runCommentNeedsHumanSweep, commentTag, plainCommentReason } = await import("../src/lib/commentWaitingAlert.js");

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

async function comment(status: string, opts: { note?: string; updatedMinAgo?: number } = {}) {
  const commentId = `c-${runId}-${ids.length}`;
  ids.push(commentId);
  await prisma.instagramComment.create({
    data: { commentId, mediaId: `media-${runId}`, authorId: `a-${runId}`, authorName: "client_tj", text: "Нарх чанд?",
      replyDueAt: minutesAgo(30), status, note: opts.note ?? null },
  });
  // updatedAt ставит Prisma сама — двигаем в прошлое напрямую.
  await prisma.$executeRaw`UPDATE "InstagramComment" SET "updatedAt"=${minutesAgo(opts.updatedMinAgo ?? 10)} WHERE "commentId"=${commentId}`;
  return commentId;
}
const pushesFor = (commentId: string) => sendPushToAgents.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === commentTag(commentId));

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

  it("пуш не ушёл — отметка снята, следующий тик пробует снова", async () => {
    const id = await comment("FAILED");
    sendPushToAgents.mockImplementationOnce(async () => { throw new Error("push down"); });
    await runCommentNeedsHumanSweep(now);
    expect(await prisma.processedMessage.count({ where: { channel: "comment-needs-human", messageId: id } })).toBe(0);
    await runCommentNeedsHumanSweep(now);
    expect(pushesFor(id).length).toBeGreaterThanOrEqual(1);
  });
});
