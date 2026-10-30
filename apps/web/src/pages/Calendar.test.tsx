import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "./Calendar";

const state = vi.hoisted(() => ({ role: "AGENT", readOnly: false, mobile: false, failed: false }));
vi.mock("../store/auth", () => ({ useAuthStore: (select: (s: { agent: { role: string } }) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock("../lib/permissions", () => ({ useIsReadOnly: () => state.readOnly || state.role === "SHAREHOLDER" }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.mobile }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => true }));
vi.mock("../hooks/useCounters", () => ({ useMarkSectionSeen: () => undefined }));
vi.mock("../store/shell", () => ({ useShellClaim: () => undefined }));
vi.mock("../components/rh2/ShellOwnHeader", () => ({ ShellOwnHeader: () => null }));
vi.mock("../components/CallClientButton", () => ({ CallClientButton: () => <button>Позвонить</button> }));
vi.mock("../hooks/useCalendar", () => ({
  useCalendarTasks: () => ({ data: [{ id: "task", agentId: "agent", clientId: "client", type: "SHOWING", nextAction: "Проверочный показ", nextActionDate: "2026-11-03T11:00:00Z", client: { shortId: 1, fullName: "Тестовый клиент", phone: "test-phone" } }], isLoading: false }),
  useCompleteTask: () => ({ mutate: vi.fn(), reset: vi.fn(), isError: state.failed, error: new Error("Действие запрещено") }),
  useCancelShowing: () => ({ mutate: vi.fn(), reset: vi.fn() }),
  useRescheduleShowing: () => ({ mutate: vi.fn(), reset: vi.fn() }),
}));

function html() { return renderToStaticMarkup(<MemoryRouter initialEntries={["/calendar?date=2026-11-03"]}><Calendar /></MemoryRouter>); }
beforeEach(() => { state.role = "AGENT"; state.readOnly = false; state.mobile = false; state.failed = false; });

describe("calendar role actions", () => {
  for (const mobile of [false, true]) {
    for (const role of ["SECURITY", "SHAREHOLDER"]) {
      it(`${role} can read but cannot change or call, mobile=${mobile}`, () => {
        state.role = role; state.mobile = mobile;
        const view = html();
        expect(view).toContain("Тестовый клиент");
        for (const action of ["Сделано", "Перенести", "Отменить", "Позвонить", "Назначить показ"]) expect(view).not.toContain(action);
      });
    }
    it(`respects personal read-only mode, mobile=${mobile}`, () => {
      state.role = "ADMIN"; state.readOnly = true; state.mobile = mobile;
      const view = html();
      expect(view).not.toContain("Сделано"); expect(view).not.toContain("Назначить показ");
    });
  }
  for (const role of ["ADMIN", "DIRECTOR", "HEAD_OF_SALES", "MANAGER", "AGENT", "EDITOR", "MARKETING"]) {
    it(`preserves ordinary actions for ${role}`, () => {
      state.role = role;
      const view = html();
      expect(view).toContain("Сделано"); expect(view).toContain("Перенести");
    });
  }
  it("shows a failed completion rather than silently leaving the task", () => {
    state.failed = true;
    expect(html()).toContain("Действие запрещено");
  });
});
