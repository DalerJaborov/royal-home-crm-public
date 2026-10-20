import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { McFirstLine } from "../hooks/useMissionControl";
import { PultContactReminders, PultFirstLine } from "./PultClean";

function render(firstLine: McFirstLine | null, incomplete = false, isLoading = false) {
  return renderToStaticMarkup(<MemoryRouter><PultFirstLine firstLine={firstLine} incomplete={incomplete} isLoading={isLoading} /></MemoryRouter>);
}

describe("Pult first-line snapshot", () => {
  it("renders every loaded item, including server items six and seven", () => {
    const items: McFirstLine["items"] = Array.from({ length: 7 }, (_, index) => ({ id: `event-${index}`, severity: "critical", text: `Событие ${index + 1}`, href: `/clients/${index + 1}` }));
    const html = render({ items, shownCount: 7, totalCount: 9 });
    expect(html).toContain("Событие 6");
    expect(html).toContain("Событие 7");
    expect(html).toContain("Показаны 7 из 9 событий");
    expect(html).toContain(">9<");
    expect(html).not.toContain("Событие 8");
    expect((html.match(/Открыть событие команды/g) ?? [])).toHaveLength(7);
  });

  it("does not announce no events when data is unavailable", () => {
    expect(render(null, true)).toContain("Данные команды загружены не полностью");
    expect(render(null, true)).not.toContain("Замечаний к команде сегодня нет");
    expect(render(null, false, true)).toContain("Загружаем события команды");
    expect(render({ items: [], shownCount: 0, totalCount: 0 })).toContain("Замечаний к команде сегодня нет");
    expect(render({ items: [], shownCount: 0, totalCount: 3 })).not.toContain("Замечаний к команде сегодня нет");
  });
});

describe("Pult contact reminders", () => {
  it("shows actual call count and yesterday's metrics, with route permission gates", () => {
    const hero = { missedCallsToday: 3, firstResponse: { medianMinYesterday: 8.5, noneCountYesterday: 2 } };
    const html = renderToStaticMarkup(<MemoryRouter><PultContactReminders hero={hero} canCalls canClients /></MemoryRouter>);
    expect(html).toContain('href="/calls"');
    expect(html).toContain(">3<");
    expect(html).toContain("Первое касание — вчера");
    expect(html).toContain("Медиана 8,5 мин · без касания: 2");
    const noAccess = renderToStaticMarkup(<MemoryRouter><PultContactReminders hero={hero} canCalls={false} canClients={false} /></MemoryRouter>);
    expect(noAccess).toBe("");
  });

  it("does not turn missing median into a false zero-minute response", () => {
    const html = renderToStaticMarkup(<MemoryRouter><PultContactReminders hero={{ missedCallsToday: 0, firstResponse: { medianMinYesterday: null, noneCountYesterday: 0 } }} canCalls={false} canClients /></MemoryRouter>);
    expect(html).toContain("Медиана не рассчитана");
    expect(html).not.toContain('href="/calls"');
  });
});
