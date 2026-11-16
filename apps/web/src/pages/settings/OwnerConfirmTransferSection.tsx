import { TRANSFER_CONFIRM_HOURS_DEFAULT } from "@royal-home/shared";
import { SwitchRow } from "../../components/Switch";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";

/**
 * «Передача с подтверждением хозяина» (владелец 16.11.2026): рубильник и срок ответа.
 * Включено — РОП просит передать объект или клиента, и передача срабатывает только после «Подтвердить»
 * у текущего хозяина. Не ответил за срок — передача отменяется. Директор передаёт сразу при любом положении.
 */
const HOURS_CHOICES = [2, 6, 12, 24, 48, 72, 168];

function hoursLabel(h: number): string {
  if (h % 24 === 0) {
    const d = h / 24;
    return d === 1 ? "1 сутки" : `${d} суток`;
  }
  return `${h} ч`;
}

export function OwnerConfirmTransferSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const on = settings?.ownerConfirmTransferEnabled ?? true;
  const hours = settings?.ownerConfirmTransferHours ?? TRANSFER_CONFIRM_HOURS_DEFAULT;
  const choices = HOURS_CHOICES.includes(hours) ? HOURS_CHOICES : [...HOURS_CHOICES, hours].sort((a, b) => a - b);

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Передача клиента или объекта</h2>
        <span className="note">Руководитель отдела продаж просит, хозяин подтверждает</span>
      </div>
      <SwitchRow
        title="Спрашивать хозяина перед передачей"
        on={on}
        onToggle={() => updateSettings.mutate({ ownerConfirmTransferEnabled: !on })}
        hint={
          on
            ? "Руководитель отдела продаж может передать любой объект или клиента другому агенту, но сначала хозяину приходит большое окно: «Подтвердить» или «Отказать». Директор передаёт сразу, без вопроса."
            : "Выключено: руководитель отдела продаж передавать объекты и клиентов не может. Директор передаёт сразу, как и раньше."
        }
      />
      <label className="fld" style={{ marginTop: "var(--s3)" }}>
        <span className="lab">Сколько ждать ответа хозяина</span>
        <select
          value={hours}
          disabled={!on || updateSettings.isPending}
          onChange={(e) => updateSettings.mutate({ ownerConfirmTransferHours: Number(e.target.value) })}
        >
          {choices.map((h) => (
            <option key={h} value={h}>
              {hoursLabel(h)}
            </option>
          ))}
        </select>
        <span className="msg">
          Хозяин не ответил за это время — передача отменяется, карточка остаётся у него, директору ничего не уходит.
          Пока ждём, хозяину раз в полчаса приходит напоминание.
        </span>
      </label>
    </section>
  );
}
