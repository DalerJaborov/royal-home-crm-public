import {
  SELLER_AUTOMATION_MASTER_KEY,
  SELLER_AUTOMATION_MASTER_LABEL,
  SELLER_SWITCH_KEYS,
  SELLER_SWITCH_LABELS,
} from "@royal-home/shared";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";

/**
 * ВЫКЛЮЧАТЕЛИ АВТОМАТИКИ «РАБОТА С ПРОДАВЦАМИ» (владелец 14.11.2026).
 *
 * Один блок: главный выключатель сверху, под ним по строке на механизм. Список,
 * подписи и правило «главный И свой» — packages/shared/src/sellerAutomationSwitches.ts;
 * здесь только разметка, своих копий списка нет.
 *
 * Главный выключен — строки ниже не показываются вовсе: слово «Включено» у
 * строки, которая на деле не работает, читалось бы как неправда (правило
 * SwitchRow — подпись про ТЕКУЩЕЕ положение). Свои значения при этом не
 * трогаются и вернутся, когда главный включат.
 *
 * Тумблер переключается сразу (optimistic в useUpdateSettings) и сохраняется сам,
 * общая кнопка «Сохранить» формы ниже к нему отношения не имеет.
 */
export function SellerAutomationSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  if (!settings) return null;

  const masterOn = settings[SELLER_AUTOMATION_MASTER_KEY] ?? true;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Работа с продавцами</h2>
        <span className="note">Что система делает с продавцами сама. Выключенное просто молчит, ничего не удаляется</span>
      </div>
      <SwitchRow
        title={SELLER_AUTOMATION_MASTER_LABEL.title}
        on={masterOn}
        onToggle={() => updateSettings.mutate({ [SELLER_AUTOMATION_MASTER_KEY]: !masterOn })}
        hint={masterOn ? SELLER_AUTOMATION_MASTER_LABEL.on : SELLER_AUTOMATION_MASTER_LABEL.off}
      />
      {masterOn &&
        SELLER_SWITCH_KEYS.map((key) => {
          const on = settings[key] ?? true;
          const label = SELLER_SWITCH_LABELS[key];
          return (
            <SwitchRow
              key={key}
              title={label.title}
              on={on}
              onToggle={() => updateSettings.mutate({ [key]: !on })}
              hint={on ? label.on : label.off}
            />
          );
        })}
    </section>
  );
}
