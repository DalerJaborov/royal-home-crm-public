import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { McAgent } from "../../hooks/useMissionControl";

const owner = vi.hoisted(() => ({ items: [] as unknown[] }));
const perms = vi.hoisted(() => ({ allowed: new Set<string>() }));

vi.mock("../../hooks/useMe", () => ({
  useOwnerQuestions: () => ({ data: { items: owner.items } }),
  useAnswerOwnerQuestion: () => ({ isPending: false, isError: false, error: null, mutate: vi.fn() }),
}));
vi.mock("../../lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/permissions")>()),
  useCan: () => (permission: string) => perms.allowed.has(permission),
  useIsReadOnly: () => false,
}));

import { CleanOwnerQuestionReply, OWNER_ANSWER_MIN } from "./CleanOwnerQuestionReply";
import { CleanDeleteRequestRows } from "./CleanReminderActions";
import { nextConfirmStep, runDecisionBatch } from "./CleanDecisionRow";
import { transferChoice } from "../pult/leastLoadedAgent";
import { deleteRequestBody, deleteRequestPath } from "../../hooks/useMissionControl";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const render = (node: ReactNode) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
);
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const agent = (id: string, activeLoad: number, takesLeads?: boolean): McAgent => ({
  id, fullName: `Агент ${id}`, avatarUrl: null, activeLoad, pendingAccept: 0, acceptedToday: 0, buyerCount: 0, sellerCount: 0, takesLeads,
});

describe("подтверждение: второй клик", () => {
  it("кнопка с текстом подтверждения сначала взводится, второй клик по ней выполняет", () => {
    expect(nextConfirmStep(null, "deal", "Точно одобрить?")).toBe("arm");
    expect(nextConfirmStep("deal", "deal", "Точно одобрить?")).toBe("run");
  });
  it("взведённая другая кнопка не засчитывается, а без текста подтверждения выполняется сразу", () => {
    expect(nextConfirmStep("other", "deal", "Точно одобрить?")).toBe("arm");
    expect(nextConfirmStep(null, "client", undefined)).toBe("run");
  });
  it("одобрение сделки, ошибки и массовая передача подтверждаются в источнике строк", () => {
    const src = read("../pult/PultActions.tsx");
    expect(src).toContain('confirm: "Точно одобрить?"');
    expect(src).toContain("confirm: `Разобрать ${resolveCount}");
    expect(src).toContain("bulkConfirm: (n) => `Передать ${n} ${pluralClientsAcc(n)}?`");
  });
  it("строка решения сбрасывает взведение через 10 секунд и показывает «Отмена»", () => {
    const src = read("./CleanDecisionRow.tsx");
    expect(src).toContain("CONFIRM_WINDOW_MS = 10_000");
    expect(src).toContain("setTimeout(() => setArmed(null), CONFIRM_WINDOW_MS)");
    expect(src).toMatch(/armed && !busy && <CButton[^>]*>Отмена</);
  });
});

describe("«Передать»: выбор агента", () => {
  it("по умолчанию наименее загруженный; те, кто не принимает лиды, в списке отсутствуют", () => {
    const choice = transferChoice([agent("a", 7), agent("b", 2), agent("c", 0, false), agent("d", 4)]);
    expect(choice?.defaultId).toBe("b");
    expect(choice?.options.map((option) => option.id)).toEqual(["b", "d", "a"]);
    expect(choice?.options[0].label).toBe("Агент b · 2 в работе");
  });
  it("некому передавать — выбора нет", () => {
    expect(transferChoice([agent("a", 1, false)])).toBeNull();
    expect(transferChoice([])).toBeNull();
  });
  it("выбранный агент доходит до запроса, и у каждого участника группы", async () => {
    const chosen: (string | undefined)[] = [];
    const row = (id: string) => ({
      id, tone: "warn" as const, avatar: { label: "К", tone: "aqua" as const }, title: id,
      actions: [{ label: "Передать", endpoint: "POST /api/v1/clients/:id/assign", doneMessage: "ok", onRun: async (choiceId?: string) => { chosen.push(choiceId); return true; } }],
    });
    const done = await runDecisionBatch([row("c1"), row("c2")], undefined, "agent-7");
    expect(done).toHaveLength(2);
    expect(chosen).toEqual(["agent-7", "agent-7"]);
  });
  it("строка рисует выбор агента с подписью и в массовой, и в одиночной передаче", () => {
    const src = read("./CleanDecisionRow.tsx");
    expect(src).toContain("aria-label={row.choice.label}");
    expect(src).toContain("}, choice);");
  });
});

