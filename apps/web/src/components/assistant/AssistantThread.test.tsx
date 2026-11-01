import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AssistantActionView } from "@royal-home/shared";

vi.mock("../../lib/api", () => ({ refreshAccessToken: vi.fn(async () => null), api: vi.fn() }));
vi.mock("../../lib/deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));

const { AssistantThread } = await import("./AssistantThread");
const { ConfirmCard } = await import("./ConfirmCard");
const { historyForStorage, pushStep, stepLabel, upsertAction } = await import("./assistantTurn");

const action: AssistantActionView = {
  id: "a1",
  tool: "change_client_agent",
  status: "PENDING",
  preview: { title: "Передать клиента ПК-000042", was: { agent: "Иванов" }, becomes: { agent: "Петров" } },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  executedAt: null,
  undoneAt: null,
  undoUntil: null,
  result: null,
};

const idle = { pending: false, steps: [], text: "", cards: [], actions: [] };

function render(props: Partial<Parameters<typeof AssistantThread>[0]>) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AssistantThread
        messages={[]}
        live={idle}
        onNavigate={() => {}}
        onStop={() => {}}
        renderAction={(a) => <ConfirmCard action={a} layout="columns" />}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("лента шагов", () => {
  it("новый статус закрывает предыдущий шаг, повтор подряд не дублируется", () => {
    let steps = pushStep([], "Ищу клиента…");
    steps = pushStep(steps, "Ищу клиента…");
    steps = pushStep(steps, "Смотрю историю…");
    expect(steps).toEqual([
      { text: "Ищу клиента…", done: true },
      { text: "Смотрю историю…", done: false },
    ]);
    expect(steps.map(stepLabel)).toEqual(["Ищу клиента ✓", "Смотрю историю…"]);
  });

  it("чипы с «✓» у пройденных — одна разметка на телефон и ПК", () => {
    const html = render({
      live: { ...idle, pending: true, steps: [{ text: "Ищу клиента…", done: true }, { text: "Готовлю ответ…", done: false }] },
    });
    expect(html).toContain('class="chip ok"');
    expect(html).toContain("Ищу клиента ✓");
    expect(html).toContain("Готовлю ответ…");
  });
});

describe("поток токенов", () => {
  it("живой пузырь показывает накопленный текст, а не «Думаю…»", () => {
    const before = render({ live: { ...idle, pending: true } });
    expect(before).toContain("Думаю…");
    const during = render({ live: { ...idle, pending: true, text: "Нашёл двоих клиентов" } });
    expect(during).toContain("Нашёл двоих клиентов");
    expect(during).toContain("data-assistant-live");
    expect(during).not.toContain("Думаю…");
    expect(during).toContain("Остановить");
  });
});

describe("событие confirm рисует карточку", () => {
  it("в текущем ходе — карточка подтверждения под живым пузырём", () => {
    const html = render({ live: { ...idle, pending: true, text: "Подтвердите", actions: [action] } });
    expect(html).toContain('data-assistant-confirm="pending"');
    expect(html).toContain("Передать клиента ПК-000042");
    expect(html.indexOf("data-assistant-live")).toBeLessThan(html.indexOf("data-assistant-confirm"));
  });

  it("в готовой реплике — карточка привязана к ней, после текста", () => {
    const html = render({
      messages: [
        { role: "user", content: "Передай клиента Петрову" },
        { role: "assistant", content: "Подтвердите передачу", actions: [action] },
      ],
    });
    expect(html.indexOf("Подтвердите передачу")).toBeLessThan(html.indexOf("data-assistant-confirm"));
  });

  it("повтор события по тому же действию заменяет карточку, а не добавляет вторую", () => {
    const list = upsertAction(upsertAction([], action), { ...action, status: "EXECUTED" });
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("EXECUTED");
  });
});

describe("история", () => {
  it("в sessionStorage — только текст: карточки действий после повторного открытия не предлагаются", () => {
    expect(
      historyForStorage([
        { role: "user", content: "Передай" },
        { role: "assistant", content: "Подтвердите", actions: [action], cards: [] },
      ]),
    ).toEqual([
      { role: "user", content: "Передай" },
      { role: "assistant", content: "Подтвердите" },
    ]);
  });
});
