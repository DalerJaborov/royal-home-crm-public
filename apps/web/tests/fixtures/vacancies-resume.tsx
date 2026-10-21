// Development-only test entry. API requests are intercepted by the browser spec.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { RecruitmentCommunicationDelivery } from "@royal-home/shared";
import { Vacancies } from "../../src/pages/Vacancies";
import { useAuthStore } from "../../src/store/auth";
import { initMobileUxFlag } from "../../src/hooks/useMobileUx";
import "../../src/index.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "night" ? "royal-home-2026-night" : "royal-home-2026-light";
document.documentElement.dataset.shell = "clean";
document.documentElement.dataset.screen = "vacancies";
initMobileUxFlag();
if (new URLSearchParams(location.search).get("mock") === "1") {
  const source = { sourceEventKey: "a".repeat(64), quote: "Снимаю видео для местных компаний" };
  const candidate: Record<string, unknown> = { id: "22222222-2222-4222-8222-222222222222", status: "NEW", name: "Тестовая Ситора с длинным именем", contactName: null,
    phone: "+992000000000", age: null, city: "Душанбе", education: null, experience: null, rawText: "Снимаю видео для местных компаний", languages: "Русский",
    startWhen: null, employedNow: null, studyingNow: null, studyingUniversity: null, priority: null, eligible: null, cvFile: null,
    channel: "INSTAGRAM", createdAt: "2026-10-21T10:00:00Z", interviewAt: null, interviewNote: null, rejectionReason: null, talentPool: false,
    positionTitle: "SMM-специалист / видеограф", positionKey: "smm", customerInquiryId: "test-inquiry",
    recruitmentResume: { version: 1, facts: { about: { value: "Снимаю видео для местных компаний", ...source }, skills: { value: "Видеосъёмка", ...source } } },
    recruitmentAssessment: { missing: ["startWhen"], warnings: [], readyForReview: false }, customerPortfolio: [] };
  const legacy = new URLSearchParams(location.search).get("legacy") === "1";
  if (legacy) { candidate.customerInquiryId = null; candidate.positionKey = null; candidate.positionTitle = null; candidate.recruitmentResume = null; }
  const deliveries: RecruitmentCommunicationDelivery[] = new URLSearchParams(location.search).get("result") === "clarify" ? [{
    id: "test-assistant-result", channel: "ASSISTANT_CALL", status: "COMPLETED", result: { purpose: "CLARIFY", summary: "Кандидатка сказала, что готова начать со следующей недели.",
      transcript: ["Ассистент: Когда вы готовы начать работу?", "Кандидат: Могу выйти в понедельник."], candidateSpoke: true },
  }] : [];
  let previewText = "";
  const realFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), location.origin);
    if (!url.pathname.startsWith("/api/v1/")) return realFetch(input, init);
    const path = url.pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let response: unknown = {};
    if (path === "/me") response = { id: "11111111-1111-4111-8111-111111111111", role: "DIRECTOR", permissions: ["vacancies.view", "settings.manage"], readOnly: false };
    else if (path === "/me/active-call") response = null;
    else if (path === "/vacancies/positions") response = { items: [{ key: "smm", titleRu: "SMM-специалист / видеограф", isOpen: true }] };
    else if (path === "/vacancies") response = { items: url.searchParams.get("q") ? [] : [candidate], total: url.searchParams.get("q") ? 0 : 1,
      counts: { NEW: 1, REVIEWED: 0, INTERVIEW: 0, INTERVIEWED: 0, HIRED: 0, REJECTED: 0 }, collecting: true, todayInterviews: [], noPhoneCount: 0 };
    else if (path.endsWith("/conversation")) response = { messages: [], files: [], inboxId: null };
    else if (path.endsWith("/contact-options")) {
      const capability = legacy && !candidate.positionKey ? { available: false, reason: "Выберите вакансию для этой анкеты" } : { available: true };
      response = { sms: capability, assistantCall: capability, clarification: capability,
        office: { address: "Тестовый офис, дом 1", mapUrl: null, preparation: null }, language: "ru", recentDeliveries: deliveries };
    }
    else if (path.endsWith("/invitations/preview")) {
      previewText = body.purpose === "CLARIFY" ? "Тестовое уточнение: когда вы готовы начать работу?" : `Тестовое приглашение на собеседование. Время: ${body.interviewAt}. Адрес: ${body.address}. ${body.preparation || ""}`;
      response = { previewId: "33333333-3333-4333-8333-333333333333", text: previewText, callSummary: previewText, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    } else if (path.endsWith("/invitations")) { deliveries.push({ id: "test-delivery", channel: "SMS", status: "DRY_RUN" }); response = { interviewSaved: true, deliveries }; }
    else if (path.endsWith("/call")) return new Response(JSON.stringify({ error: "Тестовый стенд: реальные звонки отключены" }), { status: 403, headers: { "Content-Type": "application/json" } });
    else if (init?.method === "PATCH" && path === `/vacancies/${candidate.id}`) {
      if (legacy && body.positionKey === "smm") { candidate.positionKey = "smm"; candidate.positionTitle = "SMM-специалист / видеограф"; }
      response = { ok: true };
    }
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}
useAuthStore.setState({ agent: { id: "11111111-1111-4111-8111-111111111111", fullName: "Тестовый руководитель", phone: "test-staff", role: "DIRECTOR" }, accessToken: "test-fixture-token", hasSession: true });
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><MemoryRouter><main><p style={{ padding: "10px 24px", background: "#fff1d4", fontSize: 13 }}>Тестовый стенд · вымышленные данные · отправка отключена</p><Vacancies /></main></MemoryRouter></QueryClientProvider>);
