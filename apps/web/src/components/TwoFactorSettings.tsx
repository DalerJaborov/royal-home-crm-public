import { useEffect, useState } from "react";
import { claimStepUp } from "../lib/stepUpOwners";
import { useMyProfile } from "../hooks/useMe";
import { useSetupTotp, useConfirmTotp, useDisableTotp } from "../hooks/useTwoFactor";
import { ApiError } from "../lib/api";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Двухфакторная защита.
 *
 * ОБЛИК: строка «Двухфакторная защита» прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/profile.html): `.mod` с пилюлей состояния
 * `.chip.ok` и кнопкой. Формы настройки и отключения, которых в макете нет,
 * одеты в те же `.fld`, `.pill` и `.state`. Своей карточки нет: компонент
 * вставляется в общую секцию «Вход и безопасность» профиля.
 */
export function TwoFactorSettings() {
  // Своё окно подтверждения — общее (GlobalStepUpHost) не открывается поверх.
  useEffect(() => claimStepUp(), []);
  const { data: profile, isLoading } = useMyProfile();
  const setup = useSetupTotp();
  const confirm = useConfirmTotp();
  const disable = useDisableTotp();

  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [confirmError, setConfirmError] = useState("");

  const [disablePassword, setDisablePassword] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [disableError, setDisableError] = useState("");

  /**
   * Включение 2FA прерывается требованием подтвердить личность (428): с чужой
   * открытой вкладки можно было привязать свой аутентификатор и запереть
   * хозяина учётки снаружи. Держим прерванное действие, чтобы повторить его
   * после ввода пароля, см. StepUpDialog.
   */
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  /** true, если отказ разобран как «нужно подтвердить личность». */
  function askStepUp(err: unknown, retry: () => void): boolean {
    if (err instanceof ApiError && err.status === 428) {
      // Функция в состоянии только через обёртку: setState(fn) вызвал бы её.
      setPendingAction(() => retry);
      return true;
    }
    return false;
  }

  async function startSetup() {
    setConfirmError("");
    try {
      const res = await setup.mutateAsync();
      setQrCode(res.qrCodeDataUrl);
      setSecret(res.secret);
    } catch (e) {
      if (askStepUp(e, () => void startSetup())) return;
      setConfirmError(e instanceof Error ? e.message : "Не удалось начать настройку");
    }
  }

  function cancelSetup() {
    setQrCode(null);
    setSecret(null);
    setCode("");
    setConfirmError("");
  }

  async function confirmSetup() {
    setConfirmError("");
    try {
      await confirm.mutateAsync(code);
      cancelSetup();
    } catch (e) {
      // Подтверждение личности могло истечь, пока сканировали QR-код.
      if (askStepUp(e, () => void confirmSetup())) return;
      setConfirmError(e instanceof Error ? e.message : "Неверный код");
    }
  }

  async function doDisable() {
    setDisableError("");
    try {
      await disable.mutateAsync(disablePassword);
      setShowDisable(false);
      setDisablePassword("");
    } catch (e) {
      // Отключение с 24.09.2026 (ночная проверка) тоже под подтверждением
      // личности, как включение: без этой ветки 428 показывался бы строкой
      // ошибки, а не окном.
      if (askStepUp(e, () => void doDisable())) return;
      setDisableError(e instanceof Error ? e.message : "Неверный код");
    }
  }

  const enabled = profile?.totpEnabled;

  return (
    <>
      <div className="mod">
        <div className="t">
          <b>Двухфакторная защита</b>
          <span>
            Код из приложения-аутентификатора вторым шагом после кода из СМС. Даже если СМС перехватят, зайти не
            смогут. С ней Настройки CRM открываются только кодом из приложения.
          </span>
        </div>
        <div className="acts">
          {isLoading ? (
            <span className="chip mute">Загружаем</span>
          ) : qrCode ? (
            <span className="chip">Настраиваем</span>
          ) : enabled ? (
            <>
              <span className="chip ok">Включена</span>
              {!showDisable && (
                <button className="pill ghost sm" type="button" onClick={() => setShowDisable(true)}>
                  Отключить
                </button>
              )}
            </>
          ) : (
            <button className="pill ghost sm" type="button" onClick={startSetup} disabled={setup.isPending}>
              {setup.isPending ? "Генерация" : "Настроить"}
            </button>
          )}
        </div>

        {qrCode && (
          <div style={{ flex: "1 1 100%", display: "flex", flexDirection: "column", gap: 12, maxWidth: 360 }}>
            <img src={qrCode} alt="QR-код для приложения-аутентификатора" style={{ width: 176, height: 176 }} />
            {secret && <p className="state">Не сканируется? Введите вручную: {secret}</p>}
            <label className="fld">
              <span className="lab">Код из приложения</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
              />
            </label>
            {confirmError && (
              <div className="quiet crit">
                <span className="dot crit" />
                <span className="txt">{confirmError}</span>
              </div>
            )}
            <span className="wrap">
              <button className="pill sm" type="button" onClick={confirmSetup} disabled={code.length !== 6 || confirm.isPending}>
                {confirm.isPending ? "Проверка" : "Включить"}
              </button>
              <button className="pill ghost sm" type="button" onClick={cancelSetup}>
                Отмена
              </button>
            </span>
          </div>
        )}

        {enabled && showDisable && (
          <div style={{ flex: "1 1 100%", display: "flex", flexDirection: "column", gap: 12, maxWidth: 360 }}>
            <p className="state">
              Код из СМС здесь не подходит, так задумано: даже перехватив СМС, отключить защиту без вашего телефона
              нельзя. Потеряли телефон, 2FA сбросит директор в Настройках.
            </p>
            <label className="fld">
              <span className="lab">Подтвердите кодом из приложения</span>
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
              />
            </label>
            {disableError && (
              <div className="quiet crit">
                <span className="dot crit" />
                <span className="txt">{disableError}</span>
              </div>
            )}
            <span className="wrap">
              <button
                className="pill sm"
                type="button"
                onClick={doDisable}
                disabled={disablePassword.length !== 6 || disable.isPending}
              >
                {disable.isPending ? "Отключение" : "Да, отключить"}
              </button>
              <button
                className="pill ghost sm"
                type="button"
                onClick={() => {
                  setShowDisable(false);
                  setDisableError("");
                }}
              >
                Отмена
              </button>
            </span>
          </div>
        )}
      </div>

      {pendingAction && (
        <StepUpDialog
          description="Двухфакторная защита меняет то, как вы входите в CRM. Подтвердите, что это вы."
          onConfirmed={() => {
            const run = pendingAction;
            setPendingAction(null);
            run();
          }}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </>
  );
}
