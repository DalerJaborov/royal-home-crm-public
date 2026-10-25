import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { canViewInvestigations, isSellerControlRopRole, type SellerControlConfig } from "@royal-home/shared";
vi.mock("../../lib/api", () => ({ api: vi.fn() }));
vi.mock("../../hooks/useAgents", () => ({ useAgents: () => ({ data: [
  { id: "00000000-0000-4000-8000-000000000001", fullName: "Старый менеджер", role: "MANAGER", isActive: true },
  { id: "00000000-0000-4000-8000-000000000002", fullName: "РОП", role: "HEAD_OF_SALES", isActive: true },
  { id: "00000000-0000-4000-8000-000000000003", fullName: "Администратор", role: "ADMIN", isActive: true },
  { id: "00000000-0000-4000-8000-000000000004", fullName: "Директор", role: "DIRECTOR", isActive: true },
  { id: "00000000-0000-4000-8000-000000000005", fullName: "Агент", role: "AGENT", isActive: true },
  { id: "00000000-0000-4000-8000-000000000006", fullName: "Служба безопасности", role: "SECURITY", isActive: true },
] }) }));
import { SellerControlPanel } from "./SellerControlPanel";

function render(config: SellerControlConfig | null) {
  const client = new QueryClient();
  client.setQueryData(["seller-control-episodes"], { config, mode: "PREVIEW", episodes: [] });
  client.setQueryData(["seller-control-candidates"], { items: [] });
  return renderToStaticMarkup(<QueryClientProvider client={client}><SellerControlPanel /></QueryClientProvider>);
}

describe("seller control configuration editing", () => {
  it("allows ROP and legacy leadership roles, without widening the investigation role ceiling", () => {
    for (const role of ["HEAD_OF_SALES", "MANAGER", "ADMIN", "DIRECTOR"] as const) expect(isSellerControlRopRole(role)).toBe(true);
    for (const role of ["AGENT", "SECURITY"] as const) expect(isSellerControlRopRole(role)).toBe(false);
    expect(canViewInvestigations("HEAD_OF_SALES")).toBe(false);
    const html = render(null);
    expect(html).toContain('value="00000000-0000-4000-8000-000000000002"');
    expect(html).toContain('value="00000000-0000-4000-8000-000000000001"');
    expect(html).not.toContain('value="00000000-0000-4000-8000-000000000005"');
    expect(html).not.toContain('value="00000000-0000-4000-8000-000000000006"');
  });

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
