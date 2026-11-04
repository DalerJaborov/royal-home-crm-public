import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { restoreLoginSession, type LoginSessionResult } from "../lib/loginSession";
import { AppSkeleton } from "./AppSkeleton";
import { Rh2Screen } from "./rh2/Rh2Screen";

/** Check only the session present on route entry. A new OTP login still owns
 * its passkey-offer step; setting its session must not skip that screen. */
export function LoginSessionGate({ children }: { children: React.ReactNode }) {
  const [entry] = useState<LoginSessionResult | "restore">(() => {
    const { hasSession, accessToken } = useAuthStore.getState();
    return accessToken ? "signed-in" : hasSession ? "restore" : "guest";
  });
  const [result, setResult] = useState<LoginSessionResult | "restore">(entry);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (entry !== "restore") return;
    let active = true;
    setResult("restore");
    void restoreLoginSession().then((next) => { if (active) setResult(next); });
    return () => { active = false; };
  }, [entry, attempt]);
  useEffect(() => {
    if (result !== "offline") return;
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [result]);
  if (result === "restore") return <AppSkeleton />;
  if (result === "signed-in") return <Navigate to="/" replace />;
  if (result === "offline") return (
    <Rh2Screen>
      <div className="lgn">
        <section className="lgn-card" aria-labelledby="session-retry-title">
          <h1 id="session-retry-title">Восстанавливаем вход</h1>
          <p className="sub" role="status">Не удалось проверить сохранённый вход. Проверьте соединение и повторите.</p>
          <button className="pill gold" type="button" onClick={() => setAttempt((n) => n + 1)}>Повторить</button>
        </section>
      </div>
    </Rh2Screen>
  );
  return <>{children}</>;
}
