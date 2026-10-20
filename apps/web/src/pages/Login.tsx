import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNow } from "../hooks/useNow";
import { api } from "../lib/api";
import { PhoneInput } from "../components/FormField";
import { useAuthStore, type SessionAgent } from "../store/auth";
import { useUiPrefs } from "../store/uiPrefs";
import { useBranding } from "../hooks/useBranding";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import {
  guessDeviceName,
  isPasskeyCancel,
  loginWithPasskey,
  passkeysSupported,
  useAddPasskey,
  type PasskeyDevice,
} from "../hooks/usePasskeys";
import {
  codeFieldLabel,
  deliveryText,
  effectiveChannel,
  fallbackDeadline,
  resendChannel,
  type DeliveryChannel,
} from "../lib/codeDelivery";

/**
 * ЭКРАН ВХОДА — тема «Royal Home 2026», эталон `screens/login.html`.
 *
 * ВХОД БЕЗ ПАРОЛЯ (решение владельца 19.10.2026). Пароли удалены полностью:
 * телефон → код (СМС на свой номер, запасной канал — наш Telegram-бот) →
 * при включённой двухфакторной защите ещё код из приложения. Код сначала идёт
 * пушем на уже вошедший телефон (сервер через 30 с сам шлёт СМС). Плюс вход по
 * отпечатку / Face ID, если устройство умеет и ключ привязан.
 *
 * ОБЛИК. Герб и гравировка золотые (память royalhome-login-gold-redesign-21-08);
 * кнопка `.pill.gold` переопределена в `theme-2026-brand.css` на синюю.
 * Разметка эталонная: `.lgn`, `.lgn-card`, `.gerb`, `.grav`, `.fld`,
 * `.pill.gold`, `.steps`, `.alt`, `.code`, `.quiet.crit`.
 *
 * Существование номера не раскрываем: ответ сервера на запрос кода одинаков для
 * известного и неизвестного номера.
 */

type Step = "phone" | "code" | "offer";

/** Отказ от предложения «входить по отпечатку» помним на этом устройстве. */
const OFFER_DISMISSED_KEY = "rh:passkey-offer-dismissed";

function offerDismissed(): boolean {
  try {
    return localStorage.getItem(OFFER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberOfferDismissed(): void {
  try {
    localStorage.setItem(OFFER_DISMISSED_KEY, "1");
  } catch {
    // Приватный режим — предложим снова, это не страшно.
  }
}

/**
 * Номер для показа: «+992900000001» → «+992900000001». Непривычную длину не
 * ломаем: остаток печатается как есть.
 */
function prettyPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 12) return raw;
  return `+${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10)}`;
}

/** Буквы герба, когда логотип агентства ещё не загружен: «Royal Home» → «RH». */
function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return letters.slice(0, 2) || "RH";
}

interface CodeResponse {
  pendingToken: string;
  channel: DeliveryChannel;
  /** Для channel "push": через сколько секунд сервер сам пришлёт СМС. */
  fallbackAfterSec?: number;
  phoneHint: string;
  resendAfterSec?: number;
  telegramAvailable: boolean;
  devCode?: string;
}

