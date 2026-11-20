// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/** «Позвонить сейчас»: клиент из «первого звонка» и «назначил руководитель» — одной строкой (ревью #326). */
vi.mock("../../../../hooks/useDashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../hooks/useDashboard")>(),
  useDashboardSummary: () => ({
    data: {
      tasksToday: [],
      firstCallDue: [{ id: "c1", shortId: 11, fullName: "Фарход Каримов", phone: "x", dueAt: new Date(Date.now() + 3_600_000).toISOString() }],
      assignedBySupervisor: [
        { id: "c1", shortId: 11, fullName: "Фарход Каримов", phone: "x", assignedAt: new Date().toISOString(), byName: "РОП" },
        { id: "c2", shortId: 12, fullName: "Мадина Рахимова", phone: "x", assignedAt: new Date().toISOString(), byName: "РОП" },
      ],
    },
    isPending: false, isError: false, refetch: vi.fn(),
  }),
}));

import { AgentFirstCalls } from "./agent";

afterEach(cleanup);

describe("«Позвонить сейчас»", () => {
  it("клиент, назначенный руководителем и ждущий первого звонка, стоит один раз — строкой срока", () => {
    render(<MemoryRouter><AgentFirstCalls /></MemoryRouter>);
    expect(screen.getAllByText("Фарход Каримов")).toHaveLength(1);
    expect(screen.getByText(/первый звонок до/)).toBeTruthy();
    expect(screen.getByText("Мадина Рахимова")).toBeTruthy();
  });
});
