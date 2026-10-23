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
vi.mock("../../hooks/useMissionControl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useMissionControl")>()),
  useMissionControl: () => ({ data: { team: { agents: [
    { id: "a1", fullName: "Нози", activeLoad: 7, takesLeads: true },
    { id: "a2", fullName: "Мадина", activeLoad: 2, takesLeads: true },
    { id: "a3", fullName: "На паузе", activeLoad: 0, takesLeads: false },
  ] } } }),
}));
vi.mock("../../lib/navigation", () => ({ useNavigation: () => ({ all: [{ to: "/messages" }, { to: "/stuck-work" }] }) }));
vi.mock("./CleanDecisionRow", () => ({
  CleanDecisionRow: ({ row }: { row: { title: string; actions: { label: string }[]; choice?: { label: string; defaultId: string; options: { id: string; label: string }[] } } }) =>
    <div data-row>{row.title}|{row.actions.map((a) => a.label).join(",")}{row.choice ? `|${row.choice.label}:${row.choice.defaultId}:${row.choice.options.map((o) => o.id).join("+")}` : ""}</div>,
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

  it("нарушения: чип первым после «Все», у строки «Принято», заметка и «Открыть»", () => {
    state.queues = [
      queue({}),
      queue({ id: "violations", group: "violations", label: "Красные флаги контроля", href: "/oversight",
        items: [{ id: "violations:stalled-clients:c1", queue: "violations", group: "violations", type: "flag", sliceKey: "stalled-clients", subjectId: "c1", href: "/oversight#slice-stalled-clients", title: "Иванов: горячий клиент без контакта", detail: "агент Алия", at: null }], total: 1 }),
    ];
    const out = html();
    expect(out.indexOf("Все")).toBeLessThan(out.indexOf("Нарушения"));
    expect(out.indexOf("Нарушения")).toBeLessThan(out.indexOf("Клиенты"));
    expect(out).toContain("Принято");
    expect(out).toContain("Заметка (необязательно)");
    expect(out).toContain('href="/oversight#slice-stalled-clients"');
  });

  it("скелет, пока ничего не пришло", () => {
    state.queues = [queue({ isLoading: true })];
    expect(html()).toContain("Загружаем очереди");
  });

  it("«Ждут агента»: строка с «Назначить» и выбором агента, наименее загруженный первым, агент на паузе приёма не в списке", () => {
    state.queues = [queue({
      id: "unassigned", label: "Ждут агента", href: "/clients", total: 1,
      items: [{ id: "unassigned:c1", queue: "unassigned", group: "clients", type: "unassigned", clientId: "c1", title: "Мадина", detail: "Telegram · ждёт 3 ч", at: null }],
    })];
    const out = html();
    expect(out).toContain("Ждут агента · 1");
    expect(out).toContain("Мадина|Назначить|Кому назначить:a2:a2+a1");
    expect(out).not.toContain("a3");
  });

  it("без доступных очередей блока нет вовсе", () => {
    state.queues = [];
    expect(html()).toBe("");
  });
});

describe("CleanPultInbox: проверка ролика", () => {
  it("у ролика на проверке есть кнопка «Смотреть»", () => {
    const clip = { id: "p1", shortId: 7, title: "Квартира", videoUrl: "/uploads/handoff/a.mp4", coverUrl: null, requestedAt: null, montajer: null };
    const item: InboxItem = { id: "clips:p1", queue: "clips", group: "video", type: "clip", clip, title: "Квартира", detail: "Объект №7", at: null };
    state.queues = [queue({ id: "clips", group: "video", label: "Проверка ролика", href: "/marketing", items: [item], total: 1 })];
    const out = html();
    expect(out).toContain("Проверка ролика");
    expect(out).toContain("Смотреть");
  });
});
