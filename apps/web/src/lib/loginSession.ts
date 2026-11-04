import { refreshAccessToken } from "./api";
import { useAuthStore } from "../store/auth";

export type LoginSessionResult = "signed-in" | "guest" | "offline";

/** Refresh alone owns invalidation: only its confirmed 401 clears hasSession.
 * A timeout/502/null must not invite the same person to request another OTP. */
export async function restoreLoginSession(): Promise<LoginSessionResult> {
  try {
    const token = await refreshAccessToken();
    if (token) return "signed-in";
  } catch {
    // Keep the persisted session on transport failure; the screen offers retry.
  }
  const { hasSession, accessToken } = useAuthStore.getState();
  if (accessToken) return "signed-in";
  return hasSession ? "offline" : "guest";
}
