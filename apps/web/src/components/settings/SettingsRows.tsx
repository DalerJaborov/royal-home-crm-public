/**
 * Строки чисел и кнопка сохранения — общие для вкладок Настроек с числовыми
 * параметрами («Лиды», «Подбор объектов»). Вынесено из LeadsTab.tsx (17.09.2026):
 * были локальными функциями файла, вторая вкладка со своими числами скопировала
 * бы их один в один — здесь общий источник вместо дубликата.
 *
 * Разметка — дословно эталон темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/settings.html): каждое число — строка `.mod`
 * с полем `.nf`, кнопка «Сохранить» — `.pill.ghost` рядом с меткой «Сохранено».
 */

/** Числовая строка настройки: правится в поле, уходит по «Сохранить».
 *  Тумблеры сохраняются сразу, числа — нет: пока человек печатает «85», в базу
 *  успело бы уехать «8». */
export function NumberRow({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  return (
    <div className="mod">
      <div className="t">
        <b>{label}</b>
        <span>{hint}</span>
      </div>
      <div className="acts">
        <span className="nf">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
          />
          {unit && <span className="u">{unit}</span>}
        </span>
      </div>
    </div>
  );
}

/** Строка «Сохранить + Сохранено» под группой чисел — как в эталоне. */
export function SaveRow({ pending, saved }: { pending: boolean; saved: boolean }) {
  return (
    <div className="wrap" style={{ marginTop: "var(--s4)" }}>
      <button className="pill ghost" type="submit" disabled={pending}>
        Сохранить
      </button>
      {saved && <span className="saved on">Сохранено</span>}
    </div>
  );
}