export function Login() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Шаг кода: сервер выслал код (СМС или Telegram) и выдал pendingToken.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [channel, setChannel] = useState<DeliveryChannel>("sms");
  const [fallbackAt, setFallbackAt] = useState(0);
  const [phoneHint, setPhoneHint] = useState<string | null>(null);
  const [telegramAvailable, setTelegramAvailable] = useState(false);
  const [resendAt, setResendAt] = useState<number>(0);
  const [code, setCode] = useState("");
  // Код принят, но у агента включена двухфакторная проверка (приложение).
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const addPasskey = useAddPasskey();
  const canPasskey = passkeysSupported();

  const phoneRef = useRef<HTMLInputElement>(null);

  const branding = useBranding();
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();

  useEffect(() => {
    // Экран открылся — курсор уже в поле.
    if (step === "phone") phoneRef.current?.focus({ preventScroll: true });
  }, [step]);

  function applySession(data: { accessToken: string; agent: SessionAgent }) {
    setSession(data.agent, data.accessToken);
    // force: мог войти другой сотрудник — его тема должна победить локальную.
    useUiPrefs.getState().hydrateFromServer(data.agent.preferences, true);
  }

  /**
   * Вошли КОДОМ: на устройстве с отпечатком / Face ID и без привязанных ключей
   * один раз предлагаем входить без кода. Сервер при входе кодом уже выдал
   * свежее подтверждение личности, поэтому привязка пройдёт сразу.
   */
  async function finishCodeLogin(data: { accessToken: string; agent: SessionAgent }) {
    applySession(data);
    if (canPasskey && !offerDismissed()) {
      try {
        const keys = await api<PasskeyDevice[]>("/me/passkeys");
        if (keys.length === 0) {
          setStep("offer");
          return;
        }
      } catch {
        // Рубильник выключен или связи нет — просто входим.
      }
    }
    navigate("/");
  }

  async function handlePasskeyLogin() {
    setError(null);
    setPasskeyBusy(true);
    try {
      applySession(await loginWithPasskey());
      navigate("/");
    } catch (err) {
      // Отказ устройства — тихо остаёмся на коде.
      if (!isPasskeyCancel(err)) setError(err instanceof Error ? err.message : "Не удалось войти по отпечатку");
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function handleEnablePasskey() {
    setOfferError(null);
    try {
      await addPasskey.mutateAsync(guessDeviceName());
      navigate("/");
    } catch (err) {
      if (isPasskeyCancel(err)) return;
      setOfferError(err instanceof Error ? err.message : "Не удалось включить вход по отпечатку");
    }
  }

  function handleSkipOffer() {
    rememberOfferDismissed();
    navigate("/");
  }

  /** Запросить код: первый раз, повторно или в другом канале. */
  async function requestCode(wanted?: "sms" | "telegram") {
    setError(null);
    if (phone.replace(/\D/g, "").length < 9) {
      setError("Введите номер полностью — например, +992900000001");
      return;
    }
    setLoading(true);
    try {
      const r = await api<CodeResponse>("/auth/login/code", {
        method: "POST",
        body: wanted ? { phone, channel: wanted } : { phone },
      });
      setPendingToken(r.pendingToken);
      setChannel(r.channel);
      setFallbackAt(fallbackDeadline(r.channel, r.fallbackAfterSec, Date.now()));
      setPhoneHint(r.phoneHint);
      setTelegramAvailable(r.telegramAvailable);
      setResendAt(Date.now() + (r.resendAfterSec ?? 60) * 1000);
      // devCode приходит только на локальном стенде — подставляем сами.
      setCode(r.devCode ?? "");
      setStep("code");
    } catch (err) {
      const wait = (err as { resendAfterSec?: number } | null)?.resendAfterSec;
      if (wait) setResendAt(Date.now() + wait * 1000);
      setError(err instanceof Error ? err.message : "Не удалось отправить код");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await api<{ accessToken: string; agent: SessionAgent } | { requiresTotp: true; pendingToken: string }>(
        "/auth/login/verify-code",
        { method: "POST", body: { pendingToken, code } },
      );
      if ("requiresTotp" in data) {
        setTotpToken(data.pendingToken);
      } else {
        await finishCodeLogin(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Неверный код");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyTotp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await api<{ accessToken: string; agent: SessionAgent }>("/auth/login/verify-totp", {
        method: "POST",
        body: { pendingToken: totpToken, code: totpCode },
      });
      await finishCodeLogin(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Неверный код");
    } finally {
      setLoading(false);
    }
  }

  const name = branding?.companyName ?? "Royal Home";
  const slogan = branding?.companySlogan ?? "Агентство недвижимости";
  const logoUrl = branding?.companyLogoUrl ?? null;
  const gerb = <Gerb logoUrl={logoUrl} name={name} />;

  return (
    <Rh2Screen>
      <div className="lgn">
        {step === "offer" ? (
          <form
            className="lgn-card"
            onSubmit={(e) => {
              e.preventDefault();
              void handleEnablePasskey();
            }}
          >
            {gerb}
            <h1>Входить по отпечатку / Face ID без кода?</h1>
            <p className="sub">Отпечаток и лицо остаются внутри устройства. В следующий раз войдёте одним касанием.</p>

            <div className="grav" aria-hidden />

            {offerError && <ErrorNote>{offerError}</ErrorNote>}

            <button className="pill gold" type="submit" disabled={addPasskey.isPending}>
              {addPasskey.isPending ? "Ждём устройство…" : "Включить"}
            </button>
            <p className="alt">
              <button className="lnk" type="button" onClick={handleSkipOffer} disabled={addPasskey.isPending}>
                Не сейчас
              </button>
            </p>
          </form>
        ) : totpToken ? (
          <CodeStep
            totp
            channel="sms"
            fallbackAt={0}
            hint={null}
            resendAt={0}
            code={totpCode}
            setCode={setTotpCode}
            error={error}
            loading={loading}
            gerb={gerb}
            onSubmit={handleVerifyTotp}
            onBack={() => {
              setTotpToken(null);
              setTotpCode("");
              setError(null);
            }}
          />
        ) : step === "code" ? (
          <CodeStep
            channel={channel}
            fallbackAt={fallbackAt}
            hint={phoneHint}
            phoneLabel={prettyPhone(phone)}
            resendAt={resendAt}
            onResend={() => void requestCode(resendChannel(channel))}
            onTelegram={telegramAvailable && channel !== "telegram" ? () => void requestCode("telegram") : undefined}
            code={code}
            setCode={setCode}
            error={error}
            loading={loading}
            gerb={gerb}
            onSubmit={handleVerifyCode}
            onBack={() => {
              setStep("phone");
              setPendingToken(null);
              setCode("");
              setError(null);
            }}
          />
        ) : (
          <form
            className="lgn-card"
            onSubmit={(e) => {
              e.preventDefault();
              void requestCode();
            }}
            key="phone"
          >
            {gerb}
            <h1>{name}</h1>
            <p className="sub">{slogan}</p>

            <div className="grav" aria-hidden />

            <label className={`fld${error ? " bad" : ""}`}>
              <span className="lab">Рабочий телефон</span>
              <PhoneInput
                ref={phoneRef}
                id="login-phone"
                name="phone"
                autoComplete="username"
                value={phone}
                onChange={setPhone}
                required
              />
            </label>

            {error && <ErrorNote>{error}</ErrorNote>}

            <button className="pill gold" type="submit" disabled={loading}>
              {loading ? "Отправляем код…" : "Получить код"}
            </button>
            <div className="steps" aria-hidden>
              <i className="on" />
              <i />
            </div>
            {canPasskey && (
              <p className="alt">
                <button className="lnk" type="button" onClick={() => void handlePasskeyLogin()} disabled={loading || passkeyBusy}>
                  {passkeyBusy ? "Ждём устройство…" : "Войти по отпечатку / Face ID"}
                </button>
              </p>
            )}
            <p className="alt">Пришлём код уведомлением на ваш телефон или в СМС.</p>
          </form>
        )}
      </div>
    </Rh2Screen>
  );
}

/**
 * Герб агентства — золотая плашка эталона (`.gerb`). Загруженный логотип
 * показываем поверх неё как есть. Без логотипа остаются буквы названия («RH»).
 */
function Gerb({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  if (logoUrl) {
    return (
      <div className="gerb" style={{ background: "none", boxShadow: "none" }}>
        <img src={logoUrl} alt="" style={{ width: 76, height: 76, objectFit: "contain" }} />
      </div>
    );
  }
  return (
    <div className="gerb" aria-hidden>
      {initials(name)}
    </div>
  );
}

/**
 * Ошибка входа — «тихой строкой, не карточкой» (эталон). role="alert", чтобы
 * озвучка экрана прочитала её сразу.
 */
function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="quiet crit" role="alert" style={{ justifyContent: "center", borderBottom: 0, marginTop: 8 }}>
      <span className="dot crit" />
      <span className="txt" style={{ flex: "0 1 auto" }}>
        {children}
      </span>
    </div>
  );
}

/**
 * Шаг ввода кода: код входа (СМС / Telegram) или код из приложения-аутентификатора.
 * Поле одно на все шесть цифр — так работает автоподстановка `one-time-code`
 * и вставка кода целиком.
 */
function CodeStep({
  totp,
  channel,
  fallbackAt,
  hint,
  phoneLabel,
  resendAt,
  onResend,
  onTelegram,
  code,
  setCode,
  error,
  loading,
  gerb,
  onSubmit,
  onBack,
}: {
  totp?: boolean;
  channel: DeliveryChannel;
  fallbackAt: number;
  hint: string | null;
  phoneLabel?: string;
  resendAt: number;
  onResend?: () => void;
  onTelegram?: () => void;
  code: string;
  setCode: (v: string) => void;
  error: string | null;
  loading: boolean;
  gerb: React.ReactNode;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}) {
  // Секунды до «Отправить ещё раз» и до СМС после пуша — тикают раз в секунду,
  // только пока ждём код.
  const now = useNow(!totp);
  const waitSec = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const label = totp ? "Код из приложения-аутентификатора" : codeFieldLabel(effectiveChannel(channel, fallbackAt, now));
  const sub = totp
    ? "Шесть цифр из приложения-аутентификатора на вашем телефоне"
    : channel === "sms"
      ? `Шесть цифр из СМС на номер ${hint ?? phoneLabel ?? ""}`.trim()
      : deliveryText(channel, fallbackAt, now, hint ?? phoneLabel ?? null);

  return (
    <form className="lgn-card" onSubmit={onSubmit}>
      {gerb}
      <h1>Код подтверждения</h1>
      <p className="sub">{sub}</p>

      <div className="grav" aria-hidden />

      <div className="code" role="group" aria-label={label}>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder="000000"
          aria-label={label}
          style={{ width: "100%", maxWidth: 300, letterSpacing: ".28em", fontSize: "var(--fs-23)" }}
          required
        />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <button className="pill gold" type="submit" disabled={loading || code.length !== 6}>
        {loading ? "Проверяем…" : "Подтвердить"}
      </button>
      {!totp && onResend && (
        <p className="alt">
          <button className="lnk" type="button" onClick={onResend} disabled={waitSec > 0 || loading}>
            {waitSec > 0 ? `Отправить ещё раз через ${waitSec} с` : "Отправить ещё раз"}
          </button>
        </p>
      )}
      {onTelegram && !totp && (
        <p className="alt">
          <button className="lnk" type="button" onClick={onTelegram} disabled={loading}>
            Прислать в Telegram
          </button>
        </p>
      )}
      <p className="alt">
        <button className="lnk" type="button" onClick={onBack}>
          {totp ? "Назад ко входу" : "Изменить номер"}
        </button>
      </p>
    </form>
  );
}
