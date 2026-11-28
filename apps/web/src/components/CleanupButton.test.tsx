import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ allowed: false }));
vi.mock("../lib/permissions", () => ({ useCan: () => () => h.allowed }));
vi.mock("../hooks/useDataCleanup", () => ({
  useCleanupPreview: () => ({ data: { count: 5 }, isLoading: false, isError: false }),
  useRunCleanup: () => ({ mutate: vi.fn(), isPending: false, isError: false, reset: vi.fn() }),
}));
import { CleanupButton } from "./CleanupButton";

describe("CleanupButton", () => {
  it("без права «Менять настройки CRM» кнопки нет совсем", () => {
    h.allowed = false;
    expect(renderToStaticMarkup(<CleanupButton target="notifications" />)).toBe("");
  });
  it("с правом — кнопка с подписью, диалог закрыт до нажатия", () => {
    h.allowed = true;
    const html = renderToStaticMarkup(<CleanupButton target="errorLog" label="Очистить журнал" />);
    expect(html).toContain("Очистить журнал");
    expect(html).not.toContain("Вернуть их будет нельзя");
  });
});
