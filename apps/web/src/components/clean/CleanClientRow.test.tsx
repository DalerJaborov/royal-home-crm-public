import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { CleanClientRow } from "./CleanClientRow";

type Props = ComponentProps<typeof CleanClientRow>;
const fixture: Props = {
  id: "client-1", name: "Мадина Каримова", href: "/clients/42", avatar: <span>МК</span>,
  identity: "КЛ-000042 · Покупатель", request: "3 комн · Сино · $55–70 тыс.", source: "Instagram",
  nextAction: <span>Позвонить сейчас</span>, lastContact: "2 дня назад", showAgent: true,
  agentName: "Фаррух", agentAssigned: true, actions: <button type="button">Позвонить через CRM</button>, deleted: false,
};
const render = (props: Partial<Props> = {}) => renderToStaticMarkup(<MemoryRouter><CleanClientRow {...fixture} {...props} /></MemoryRouter>);

describe("clean client row", () => {
  it("keeps identity, request, next action and responsible person distinct", () => {
    const html = render();
    for (const text of [fixture.name, fixture.identity, fixture.request, fixture.source, "Позвонить сейчас", "Фаррух", "2 дня назад"]) expect(html).toContain(text);
    expect(html).toContain('href="/clients/42"');
    expect(html).toContain('data-client-row="client-1"');
  });
  it("restores the real stale-contact flag without inventing a call date", () => {
    expect(render({ staleContact: true, lastContact: "20 дней назад" })).toContain("Давно не связывались");
    expect(render({ staleContact: true, lastContact: "20 дней назад" })).toContain("20 дней назад");
    expect(render()).not.toContain("Давно не связывались");
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
