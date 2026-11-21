/**
 * ПРЕДУПРЕЖДЕНИЕ У ПОЛЯ МАСТЕРА (21.11.2026, объект №213; ревью #348). Не ошибка: сохранить можно и без
 * нажатия. Кнопка снимает предупреждение для этих значений (правило — propertyWizardStepWarnings в shared).
 */
export function WizardWarning({ text, confirmLabel, onConfirm, testId }: {
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  testId: string;
}) {
  return (
    <div role="status" data-testid={testId} style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 13, color: "var(--warn)", flex: "1 1 220px" }}>{text}</span>
      <button type="button" className="pill" onClick={onConfirm} data-testid={`${testId}-confirm`}>
        {confirmLabel}
      </button>
    </div>
  );
}
