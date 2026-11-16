import { SwitchRow } from "../../components/Switch";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";

/**
 * «Передача РОП — уведомление директору» (владелец 16.11.2026): рубильник. Включено — когда РОП передаёт объект
 * или клиента другому агенту, директору и администратору приходит окно в CRM и сообщение в Telegram с кнопками
 * «Подтвердить» и «Отклонить» (отклонить — вернуть прежнему хозяину). Саму передачу рубильник не трогает.
 */
export function OwnerConfirmTransferSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const on = settings?.ropTransferAlertEnabled ?? true;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Передача объектов и клиентов руководителем продаж</h2>
        <span className="note">Руководитель отдела продаж передаёт сразу, директор получает уведомление</span>
      </div>
      <SwitchRow
        title="Сообщать директору о передачах"
        on={on}
        onToggle={() => updateSettings.mutate({ ropTransferAlertEnabled: !on })}
        hint={
          on
            ? "Когда руководитель отдела продаж передаёт объект или клиента, директору и администратору приходит окно в CRM и сообщение в Telegram: «Подтвердить» или «Отклонить». «Отклонить» возвращает карточку прежнему хозяину. Не ответите — передача остаётся."
            : "Выключено: руководитель отдела продаж передаёт молча, директору ничего не приходит."
        }
      />
      <p className="sub" style={{ marginTop: "var(--s3)" }}>
        Рядовые агенты передавать объекты и клиентов друг другу не могут, и никаких окон и уведомлений о передачах им не приходит.
      </p>
    </section>
  );
}
