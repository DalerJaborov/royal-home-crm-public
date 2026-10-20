/**
 * СТЕНД ПРОСМОТРА ТЕМЫ 2026 — только для разработки и снимков.
 *
 * Открывает настоящие экраны CRM («Объекты», «Карточка объекта», «Форма
 * объекта») на выдуманных данных: сервер и база для снимков не нужны. Сюда
 * никто не ходит из приложения — страница не подключена ни к одному роуту и в
 * production-сборку не входит (Vite собирает только index.html, см.
 * vite.config.ts).
 *
 * Зачем: без него облик проверить нечем — сборка и типы не видят раскладку, а
 * поднимать Postgres с сидом ради четырёх снимков дороже, чем подменить fetch.
 *
 * Адрес: /theme2026-preview.html?screen=list|detail|form
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Golos Text здесь больше не подключается: правило, которое его применяло, снято
// из index.css (10.09.2026) — стенд обязан показывать то же, что приложение.
import "../index.css";
import { useAuthStore } from "../store/auth";

/* ------------------------------ выдуманные данные ------------------------------ */

const DISTRICTS = [
  { id: "d1", name: "Сино" },
  { id: "d2", name: "Фирдавси" },
  { id: "d3", name: "Шохмансур" },
  { id: "d4", name: "И. Сомони" },
  { id: "d5", name: "Рудаки" },
];

const AGENTS = [
  { id: "a1", fullName: "Собир Назаров", role: "AGENT", isActive: true },
  { id: "a2", fullName: "Манижа Юсупова", role: "AGENT", isActive: true },
  { id: "a3", fullName: "Умед Каримов", role: "AGENT", isActive: true },
];

function property(
  i: number,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  const base = {
    id: `p${i}`,
    shortId: 100 + i,
    title: "3-комн. квартира",
    type: "APARTMENT",
    status: "AVAILABLE",
    condition: "GOOD",
    price: 420000,
    currency: "TJS",
    areaSqm: 78,
    rooms: 3,
    floor: 4,
    totalFloors: 9,
    windowCount: 6,
    address: "ул. Борбад 14",
    district: DISTRICTS[i % DISTRICTS.length],
    districtId: DISTRICTS[i % DISTRICTS.length].id,
    photos: [],
    viewsCount: 12,
    demandCount: 3,
    publishedOnSite: false,
    offSite: false,
    instagramUrl: null,
    description: null,
    documents: null,
    ownerContact: "+992 90 123 45 67",
    reelsCaption: null,
    siteUrl: null,
    lat: null,
    lng: null,
    assignedAgent: null,
    intakeAgent: AGENTS[i % AGENTS.length],
    intakeAgentId: AGENTS[i % AGENTS.length].id,
    deletedAt: null,
    pipeline: null,
    videoCount: 0,
    photosApprovedAt: null,
    videoApprovedAt: null,
    reviewRejectionReason: null,
    reviewRejectionVoiceUrl: null,
    listingAcceptedAt: "2026-09-02T00:00:00.000Z",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  return { ...base, ...over };
}

const ITEMS = [
  property(18, {
    title: "3-комн. квартира",
    status: "AVAILABLE",
    publishedOnSite: true,
    pipeline: { inPipeline: false, owner: null, daysInStage: 0, limitDays: null, overdue: false },
  }),
  property(4, {
    title: "2-комн. квартира",
    price: 310000,
    areaSqm: 54,
    rooms: 2,
    floor: 7,
    totalFloors: 12,
    status: "EDITING",
    pipeline: { inPipeline: true, owner: "EDITOR", daysInStage: 4, limitDays: 3, overdue: true },
  }),
  property(21, {
    title: "4-комн. квартира",
    price: 760000,
    areaSqm: 112,
    rooms: 4,
    floor: 2,
    totalFloors: 5,
    status: "PENDING_REVIEW",
    pipeline: { inPipeline: true, owner: "MARKETING", daysInStage: 1, limitDays: 2, overdue: false },
  }),
  property(37, { title: "Дом", price: 1240000, areaSqm: 180, rooms: 5, floor: null, totalFloors: null, status: "AWAITING_PHOTOS" }),
  property(89, { title: "Коммерческое", price: 2100000, areaSqm: 240, rooms: null, status: "RESERVED" }),
  property(96, { title: "Участок", price: 480000, areaSqm: 1200, rooms: null, status: "AVAILABLE", publishedOnSite: true }),
];

const DETAIL = {
  ...ITEMS[2],
  description:
    "Светлая квартира с хорошим ремонтом, окна во двор. Рядом школа и рынок, до центра десять минут.",
  documents: "Свидетельство о собственности",
};

/* --------------------------- подмена сетевых ответов --------------------------- */

const ME = {
  id: "me",
  fullName: "Далер Джаббаров",
  phone: "+992 90 000 00 00",
  role: "DIRECTOR",
  permissions: [
    "properties.publish",
    "properties.delete",
    "properties.moderate",
    "properties.aiListing",
    "properties.viewOwners",
    "properties.editForeign",
    "properties.export",
    "clients.viewAll",
    "deals.viewAll",
    "finance.view",
    "team.viewFull",
  ],
  preferences: null,
};

function reply(url: string): unknown {
  if (url.includes("/me")) return ME;
  if (url.includes("/districts")) return DISTRICTS;
  if (url.includes("/agents")) return AGENTS;
  if (url.includes("/clients")) return { items: [], total: 0, page: 1, pageSize: 20 };
  if (/\/properties\/[^/?]+$/.test(url.split("?")[0])) return DETAIL;
  if (url.includes("/properties")) return { items: ITEMS, total: 318, page: 1, pageSize: 20 };
  return {};
}

window.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new Response(JSON.stringify(reply(url)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

/* ---------------------------------- запуск ---------------------------------- */

useAuthStore.setState({
  agent: { id: "me", fullName: ME.fullName, phone: ME.phone, role: "DIRECTOR" },
  accessToken: "preview",
  hasSession: true,
});

const params = new URLSearchParams(window.location.search);
const screen = params.get("screen") ?? "list";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function boot() {
  const [{ Properties }, { PropertyDetail }, { PropertyNew }] = await Promise.all([
    import("../pages/Properties"),
    import("../pages/PropertyDetail"),
    import("../pages/PropertyForm"),
  ]);
  const entry = screen === "detail" ? "/properties/121" : screen === "form" ? "/properties/new" : "/properties";
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/properties" element={<Properties />} />
            <Route path="/properties/new" element={<PropertyNew />} />
            <Route path="/properties/:id" element={<PropertyDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </React.StrictMode>
  );
}

void boot();
