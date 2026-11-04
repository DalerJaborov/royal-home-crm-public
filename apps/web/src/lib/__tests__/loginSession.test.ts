import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hasSession: true, accessToken: null as string | null }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ refreshAccessToken: refresh }));
vi.mock("../../store/auth", () => ({ useAuthStore: { getState: () => state } }));
import { restoreLoginSession } from "../loginSession";

beforeEach(() => { state.hasSession = true; state.accessToken = null; refresh.mockReset(); });

describe("login route refresh outcomes", () => {
  it("a confirmed expired cookie permits the normal login form", async () => {
    refresh.mockImplementation(async () => { state.hasSession = false; return null; });
    expect(await restoreLoginSession()).toBe("guest");
  });
  it("502/503 retains the session and asks for retry, never another OTP", async () => {
    refresh.mockResolvedValue(null);
    expect(await restoreLoginSession()).toBe("offline");
    expect(state.hasSession).toBe(true);
  });
  it("a network failure retains the session", async () => {
    refresh.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await restoreLoginSession()).toBe("offline");
  });
  it("a retry after server recovery opens the CRM", async () => {
    refresh.mockResolvedValueOnce(null).mockResolvedValueOnce("refreshed-test-token");
    expect(await restoreLoginSession()).toBe("offline");
    expect(await restoreLoginSession()).toBe("signed-in");
  });
  it("an explicit logout while refresh waits returns to normal login", async () => {
    refresh.mockImplementation(async () => { state.hasSession = false; throw new Error("offline"); });
    expect(await restoreLoginSession()).toBe("guest");
  });
});
