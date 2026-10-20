import { useEffect, useState } from "react";
import { claimStepUp } from "../lib/stepUpOwners";
import { guessDeviceName, isPasskeyCancel, passkeysSupported, useAddPasskey, usePasskeys, useRemovePasskey } from "../hooks/usePasskeys";
import { useSettings } from "../hooks/useSettings";
import { ApiError } from "../lib/api";
import { dushanbeDateTime } from "../lib/date";
import { ConfirmDialog } from "./ConfirmDialog";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Вход по отпечатку и лицу: управление своими устройствами.
 *
 * Что здесь важно объяснить человеку, а не только запрограммировать: отпечаток
 * никуда не отправляется. Он остаётся внутри телефона, а CRM хранит только
 * открытую часть ключа, которой войти нельзя. Без этого объяснения половина
 * сотрудников просто не станет включать, а другая половина решит, что мы
 * собираем их биометрию.
 *
 * ОБЛИК: блок «Ключ этого устройства» прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/profile.html): строка `.mod` с кнопкой и
 * список привязанных ключей строками `.list`/`.row`. Своей карточки нет:
 * компонент вставляется в общую секцию «Вход и безопасность» профиля.
 */
export function PasskeySettings() {
  // Своё окно подтверждения — общее (GlobalStepUpHost) не открывается поверх.
  useEffect(() => claimStepUp(), []);
  const supported = passkeysSupported();
  const { data: settings } = useSettings();
  // Общий рубильник (Настройки → Система, виден и рядовому агенту через
  // toStaffSettings). undefined, пока настройки грузятся, считаем включённым,
  // иначе список привязанных устройств на миг пропадал бы при каждой загрузке.
  const enabled = settings?.passkeyLoginEnabled ?? true;
  const { data: devices } = usePasskeys(supported);
  const add = useAddPasskey();
  const remove = useRemovePasskey();
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /**
   * Действие, прерванное требованием подтвердить личность (428 от сервера).
   * Держим саму функцию, а не флаг: после ввода пароля нужно повторить ровно
   * то, что человек начал, привязку или отвязку конкретного устройства.
   */
  const [pendingAction, setPendingAction] = useState<{ run: () => void; description: string } | null>(null);

  if (!supported) return null;

  /** Общий разбор отказа: 428 это не ошибка, а «подтвердите и повторим». */
  function handleFailure(err: unknown, retry: () => void, description: string): void {
    if (err instanceof ApiError && err.status === 428) {
      setPendingAction({ run: retry, description });
      return;
    }
    // Отказ в системном диалоге тоже не ошибка: человек передумал.
    if (isPasskeyCancel(err)) return;
    setError(err instanceof Error ? err.message : "Не удалось привязать устройство");
  }

  async function handleAdd() {
    setError(null);
    try {
      await add.mutateAsync(guessDeviceName());
    } catch (err) {
      handleFailure(
        err,
        () => void handleAdd(),
        "Привязка входа по отпечатку даёт постоянный доступ к учётке. Подтвердите, что это вы."
      );
    }
  }

  function handleRemove(id: string) {
    setError(null);
    remove.mutate(id, {
      onError: (err) =>
        handleFailure(err, () => handleRemove(id), "Отвязка устройства это тоже изменение доступа. Подтвердите, что это вы."),
    });
  }

  return (
    <>
      <div className="mod">
        <div className="t">
          <b>Ключ этого устройства</b>
          <span>
            Вход отпечатком или лицом вместо кода из СМС. Отпечаток и лицо остаются внутри устройства: CRM хранит
            только ключ проверки, войти по нему нельзя.
          </span>
        </div>
        <div className="acts">
          {enabled ? (
            <button className="pill ghost sm" type="button" onClick={handleAdd} disabled={add.isPending}>
              {add.isPending ? "Ждём устройство" : devices?.length ? "Добавить ещё ключ" : "Добавить ключ"}
            </button>
          ) : (
            <span className="chip warn">Отключено администратором</span>
          )}
        </div>
        {!enabled && (
          <div className="quiet warn">
            <span className="dot warn" />
            <span className="txt">
              Временно отключено администратором для всех сотрудников. Уже привязанные ключи ниже никуда не
              делись и заработают снова, как только это включат обратно.
            </span>
          </div>
        )}
        {error && (
          <div className="quiet crit">
            <span className="dot crit" />
            <span className="txt">{error}</span>
          </div>
        )}
      </div>

      {devices && devices.length > 0 && (
        <div className="list" style={{ marginTop: 4 }}>
          {devices.map((d) => (
            <div className="row" key={d.id}>
              <span className="av" style={{ background: "var(--soft)", color: "var(--muted)" }}>
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="4" y="3" width="16" height="18" rx="3" />
                  <path d="M10 18h4" />
                </svg>
              </span>
              <div className="t">
                <b>{d.deviceName ?? "Устройство"}</b>
                <span>{d.lastUsedAt ? `Последний вход ${dushanbeDateTime(d.lastUsedAt)}` : "Ещё не использовалось"}</span>
              </div>
              <div className="act">
                <button className="pill ghost sm" type="button" onClick={() => setConfirmRemove(d.id)}>
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Отвязать устройство?"
          description="Войти по отпечатку с него больше не получится. Вход по коду из СМС и другие устройства продолжат работать."
          confirmLabel="Отвязать"
          onConfirm={() => {
            handleRemove(confirmRemove);
            setConfirmRemove(null);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}

      {pendingAction && (
        <StepUpDialog
          description={pendingAction.description}
          onConfirmed={() => {
            const { run } = pendingAction;
            setPendingAction(null);
            run();
          }}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </>
  );
}
