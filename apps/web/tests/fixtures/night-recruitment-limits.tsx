// Test-only entry; browser spec intercepts every CRM request, no providers or DB.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { VacancyCreateSheet } from "../../src/components/VacancyCreateSheet";
import { VacancyStageActions } from "../../src/components/VacancyStageActions";
import type { JobApplication } from "../../src/types/vacancies";
import { useAuthStore } from "../../src/store/auth";
import { initMobileUxFlag } from "../../src/hooks/useMobileUx";
import { createRecruitmentCatalogFixture } from "./recruitment-catalog";
import "../../src/index.css";

document.documentElement.dataset.theme = "royal-home-2026-light";
document.documentElement.dataset.shell = "clean";
initMobileUxFlag();
useAuthStore.setState({ agent: { id: "test-director", fullName: "Test director", phone: "test-staff", role: "DIRECTOR" }, accessToken: "test-fixture-token", hasSession: true });
const parameters = new URLSearchParams(location.search), mode = parameters.get("mode") ?? "create";
const length = Math.min(4000, Math.max(0, Number(parameters.get("length") ?? 0)));
const item = { id: "test-candidate", name: "Test candidate", status: "REJECTED", channel: "MANUAL", phone: null,
  createdAt: "2026-10-24T00:00:00Z", interviewNote: mode === "note" ? "x".repeat(length) : null,
  rejectionReason: mode === "reject" ? "x".repeat(length) : null, talentPool: false, customerInquiryId: "test-inquiry" } as JobApplication;
function Fixture() {
  const [open, setOpen] = useState(true);
  return <main><p>Тестовый стенд · вымышленные данные · отправки отключены</p>{mode === "create" ? open &&
    <VacancyCreateSheet positions={createRecruitmentCatalogFixture().positions} defaultPositionKey="smm" onClose={() => setOpen(false)} onCreated={() => setOpen(false)} onOpenExisting={() => {}} /> :
    <VacancyStageActions item={item} />}</main>;
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><MemoryRouter><Fixture /></MemoryRouter></QueryClientProvider>);
