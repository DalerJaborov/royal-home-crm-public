import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: [] as { path: string; opts?: { method?: string; body?: unknown } }[], replies: new Map<string, unknown>() }));
vi.mock("../../lib/api", () => ({
  api: vi.fn(async (path: string, opts?: { method?: string; body?: unknown }) => {
    calls.list.push({ path, opts });
    const key = path.split("?")[0];
    if (calls.replies.has(path)) return calls.replies.get(path);
    if (calls.replies.has(key)) return calls.replies.get(key);
    return undefined;
  }),
}));
vi.mock("../../lib/permissions", () => ({ useCan: () => () => true }));
vi.mock("../../store/auth", () => ({ useAuthStore: () => "DIRECTOR" }));

import {
  byAge, enabledInboxQueues, formatAge, loadBotAudit, loadClips, loadComments, loadEditor, loadStuckConversations, loadWaiting,
} from "../usePultInbox";

const dialog = (id: string, over: Record<string, unknown> = {}) => ({
  id, channel: "TELEGRAM", name: `Клиент ${id}`, lastMessage: { role: "user", content: "Привет", by: null },
  lastMessageAt: "2026-10-23T08:00:00Z", paused: false, awaitingHumanSince: "2026-10-23T07:00:00Z", pausedSince: null, ...over,
});

beforeEach(() => { calls.list = []; calls.replies = new Map(); });

describe("pult inbox: загрузчики очередей", () => {
  it("диалоги: склеивает «ждут человека» и «бот на паузе» без дублей и считает остаток сервера", async () => {
    calls.replies.set("/conversations?needsHuman=1", { items: [dialog("a"), dialog("b")], total: 9 });
    calls.replies.set("/conversations?paused=1", { items: [dialog("b", { paused: true }), dialog("c", { paused: true, awaitingHumanSince: null, pausedSince: "2026-10-22T10:00:00Z" })], total: 2 });
    const r = await loadWaiting();
    expect(r.items.map((i) => i.id)).toEqual(["waiting:a", "waiting:b", "waiting:c"]);
    expect(r.total).toBe(3 + 7);
    const b = r.items.find((i) => i.id === "waiting:b")!;
    expect(b.type === "dialog" && b.paused).toBe(true);
  });

  it("комментарии: берёт только те, где бот спасовал (ESCALATED)", async () => {
    calls.replies.set("/instagram-comments?status=ESCALATED&pageSize=30", {
      items: [{ id: "k1", authorName: null, text: "Сколько стоит?", createdAt: "2026-10-23T06:00:00Z" }], total: 4,
    });
    const r = await loadComments();
    expect(r.total).toBe(4);
    expect(r.items[0]).toMatchObject({ id: "comments:k1", type: "comment", commentId: "k1", title: "Автор комментария" });
  });

  it("монтаж: показывает только просроченные и отличает «отправить снова» от «отложить»", async () => {
    const row = (id: string, status: string, overdue: boolean) => ({
      id, title: `Объект ${id}`, videoHandoffStatus: status, videoHandoffManualSince: null, pipeline: { overdue, daysInStage: 5, limitDays: 3 },
    });
    calls.replies.set("/marketing/editor-queue", {
      inEditing: [row("p1", "SENT_TO_EDITOR", true), row("p2", "QUEUED", true), row("p3", "QUEUED", false)],
      upcoming: [], counts: { inEditing: 3, overdue: 2, upcoming: 0 },
    });
    const r = await loadEditor();
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(2);
    expect(r.items[0]).toMatchObject({ canResend: true, canHold: false });
    expect(r.items[1]).toMatchObject({ canResend: false, canHold: true });
  });

  it("застрявшие диалоги: пусто — нет строки; иначе одна строка «повторить всем»", async () => {
    calls.replies.set("/errors/stuck-conversations", { count: 0, items: [] });
    expect((await loadStuckConversations()).items).toEqual([]);
    calls.replies.set("/errors/stuck-conversations", { count: 3, items: [{ id: "x", lastMessageAt: "2026-10-23T01:00:00Z" }] });
    const r = await loadStuckConversations();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ type: "stuckConversations", count: 3, at: "2026-10-23T01:00:00Z" });
  });

  it("судья бота: одна строка на группу, решение — по первой находке", async () => {
    calls.replies.set("/bot-audit", {
      groups: [
        { id: "g1", type: "t", why: "Бот назвал неверную цену", severity: "high", count: 3, examples: [{ id: "f1", quote: "цена 5 сомони", createdAt: "2026-10-22T00:00:00Z" }] },
        { id: "g2", type: "t", why: "пусто", severity: "low", count: 1, examples: [] },
      ],
      groupsTotal: 2,
    });
    const r = await loadBotAudit();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ type: "audit", findingId: "f1" });
    expect(r.items[0].detail).toContain("ещё 2 такого же");
  });
});

describe("pult inbox: права и порядок", () => {
  it("очередь без права не заводится", () => {
    const allowed = enabledInboxQueues((p) => p === "auditLog.view", "DIRECTOR");
    expect([...allowed].sort()).toEqual(["botAudit", "editor", "stuckConversations", "stuckWork", "videos"]);
    expect(enabledInboxQueues(() => false, "AGENT").size).toBe(0);
  });

  it("давнее выше, без даты — в конец; возраст читается по-русски", () => {
    const items = [{ at: null }, { at: "2026-10-23T08:00:00Z" }, { at: "2026-10-20T08:00:00Z" }];
    expect([...items].sort(byAge).map((i) => i.at)).toEqual(["2026-10-20T08:00:00Z", "2026-10-23T08:00:00Z", null]);
    const now = Date.parse("2026-10-23T10:00:00Z");
    expect(formatAge("2026-10-23T09:45:00Z", now)).toBe("15 мин");
    expect(formatAge("2026-10-23T07:00:00Z", now)).toBe("3 ч");
    expect(formatAge("2026-10-21T10:00:00Z", now)).toBe("2 д");
    expect(formatAge(null, now)).toBe("");
  });
});

describe("pult inbox: проверка ролика", () => {
  it("ролики: берёт очередь сервера, считает остаток и открывает очередь только с properties.moderate", async () => {
    const clip = (id: string, at: string | null) => ({ id, shortId: 7, title: `Объект ${id}`, videoUrl: "/uploads/handoff/a.mp4", coverUrl: null, requestedAt: at, montajer: { id: "m", fullName: "Фарход" } });
    calls.replies.set("/properties/clip-review/pending", { items: [clip("p1", "2026-10-23T05:00:00Z"), clip("p2", null)], total: 5 });
    const r = await loadClips();
    expect(calls.list[0].path).toBe("/properties/clip-review/pending?limit=20");
    expect(r.total).toBe(5);
    expect(r.items[0]).toMatchObject({ id: "clips:p1", queue: "clips", group: "video", type: "clip" });
    expect(r.items[0].detail).toContain("монтажёр Фарход");
    expect(enabledInboxQueues((p) => p === "properties.moderate", "AGENT").has("clips")).toBe(true);
    expect(enabledInboxQueues(() => false, "AGENT").has("clips")).toBe(false);
  });
});
