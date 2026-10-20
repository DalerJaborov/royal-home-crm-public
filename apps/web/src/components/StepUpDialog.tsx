import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useNow } from "../hooks/useNow";
import { codeFieldLabel, effectiveChannel, deliveryText, resendChannel } from "../lib/codeDelivery";
import { useStepUpCode, type StepUpMethod } from "../hooks/useStepUpCode";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

/**
 * Подтверждение личности перед ОТДЕЛЬНЫМ действием, а не перед целым разделом.
 *
 * У нас уже есть StepUpGate — он закрывает замком весь экран Настроек. Для
 * действий внутри Профиля это не годится: требовать пароль на открытие своего же
 * профиля — издевательство, а защитить нужно ровно две вещи внутри него, привязку
 * ключа и включение 2FA (см. routes/me.ts, почему именно их).
 *
 * Поэтому окно поднимается по факту отказа сервера (428 stepUpRequired), а после
 * подтверждения вызывающий код повторяет прерванное действие сам — состояние
 * действия знает только он.
 *
 * Способ подтверждения выбирает сервер: код из приложения, если 2FA включена,
 * иначе код из СМС (запасной канал — Telegram). Паролей в системе больше нет.
 *
 * ОБЛИК — дословно окно `#sh-stepup` прототипа (`screens/team.html`): шторка
 * `.sheet` с полем `.field`/`.inp`, объяснением тихой строкой `.state` и двумя
 * кнопками `.pill` в подвале. Договор дизайна §6.9 называет это единственным
 * разрешённым модальным окном темы.
 */
export function StepUpDialog({
  title = "Подтвердите, что это вы",
  description,
  onConfirmed,
  onCancel,
}: {
  title?: string;
  description: string;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<StepUpMethod | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const codeSend = useStepUpCode(setCode);
  const sendCode = codeSend.send;

  useEffect(() => {
    // Отказ читаем как «подтверждаем кодом из СМС»: самый частый случай.
    api<{ elevated: boolean; method: StepUpMethod }>("/auth/step-up")
      .then((s) => setMethod(s.method))
      .catch(() => setMethod("code"));
  }, []);

  useEffect(() => {
    if (method === "code") void sendCode();
  }, [method, sendCode]);

  const isTotp = method === "totp";
  const now = useNow(method === "code");
  const waitSec = Math.max(0, Math.ceil((codeSend.resendAt - now) / 1000));
  const ready = code.length === 6;

  async function submit() {
    if (!ready || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await api("/auth/step-up", { method: "POST", body: { code } });
      onConfirmed();
    } catch (err) {
      // 429 от лимитера — не «неверный код»: сообщение сервера точнее нашего.
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Не удалось подтвердить");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Rh2Sheet
      open
      onClose={onCancel}
      title={title}
      /* Корень шторки САМ является формой (см. Rh2Sheet): своей формы внутри
         заводить нельзя — вложенные формы недопустимы, и Enter в поле уходил бы
         во внутреннюю, а кнопка подтверждения живёт в подвале, вне её. Поэтому
         отправка объявлена корпусу, а кнопка подвала — обычный submit. */
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onCancel}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={submitting || !ready}>
            {submitting ? "Проверяем…" : "Подтвердить"}
          </button>
        </>
      }
    >
      <p className="state">{description}</p>

      {method === null ? (
        <p className="state">Проверяем, как подтвердить…</p>
      ) : (
        <label className="field" style={{ marginTop: 12 }}>
          <span className="lab">{isTotp ? "Код подтверждения" : codeFieldLabel(effectiveChannel(codeSend.channel, codeSend.fallbackAt, now))}</span>
          <input
            className="inp"
            style={{ maxWidth: "none" }}
            autoFocus
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="6 цифр"
            aria-label={isTotp ? "Код из приложения-аутентификатора" : codeFieldLabel(effectiveChannel(codeSend.channel, codeSend.fallbackAt, now))}
          />
        </label>
      )}

      {method === "code" && (
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
        <p className="state err">
          <span className="dot crit" />
          {error ?? codeSend.sendError}
        </p>
      )}
      <p className="state">Подтверждение спрашивается один раз за сеанс работы.</p>
    </Rh2Sheet>
  );
}
