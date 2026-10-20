import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { StepSeller } from "../StepSeller";
import { EMPTY_WIZARD_VALUES } from "../types";

describe("restored seller selection", () => {
  it("shows the selected card even when no seller list has been loaded", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["client", "test-seller"], { id: "test-seller", fullName: "Тестовый продавец", shortId: 0, phone: null });
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><StepSeller values={{ ...EMPTY_WIZARD_VALUES, sellerClientId: "test-seller" }} errors={{}} requireIntakeAgent={false} onChange={() => {}} /></QueryClientProvider>);
    expect(html).toContain("Тестовый продавец");
    expect(html).toContain("ПК-0");
    expect(html).toContain("Сменить продавца");
    expect(html).not.toContain('id="seller"');
  });

  it("keeps a loading selection distinct from a new seller form", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><StepSeller values={{ ...EMPTY_WIZARD_VALUES, sellerClientId: "test-seller" }} errors={{}} requireIntakeAgent={false} onChange={() => {}} /></QueryClientProvider>);
    expect(html).toContain("Загружаю выбранного продавца");
    expect(html).not.toContain('id="seller"');
    expect(html).toContain("Сменить продавца");
  });
});
