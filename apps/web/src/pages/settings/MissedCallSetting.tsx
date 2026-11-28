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

/** «5,30,120» → «Через 5 минут, 30 минут и 2 часа»: подпись берётся из настройки, а не зашита. */
export function redialDelaysText(raw: string | null | undefined): string {
  const nums = String(raw ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1);
  const list = nums.length > 0 ? nums : [5, 30, 120];
  const part = (m: number) => {
    if (m % 60 === 0) {
      const h = m / 60;
      return `${h} ${h === 1 ? "час" : h < 5 ? "часа" : "часов"}`;
    }
    const last = m % 10;
    const word = m % 100 >= 11 && m % 100 <= 14 ? "минут" : last === 1 ? "минуту" : last >= 2 && last <= 4 ? "минуты" : "минут";
    return `${m} ${word}`;
  };
  const parts = list.map(part);
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}`;
  return `Через ${joined}`;
}

export function MissedCallSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const smsOn = settings?.missedCallSmsEnabled ?? false;
  const taskOn = settings?.missedCallCallbackTaskEnabled ?? false;
  const redialOn = settings?.missedCallRedialEnabled ?? false;
  const junkOn = settings?.missedCallRedialJunkEnabled ?? false;

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
      <SwitchRow
        title="Пропущенный звонок: перезвонить самим"
        on={redialOn}
        hint={
          redialOn
            ? `${redialDelaysText(settings?.missedCallRedialDelays)} станция сначала звонит тому, кто принимает звонки (пункт «Кто принимает звонки, когда никто не взял»), и соединяет его с клиентом. Только в рабочие часы. Кто оставил сообщение на автоответчике или уже ждёт ответа от агента, не получает перезвон. Если не дозвонились, в карточке остаётся запись «не дозвонились», больше ничего не происходит.`
            : "Пропущенному клиенту никто не перезванивает сам."
        }
        onToggle={() => updateSettings.mutate({ missedCallRedialEnabled: !redialOn })}
      />
      {redialOn && (
        <SwitchRow
          title="Не дозвонились совсем: убрать задачу «перезвонить»"
          on={junkOn}
          hint={
            junkOn
              ? "Если после всех неудачных попыток прошла неделя и клиент не звонил, задача «перезвонить» закрывается сама. Карточка остаётся."
              : "Задача «перезвонить» остаётся, пока её не закроют вручную."
          }
          onToggle={() => updateSettings.mutate({ missedCallRedialJunkEnabled: !junkOn })}
        />
      )}
    </>
  );
}
