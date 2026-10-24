// Synthetic intercepted transport only; no client, database or provider operations.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ClientFormModal } from "../../src/components/ClientFormModal";
import { useAuthStore } from "../../src/store/auth";
import { initMobileUxFlag } from "../../src/hooks/useMobileUx";
import type { Client } from "../../src/types";
import "../../src/index.css";

document.documentElement.dataset.theme = "royal-home-2026-light";
initMobileUxFlag();
useAuthStore.setState({
  agent: { id: "synthetic-director", fullName: "Synthetic director", phone: "fixture", role: "DIRECTOR" },
  accessToken: "synthetic-fixture-only", hasSession: true,
});
const parameters = new URLSearchParams(location.search);
const mode = parameters.get("mode") ?? "create";
const radius = Number(parameters.get("radius") ?? "1250");
const client = {
  id: "00000000-0000-4000-8000-000000000001", shortId: 1, fullName: "Synthetic buyer", lastName: "Synthetic surname",
  phone: "900000011", extraPhones: [], source: "PHONE_CALL", kind: "BUYER", currency: "USD",
  budgetMin: "123.45", budgetMax: "678.90", desiredDistrictId: null, desiredType: "APARTMENT", desiredRooms: 2,
  desiredAreaMin: 50, desiredFloorMin: 0, desiredFloorMax: 8, desiredTotalFloors: 12, address: "Synthetic address",
  requirementsNotes: "Synthetic notes", isPersonalLead: false, requirementsFieldsKind: "BUYER", pendingAcceptance: false,
  desiredPlaces: [{ lat: 38.57, lng: 68.78, radiusM: radius, label: "Synthetic place" }],
} as unknown as Client;

function Fixture() {
  const [open, setOpen] = useState(true);
  return open
    ? <ClientFormModal client={mode === "edit" ? client : undefined} initialPhone="900000011" onClose={() => setOpen(false)} />
    : <p>Fixture closed</p>;
}
const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
query.setQueryData(["me"], { permissions: [], readOnly: false });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={query}><MemoryRouter><Fixture /></MemoryRouter></QueryClientProvider>
);