describe("ответ на вопрос бота в строке", () => {
  const question = {
    id: "q1", question: "Квартира ещё продаётся?", askedAt: new Date().toISOString(), clientName: "Мадина",
    managedRevision: null, answeredAt: null,
  };
  it("есть поле ввода и кнопка, ответ короче предела не отправляется", () => {
    owner.items = [question];
    const html = render(<CleanOwnerQuestionReply questionId="q1" />);
    expect(html).toContain("<textarea");
    expect(html).toContain("Ответ клиенту · Мадина");
    expect(html).toContain("Ответить клиенту");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ответить клиенту/);
    expect(OWNER_ANSWER_MIN).toBe(5);
  });
  it("управляемый вопрос сохраняет ответ с ревизией, уже сохранённый не даёт ответить повторно", () => {
    owner.items = [{ ...question, managedRevision: "3" }];
    expect(render(<CleanOwnerQuestionReply questionId="q1" />)).toContain("Сохранить ответ");
    owner.items = [{ ...question, managedRevision: "3", answeredAt: new Date().toISOString() }];
    const held = render(<CleanOwnerQuestionReply questionId="q1" />);
    expect(held).not.toContain("<textarea");
    expect(held).toContain("клиенту он ещё не ушёл");
  });
  it("вопроса нет в очереди — ничего не рисуем, остаётся ссылка в строке", () => {
    owner.items = [];
    expect(render(<CleanOwnerQuestionReply questionId="q1" />)).toBe("");
  });
});

describe("заявки на удаление: одобрить и отклонить на месте", () => {
  const items = [
    { id: "r1", kind: "CLIENT" as const, title: "Иван", reason: "дубль", requestedBy: "Мадина", createdAt: "2026-10-23T00:00:00Z", href: "/clients/1" },
    { id: "r2", kind: "PROPERTY" as const, title: "Квартира", reason: "продана", requestedBy: null, createdAt: "2026-10-23T00:00:00Z", href: "/properties/2" },
  ];
  it("адрес и тело решения: разные роутеры, отказ только с причиной", () => {
    expect(deleteRequestPath("CLIENT", "r1", "approve")).toBe("/clients/delete-requests/r1/approve");
    expect(deleteRequestPath("PROPERTY", "r2", "reject")).toBe("/properties/delete-requests/r2/reject");
    expect(deleteRequestBody("approve")).toEqual({});
    expect(deleteRequestBody("reject", "  дубль нет  ")).toEqual({ decisionNote: "дубль нет" });
  });
  it("кнопки видны только по праву на удаление нужного вида", () => {
    perms.allowed = new Set(["clients.delete"]);
    const html = render(<CleanDeleteRequestRows requests={items} />);
    expect(html).toContain("Удалить клиента: Иван");
    expect(html).not.toContain("Удалить объект");
    expect(html).toContain("Одобрить");
    expect(html).toContain("Отклонить");
    perms.allowed = new Set();
    expect(render(<CleanDeleteRequestRows requests={items} />)).toBe("");
  });
  it("одобрение просит второй клик, отказ — причину", () => {
    const src = read("./CleanReminderActions.tsx");
    expect(src).toContain("Точно удалить?");
    expect(src).toContain("disabled={pending || !reason.trim()}");
  });
});
