import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { CleanCandidateSummary, CleanPultExtras } from "./CleanPultExtras";

describe("clean pult existing extra tools", () => {
  it("hides tools and counts without their actual permission gates", () => {
    expect(renderToStaticMarkup(<CleanPultExtras canVacancies={false} canSettings={false} newApplications={19} />)).toBe("");
  });

  it("distinguishes unavailable candidate data from a real zero and uses the actual settings tab", () => {
    const props = { canVacancies: true, canSettings: true };
    const unavailable = renderToStaticMarkup(<MemoryRouter><CleanPultExtras {...props} /></MemoryRouter>);
    expect(unavailable).not.toContain("Кандидаты");
    expect(unavailable).toContain('href="/settings?tab=system&amp;task=workspace"');
    const zero = renderToStaticMarkup(<MemoryRouter><CleanPultExtras {...props} newApplications={0} /></MemoryRouter>);
    expect(zero).toContain("Кандидаты · 0");
    const actual = renderToStaticMarkup(<MemoryRouter><CleanCandidateSummary count={19} /></MemoryRouter>);
    expect(actual).toContain("19 новых анкет");
    expect(actual).toContain('href="/vacancies"');
  });

  it("кнопка «Кандидаты» ведёт сразу на /vacancies, без пустой шторки", () => {
    const html = renderToStaticMarkup(<MemoryRouter><CleanPultExtras canVacancies canSettings={false} newApplications={4} /></MemoryRouter>);
    expect(html).toMatch(/<a[^>]*href="[/]vacancies"[^>]*>.*Кандидаты · 4/s);
    expect(html).not.toContain("<button");
  });
});
