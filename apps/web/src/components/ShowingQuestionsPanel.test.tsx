import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ShowingQuestionView } from "@royal-home/shared";

/** «У вас был показ?» / «Договорились о показе?» в CRM (22.11.2026): крупный вопрос и главные кнопки. */
const items: ShowingQuestionView[] = [];
vi.mock("../hooks/useShowingQuestions", () => ({
  useShowingQuestions: () => ({ isError: false, data: { items } }),
  useAnswerShowingQuestion: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() }),
}));
vi.mock("./AddInteractionModal", () => ({ AddInteractionModal: () => null }));

const { ShowingQuestionsPanel } = await import("./ShowingQuestionsPanel");

const base = { clientId: "c1", clientShortId: 463, clientName: "Покупатель Тест", showingId: null, quote: null, askedAt: "2026-11-22T10:00:00.000Z", options: [] };

function render(clientId?: string) {
  return renderToStaticMarkup(<MemoryRouter><ShowingQuestionsPanel clientId={clientId} /></MemoryRouter>);
}

describe("ShowingQuestionsPanel", () => {
  it("вопросов нет — ничего не рисует", () => {
    items.length = 0;
    expect(render()).toBe("");
  });

  it("«У вас был показ?» — крупный вопрос, объект, время и две кнопки", () => {
    items.length = 0;
    items.push({ ...base, id: "q1", kind: "OUTCOME", showingId: "s1", at: "2026-11-22T13:00:00.000Z", property: { id: "p1", shortId: 12, title: "Рудаки 12" } });
    const html = render();
    expect(html).toContain("<h2");
    expect(html).toContain("У вас был показ?");
    expect(html).toContain("Рудаки 12");
    expect(html).toContain("Да, был");
    expect(html).toContain(">Нет<");
    // На Главной — имя клиента ссылкой на карточку; в карточке клиента — без него.
    expect(html).toContain('href="/clients/463"');
    expect(render("c1")).not.toContain('href="/clients/463"');
  });

  it("«Договорились о показе?» без объекта — выбор из подходящих и «Нет, не договорились»", () => {
    items.length = 0;
    items.push({ ...base, id: "q2", kind: "AGREEMENT", at: null, property: null, options: [
      { id: "p1", shortId: 12, title: "Рудаки 12" }, { id: "p2", shortId: 13, title: "Сино 5" },
    ] });
    const html = render();
    expect(html).toContain("Договорились о показе?");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Сино 5");
    expect(html).toContain("Нет, не договорились");
  });
});
