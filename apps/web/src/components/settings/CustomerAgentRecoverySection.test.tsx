import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { customerAgentQualityRecoveryStateSchema } from "@royal-home/shared";
import { api } from "../../lib/api";
import { CustomerAgentRecoverySection } from "./CustomerAgentRecoverySection";

vi.mock("../../lib/api", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/api")>(), api: vi.fn() }));
const ready = { status: "ready", reason: "qualified", requiresResumeFromOff: false, policyRevision: "31" } as const;
function render(value?: unknown): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (value) client.setQueryData(["settings", "customer-agent", "recovery"], customerAgentQualityRecoveryStateSchema.parse(value));
  return renderToStaticMarkup(<QueryClientProvider client={client}><CustomerAgentRecoverySection /></QueryClientProvider>);
}

describe("reserve customer-agent recovery control", () => {
  beforeEach(() => vi.clearAllMocks());
  it("offers no action before authoritative state is loaded", () => {
    const html = render();
    expect(html).toContain("Проверяем возможность возврата");
    expect(html).not.toContain("Подготовить возврат бота");
    expect(api).not.toHaveBeenCalled();
  });
  it("does not offer a blocked or already completed recovery", () => {
    expect(render({ ...ready, status: "blocked", reason: "incompatible" })).not.toContain("Подготовить возврат бота");
    const completed = render({ ...ready, status: "already_recovered", reason: "already_recovered" });
    expect(completed).toContain("Повторный возврат не требуется");
    expect(completed).not.toContain("Подготовить возврат бота");
    expect(api).not.toHaveBeenCalled();
  });
  it("requires an explicit reason and preserves the stated data boundaries", () => {
    const html = render(ready);
    expect(html).toContain("Резервная версия бота");
    expect(html).toContain("Старые сообщения и неизвестные отправки повторно не запускаются");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Подготовить возврат бота/);
    expect(html).not.toContain("Возобновить работу после остановки");
    expect(api).not.toHaveBeenCalled();
  });
  it("never preselects resuming a stopped bot", () => {
    const html = render({ ...ready, requiresResumeFromOff: true });
    const acknowledgement = html.match(/Возобновить работу после остановки[\s\S]*?<input[^>]*>/)?.[0];
    expect(acknowledgement).toBeDefined();
    expect(acknowledgement).not.toContain('checked=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Подготовить возврат бота/);
    expect(api).not.toHaveBeenCalled();
  });
});
