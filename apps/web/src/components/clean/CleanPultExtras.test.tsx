import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

const trainer = vi.hoisted(() => vi.fn(() => <div>Trainer mounted</div>));
vi.mock("../trainer/BotTrainer", () => ({ BotTrainer: trainer }));

import { CleanCandidateSummary, CleanPultExtras } from "./CleanPultExtras";

describe("clean pult existing extra tools", () => {
  it("hides tools and counts without their actual permission gates", () => {
    expect(renderToStaticMarkup(<CleanPultExtras canTrainer={false} canVacancies={false} canSettings={false} newApplications={19} />)).toBe("");
  });

  it("keeps trainer closed and unmounted until explicitly opened", () => {
    trainer.mockClear();
    const html = renderToStaticMarkup(<CleanPultExtras canTrainer canVacancies={false} canSettings={false} />);
    expect(html).toContain("Тренажёр бота");
    expect(trainer).not.toHaveBeenCalled();
    expect(html).not.toContain('role="dialog"');
  });

  it("distinguishes unavailable candidate data from a real zero and uses the actual settings tab", () => {
    const props = { canTrainer: false, canVacancies: true, canSettings: true };
    const unavailable = renderToStaticMarkup(<MemoryRouter><CleanPultExtras {...props} /></MemoryRouter>);
    expect(unavailable).not.toContain("Кандидаты");
    expect(unavailable).toContain('href="/settings?tab=system&amp;task=workspace"');
    const zero = renderToStaticMarkup(<MemoryRouter><CleanPultExtras {...props} newApplications={0} /></MemoryRouter>);
    expect(zero).toContain("Кандидаты · 0");
    const actual = renderToStaticMarkup(<MemoryRouter><CleanCandidateSummary count={19} /></MemoryRouter>);
    expect(actual).toContain("19 новых анкет");
    expect(actual).toContain('href="/vacancies"');
  });
});
