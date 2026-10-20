import { useEffect, useState } from "react";
import { claimStepUp } from "../lib/stepUpOwners";
import { Loader2, ShieldCheck, Smartphone } from "lucide-react";
import { codeFieldLabel, effectiveChannel, deliveryText, resendChannel } from "../lib/codeDelivery";
import { api } from "../lib/api";
import { useNow } from "../hooks/useNow";
import { useStepUpCode, type StepUpMethod } from "../hooks/useStepUpCode";

interface StepUpStatus {
  elevated: boolean;
  method: StepUpMethod;
}

/**
 * «Замок» перед критичным разделом (Настройки CRM): требует свежего подтверждения
 * личности — код Google Authenticator (если 2FA включена) или код из СМС (запасной канал — Telegram). Сервер
 * дублирует проверку на каждом изменении (requireElevation, 428), так что это
 * не только UI-барьер. Элевация живёт 10 минут.
 */
export function StepUpGate({ children }: { children: React.ReactNode }) {
  const now = useNow(true);
  // Своё окно подтверждения — общее (GlobalStepUpHost) не открывается поверх.
  useEffect(() => claimStepUp(), []);
  const [status, setStatus] = useState<StepUpStatus | null>(null);
  const [code, setCode] = useState("");
  const codeSend = useStepUpCode(setCode);
  const sendCode = codeSend.send;
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<StepUpStatus>("/auth/step-up").then(setStatus).catch(() => setStatus({ elevated: false, method: "code" }));
  }, []);

  useEffect(() => {
    if (status?.method === "code" && !status.elevated) void sendCode();
  }, [status?.method, status?.elevated, sendCode]);

  // Десять минут истекают на открытой странице: сервер начинает отвечать 428, а
  // замок уже снят. Возвращаем его, иначе каждое сохранение молча отказывает.
  useEffect(() => {
    const onExpired = () => setStatus((s) => (s ? { ...s, elevated: false } : s));
    window.addEventListener("step-up-required", onExpired);
    return () => window.removeEventListener("step-up-required", onExpired);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api("/auth/step-up", {
        method: "POST",
        body: { code },
      });
      setStatus((s) => (s ? { ...s, elevated: true } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось подтвердить");
    } finally {
      setSubmitting(false);
    }
  }

  if (!status) {
    return (
      <div className="card tight">
        <div className="state">
          <span className="sk w28" />
          <span className="sk w22" /> Проверяем подтверждение личности
        </div>
      </div>
    );
  }

  if (status.elevated) return <>{children}</>;

  const isTotp = status.method === "totp";
  const waitSec = Math.max(0, Math.ceil((codeSend.resendAt - now) / 1000));
  // Разметка темы «Royal Home 2026»: карточка эталона с заголовком-секцией,
  // полем `.fld` и кнопкой-капсулой. Поведение прежнее — код из приложения или
  // пароль, элевация на 10 минут, сервер дублирует проверку (428).
  return (
    <div className="card" style={{ maxWidth: 460, margin: "0 auto" }}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "var(--s4)" }}>
          <h2 style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <ShieldCheck className="i lg" aria-hidden="true" />
            Подтвердите, что это вы
          </h2>
          <p className="sub" style={{ marginTop: 6, fontSize: "var(--fs-13)", color: "var(--muted)" }}>
            {isTotp
              ? "Введите код из приложения-аутентификатора (Google Authenticator), чтобы открыть настройки на 10 минут."
              : `Введите код из ${codeSend.channel === "telegram" ? "Telegram" : codeSend.channel === "push" && now < codeSend.fallbackAt ? "уведомления" : "СМС"}, чтобы открыть настройки на 10 минут.`}
          </p>
        </div>
        <label className="fld">
          <span className="lab">{isTotp ? "Код из приложения" : codeFieldLabel(effectiveChannel(codeSend.channel, codeSend.fallbackAt, now))}</span>
          <input
            autoFocus
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="000000"
            style={{ textAlign: "center", letterSpacing: "0.4em", fontWeight: 600 }}
          />
        </label>
        {status.method === "code" && (
        <p className="state">
            {deliveryText(codeSend.channel, codeSend.fallbackAt, now, codeSend.phoneHint)}{" "}
          <button type="button" className="lnk" disabled={waitSec > 0 || codeSend.sending} onClick={() => void codeSend.send(resendChannel(codeSend.channel))}>
              {waitSec > 0 ? `Отправить ещё раз через ${waitSec} с` : "Отправить ещё раз"}
          </button>
            {codeSend.telegramAvailable && codeSend.channel !== "telegram" && (
            <>
                {" "}
              <button type="button" className="lnk" disabled={codeSend.sending} onClick={() => void codeSend.send("telegram")}>
                Прислать в Telegram
              </button>
            </>
          )}
        </p>
      )}

        {(error || codeSend.sendError) && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">{error ?? codeSend.sendError}</span>
          </div>
        )}
        <div className="wrap" style={{ marginTop: "var(--s4)" }}>
          <button
            className="pill"
            type="submit"
            disabled={submitting || code.length !== 6}
          >
            {submitting ? <Loader2 className="i animate-spin" /> : isTotp ? <Smartphone className="i" /> : null}
            Подтвердить
          </button>
        </div>
      </form>
    </div>
  );
}
