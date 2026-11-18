import { AUTOMATION_SWITCH_GROUPS, automationSwitchLabel, type AutomationSwitchKey } from "@royal-home/shared";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";

/**
 * «АВТОМАТИКА ИИ И НАПОМИНАНИЯ» (владелец 19.11.2026: «оставить все эти функции,
 * просто сделать переключатели… а потом решим что выключить»).
 *
 * Три группы по смыслу: что ИИ решает за агента, задачи, уведомления. Список, группы и
 * подписи — packages/shared/src/automationSwitches.ts, здесь только разметка. Строка
 * «Застой: продавец без объекта» — давнее поле `dealStaleSellersEnabled` (оно же в
 * блоке «Работа с продавцами»), своей копии нет. Тумблер переключается сразу
 * (optimistic в useUpdateSettings) и сохраняется сам. Экран один на ПК и телефон:
 * карточка `.card` и строки SwitchRow сами складываются в колонку.
 */
export function AutomationSwitchesSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  if (!settings) return null;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Автоматика ИИ и напоминания</h2>
        <span className="note">Всё включено. Выключенное просто молчит, ничего не удаляется, остальная работа идёт как обычно</span>
      </div>
      {AUTOMATION_SWITCH_GROUPS.map((group) => (
        <div key={group.id}>
          <div className="sec-t">{group.title}</div>
          {group.keys.map((key) => {
            const on = settings[key as AutomationSwitchKey | "dealStaleSellersEnabled"] ?? true;
            const label = automationSwitchLabel(key);
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
        </div>
      ))}
    </section>
  );
}
