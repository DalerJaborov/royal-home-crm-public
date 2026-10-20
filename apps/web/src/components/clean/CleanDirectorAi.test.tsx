import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const actor = vi.hoisted(() => ({ readOnly: false }));
vi.mock("../../lib/permissions", () => ({ useIsReadOnly: () => actor.readOnly }));

vi.mock("../pult/MorningBriefingCard", () => ({ MorningBriefingCard: ({ enabled }: { enabled: boolean }) => enabled ? <section>Существующий утренний брифинг</section> : null }));
vi.mock("../pult/DirectorAskSheet", () => ({ DirectorAskSheet: () => <div>Существующее окно вопросов</div> }));

import { CleanDirectorAi } from "./CleanDirectorAi";

describe("Clean director AI entrypoints", () => {
  it("оставляет готовый брифинг акционеру без недоступных ИИ-запросов", () => {
    actor.readOnly = true;
    try {
      const html = renderToStaticMarkup(<CleanDirectorAi enabled areas={[]} />);
      expect(html).toContain("Существующий утренний брифинг");
      expect(html).toContain("Доступ только для просмотра");
      expect(html).not.toContain("Спросить ИИ");
    } finally { actor.readOnly = false; }
  });
  it("keeps briefing independently available when the ask module is off", () => {
    const html = renderToStaticMarkup(<CleanDirectorAi enabled askEnabled={false} areas={[]} />);
    expect(html).toContain("Существующий утренний брифинг");
    expect(html).toContain("Вопросы к ИИ отключены");
    expect(html).not.toContain("Спросить ИИ");
  });
  it("does not expose either entrypoint without the existing analytics permission", () => {
    expect(renderToStaticMarkup(<CleanDirectorAi enabled={false} areas={[]} />)).toBe("");
  });

  it("reuses briefing, enables ask only after the snapshot and keeps the dialog closed initially", () => {
    const loading = renderToStaticMarkup(<CleanDirectorAi enabled />);
    expect(loading).toContain("Существующий утренний брифинг");
    expect(loading).toContain("Спросить ИИ");
    expect(loading).toContain('disabled=""');
    const ready = renderToStaticMarkup(<CleanDirectorAi enabled areas={[]} />);
    expect(ready).not.toContain('disabled=""');
    expect(ready).not.toContain("Существующее окно вопросов");
  });
});
