import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { BotLessonGroup } from "../../hooks/useBotLearning";
import { BotLessonsSection } from "../../pages/settings/BotTab";

const state = vi.hoisted(() => ({ private: true }));
vi.mock("../../components/settings/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsGroupLabel: () => null,
  SettingsSearchProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../hooks/useBotLearning", async (original) => ({
  ...await original<typeof import("../../hooks/useBotLearning")>(),
  useBotLearning: () => ({ data: {
    rules: [{ id: "lesson", investigationOnly: state.private, active: true, lesson: "Историческое правило",
      createdAt: "2026-10-23T00:00:00Z", kind: "audit_finding", channel: "web",
      conversationId: null, botMessage: "Вопрос", humanMessage: "Ответ", dupCount: 1, dupExamples: [],
    } satisfies BotLessonGroup],
    promptLessonIds: [], promptCount: 0, activeCount: state.private ? 0 : 1, promptLimit: 20,
    rulesNextOffset: null, rulesGroupsTotal: 1, rulesTotal: 1,
  }, isLoading: false }),
  useUpdateBotLessonGroup: () => ({ mutate: vi.fn(), isPending: false }),
  useBumpBotLesson: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBotLesson: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("quarantined lesson history", () => {
  it("shows retained source with disabled mutation controls and no promotion action", () => {
    state.private = true;
    const html = renderToStaticMarkup(<BotLessonsSection />);
    expect(html).toContain("Карантин · только просмотр");
    expect(html).toContain("Историческая запись сохранена");
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Удалить правило/);
    expect(html).not.toContain(">Поднять<");
    expect(html).toContain("Вопрос");
  });

  it("keeps ordinary lesson controls available without a quarantine label", () => {
    state.private = false;
    const html = renderToStaticMarkup(<BotLessonsSection />);
    expect(html).not.toContain("Карантин");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Поднять");
  });
});
