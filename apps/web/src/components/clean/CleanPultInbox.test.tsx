import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { InboxItem, InboxQueueState } from "../../hooks/usePultInbox";

const state = vi.hoisted(() => ({ queues: [] as unknown[] }));
vi.mock("../../hooks/usePultInbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/usePultInbox")>()),
  usePultInbox: () => state.queues,
  usePultInboxActions: () => ({}),
}));
vi.mock("../../lib/navigation", () => ({ useNavigation: () => ({ all: [{ to: "/messages" }, { to: "/stuck-work" }] }) }));
vi.mock("./CleanDecisionRow", () => ({
  CleanDecisionRow: ({ row }: { row: { title: string; actions: { label: string }[] } }) =>
    <div data-row>{row.title}|{row.actions.map((a) => a.label).join(",")}</div>,
}));

import { CleanPultInbox } from "./CleanPultInbox";

const dialog = (n: number): InboxItem => ({ id: `waiting:${n}`, queue: "waiting", group: "clients", type: "dialog", conversationId: String(n), paused: n === 1, title: `Клиент ${n}`, detail: "ждёт", at: null });
const queue = (over: Partial<InboxQueueState>): InboxQueueState => ({
  id: "waiting", group: "clients", label: "Клиент ждёт человека", href: "/messages", items: [], total: 0, isLoading: false, isError: false, refetch: () => undefined, ...over,
});
const html = () => renderToStaticMarkup(<MemoryRouter><CleanPultInbox /></MemoryRouter>);

describe("CleanPultInbox", () => {
  it("рисует не больше пяти строк очереди и ссылку «ещё N» в раздел", () => {
    state.queues = [queue({ items: [1, 2, 3, 4, 5, 6, 7].map(dialog), total: 12 })];
    const out = html();
    expect(out.match(/data-row/g)).toHaveLength(5);
    expect(out).toContain("ещё 7");
    expect(out).toContain('href="/messages"');
    expect(out).toContain("Клиенты");
  });

  it("пустые очереди — «Всё разобрано»", () => {
    state.queues = [queue({})];
    expect(html()).toContain("Всё разобрано");
  });

  it("падение одной очереди показывает ошибку с «Повторить», остальные живы", () => {
    state.queues = [
      queue({ isError: true }),
      queue({ id: "stuckWork", group: "system", label: "Что не доехало", href: "/stuck-work",
        items: [{ id: "stuckWork:j", queue: "stuckWork", group: "system", type: "stuckWork", jobId: "j", title: "Рассылка", detail: "ошибка", at: null }], total: 1 }),
    ];
    const out = html();
    expect(out).toContain('role="alert"');
    expect(out).toContain("«Клиент ждёт человека» не загрузилось");
    expect(out).toContain("Повторить");
    expect(out).toContain("Рассылка|Повторить");
    expect(out).not.toContain("Всё разобрано");
  });

  it("скелет, пока ничего не пришло", () => {
    state.queues = [queue({ isLoading: true })];
    expect(html()).toContain("Загружаем очереди");
  });

  it("без доступных очередей блока нет вовсе", () => {
    state.queues = [];
    expect(html()).toBe("");
  });
});
