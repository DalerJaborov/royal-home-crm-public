import { SECURITY_AUTOMATION_KEY, SECURITY_AUTOMATION_LABEL, isSecurityAutomationOn } from "@royal-home/shared";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";

/**
 * РУБИЛЬНИК «СЛУЖБА БЕЗОПАСНОСТИ: АВТОМАТИКА» (владелец 18.11.2026: «временно
 * выключить всю логику сб… чтобы уведомление было руководителю тоже»).
 *
 * Один тумблер. Подписи и умолчание (выключено) — packages/shared/src/securityAutomationSwitch.ts,
 * что именно он останавливает — apps/api/src/lib/securityAutomation.ts. Переключается
 * сразу и сохраняется сам, как блок «Работа с продавцами» над ним.
 */
export function SecurityAutomationSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  if (!settings) return null;

  const on = isSecurityAutomationOn(settings);

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Служба безопасности</h2>
        <span className="note">Что проверка СБ может сделать с карточкой сама. Сигналы записываются всегда</span>
      </div>
      <SwitchRow
        title={SECURITY_AUTOMATION_LABEL.title}
        on={on}
        onToggle={() => updateSettings.mutate({ [SECURITY_AUTOMATION_KEY]: !on })}
        hint={on ? SECURITY_AUTOMATION_LABEL.on : SECURITY_AUTOMATION_LABEL.off}
      />
    </section>
  );
}
