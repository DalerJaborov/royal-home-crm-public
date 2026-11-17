import { useEffect, useState } from "react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";

/**
 * «ПРОПУЩЕННЫЙ ЗВОНОК НЕ ТЕРЯЕТСЯ» (18.11.2026). Два тумблера и текст СМС в разделе «Входящие».
 * Оба тумблера выключены по умолчанию и действуют сразу, без перезапуска: сервер читает
 * настройку при каждом звонке (lib/telephony/missedCallFollowup.ts).
 * Один экран для ПК и телефона: отдельной мобильной копии у настроек нет.
 */

/** Кириллица в СМС: 70 знаков в одной части, 67 в склейке (разведка 18.11). Оценка для подсказки. */
export function smsPartsEstimate(text: string): number {
  const length = Array.from(text).length;
  if (length === 0) return 0;
  return length <= 70 ? 1 : Math.ceil(length / 67);
}

/** Длинное тире в тексте клиентам не допускается (сервер тоже отклонит). */
const LONG_DASH = /[‒-―−]/;

function SmsTextField({ value, pending, onSave }: { value: string; pending: boolean; onSave: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setDraft(value);
  }, [value, touched]);
  const text = draft.trim();
  const changed = text !== value;
  const error = !text ? "Текст не может быть пустым." : LONG_DASH.test(text) ? "Уберите длинное тире: в СМС его не используем." : text.length > 600 ? "Слишком длинный текст." : null;
  const parts = smsPartsEstimate(text);

  return (
    <div className={error ? "fld bad" : "fld"} style={{ marginTop: "var(--s4)" }}>
      <span className="lab">Текст СМС</span>
      <textarea
        value={draft}
        onChange={(e) => {
          setTouched(true);
          setDraft(e.target.value);
        }}
        rows={5}
        spellCheck={false}
        aria-label="Текст СМС после пропущенного звонка"
      />
      <span className="msg">
        {error ?? `Одно сообщение на двух языках: сначала таджикский, потом русский. Длина ${Array.from(text).length} знаков, примерно ${parts} СМС (каждая платная).`}
      </span>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button
          className="pill"
          type="button"
          onClick={() => {
            onSave(text);
            setTouched(false);
          }}
          disabled={!touched || !changed || !!error || pending}
        >
          Сохранить
        </button>
      </div>
    </div>
  );
}

export function MissedCallSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const smsOn = settings?.missedCallSmsEnabled ?? false;
  const taskOn = settings?.missedCallCallbackTaskEnabled ?? false;

  return (
    <>
      <SwitchRow
        title="Пропущенный звонок: сразу отправить СМС со ссылкой на WhatsApp"
        on={smsOn}
        hint={
          smsOn
            ? "Если на звонок никто не ответил, звонивший сразу получает одну СМС. Одному номеру не чаще раза в сутки; не пишем сотрудникам, номерам компании и тем, кто за сутки уже писал нам в WhatsApp."
            : "Звонившему, которому не ответили, ничего не уходит."
        }
        onToggle={() => updateSettings.mutate({ missedCallSmsEnabled: !smsOn })}
      />
      {smsOn && (
        <SmsTextField
          value={settings?.missedCallSmsText ?? ""}
          pending={updateSettings.isPending}
          onSave={(text) => updateSettings.mutate({ missedCallSmsText: text })}
        />
      )}
      <SwitchRow
        title="Пропущенный звонок с незнакомого номера: задача «перезвонить»"
        on={taskOn}
        hint={
          taskOn
            ? "Незнакомый номер получает карточку и общую задачу для руководителя. Один номер, одна задача: повторный звонок поднимает её. Задача закрывается сама, когда человек дозвонился, ему перезвонили или он написал в WhatsApp."
            : "По незнакомому пропущенному руководство получает только уведомление, задачи нет."
        }
        onToggle={() => updateSettings.mutate({ missedCallCallbackTaskEnabled: !taskOn })}
      />
    </>
  );
}
