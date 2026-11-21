import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { CleanClientRow } from "./CleanClientRow";

type Props = ComponentProps<typeof CleanClientRow>;
const fixture: Props = {
  id: "client-1", name: "Мадина Каримова", href: "/clients/42", avatar: <span>МК</span>,
  identity: "КЛ-000042 · Покупатель", request: "3 комн · Сино · $55–70 тыс.", source: "Instagram",
  fact: <span>ждёт принятия</span>, lastContact: "последний контакт 19.11", showAgent: true,
  agentName: "Фаррух", agentAssigned: true, actions: <button type="button">Позвонить через CRM</button>, deleted: false,
};
const render = (props: Partial<Props> = {}) => renderToStaticMarkup(<MemoryRouter><CleanClientRow {...fixture} {...props} /></MemoryRouter>);

describe("clean client row", () => {
  it("shows only facts: the last staff contact, never a step deadline or advice (owner 21.11.2026)", () => {
    const html = render();
    expect(html).toContain("последний контакт 19.11");
    for (const advice of ["Срок: ", "Следующий шаг", "Давно не связывались", "Позвонить сейчас"]) expect(html).not.toContain(advice);
    expect(render({ lastContact: null })).not.toContain("последний контакт");
    expect(render({ lastContact: "контакта ещё не было" })).toContain("контакта ещё не было");
  });
  it("keeps identity, request, next action and responsible person distinct", () => {
    const html = render();
    for (const text of [fixture.name, fixture.identity, fixture.request, fixture.source, "ждёт принятия", "Фаррух", "последний контакт 19.11"]) expect(html).toContain(text);
    expect(html).toContain('href="/clients/42"');
    expect(html).toContain('data-client-row="client-1"');
  });
  it("never paints the contact line red", () => {
    expect(render()).not.toContain("text-red");
  });
  it("does not expose an assigned agent when the caller hides that column", () => {
    expect(render({ showAgent: false })).not.toContain("Фаррух");
  });
  it("never links a deleted card to the unavailable detail page", () => {
    const html = render({ href: undefined, deleted: true, actions: <button>Восстановить</button> });
    expect(html).not.toContain("href=");
    expect(html).toContain("Восстановить");
    expect(html).not.toContain("Позвонить через CRM");
  });
  it("keeps both supplied acceptance actions without inventing a call button", () => {
    const html = render({ actions: <><button>Принять</button><button>Отклонить</button></> });
    expect(html).toContain("Принять");
    expect(html).toContain("Отклонить");
    expect(html).not.toContain("Позвонить через CRM");
  });
  it("does not label an unassigned person with a made-up agent", () => {
    expect(render({ agentName: null, agentAssigned: false })).toContain("Не назначен");
    expect(render({ agentName: null, agentAssigned: true })).toContain("Агент назначен");
  });
});
