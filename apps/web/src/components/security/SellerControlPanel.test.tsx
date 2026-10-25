import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { SellerControlConfig } from "@royal-home/shared";
vi.mock("../../lib/api", () => ({ api: vi.fn() }));
vi.mock("../../hooks/useAgents", () => ({ useAgents: () => ({ data: [{
  id: "00000000-0000-4000-8000-000000000001", fullName: "Тестовый руководитель", role: "MANAGER", isActive: true,
}] }) }));
import { SellerControlPanel } from "./SellerControlPanel";

function render(config: SellerControlConfig | null) {
  const client = new QueryClient();
  client.setQueryData(["seller-control-episodes"], { config, mode: "PREVIEW", episodes: [] });
  client.setQueryData(["seller-control-candidates"], { items: [] });
  return renderToStaticMarkup(<QueryClientProvider client={client}><SellerControlPanel /></QueryClientProvider>);
}

describe("seller control configuration editing", () => {
  it("loads saved deadlines, optional follow-up and responsible manager into their controls", () => {
    const html = render({ agentDueWorkingDays: 3, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 2,
      buyerCandidateFollowupWorkingDays: 4, defaultRopAgentId: "00000000-0000-4000-8000-000000000001" });
    for (const value of [1, 2, 3, 4]) expect(html).toMatch(new RegExp(`<input[^>]+value="${value}"`));
    expect(html).toContain('value="00000000-0000-4000-8000-000000000001" selected=""');
  });
  it("offers the approved starter values without claiming they are saved or starting control", () => {
    const html = render(null);
    expect(html).toContain("Стартовые сроки подготовлены, но не сохранены");
    expect(html).toContain("Эпизоды не запускаются");
    expect(html.match(/<input[^>]+value="2"/g)).toHaveLength(3);
    expect(html.match(/<input[^>]+value="1"/g)).toHaveLength(1);
    expect(html).toContain('value="" selected=""');
  });
  it("keeps optional settings deliberately absent in a saved configuration", () => {
    const html = render({ agentDueWorkingDays: 5, ropReceiptDueWorkingDays: 2, ropActionDueWorkingDays: 3 });
    expect(html.match(/<input[^>]+value=""/g)).toHaveLength(1);
    expect(html).toContain('value="" selected=""');
    expect(html).not.toContain("Стартовые сроки подготовлены, но не сохранены");
  });
});
