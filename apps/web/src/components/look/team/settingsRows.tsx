import type { ReactNode } from "react";
import { RyHintText, TeamCircle, settingsIconFor, toneFor, useRyHint } from "./parts";

/**
 * Строки настроек в «Новом виде» (18.11.2026, макет `settingsGroupBody`):
 * переключатель — плитка с кругом-значком и крупным тумблером 56×34, число —
 * строка со значком и полем справа. Пояснение под «i». Логика, подписи и
 * обработчики — те же, что у прежних SwitchRow/NumberRow: эти компоненты лишь
 * другая разметка тех же пропсов.
 */
export function RoyalSwitchTile({ title, hint, on, switchNode, warning, className }: {
  title: string; hint: ReactNode; on: boolean; switchNode: ReactNode; warning?: ReactNode; className?: string;
}) {
  const info = useRyHint(title);
  const hasHint = hint !== null && hint !== undefined && hint !== "";
  return (
    <div className={`ry-swt${className ? ` ${className}` : ""}`} data-on={on}>
      <span className="ry-swt-top">
        <TeamCircle icon={settingsIconFor(title)} tone="info" />
        {switchNode}
      </span>
      <span className="ry-swt-t">
        <span>{title}</span>
        {hasHint && info.button}
      </span>
      {hasHint && <RyHintText id={info.id} open={info.open}>{hint}</RyHintText>}
      {warning && <p className="ry-swt-warn" role="note">{warning}</p>}
    </div>
  );
}

export function RoyalNumberRow({ label, hint, field }: { label: string; hint: string; field: ReactNode }) {
  const info = useRyHint(label);
  return (
    <div className="ry-setrow">
      <TeamCircle icon={settingsIconFor(label)} tone={toneFor(label)} />
      <span className="ry-setrow-text">
        <span className="ry-setrow-title"><span>{label}</span>{hint && info.button}</span>
        {hint && <RyHintText id={info.id} open={info.open}>{hint}</RyHintText>}
      </span>
      <span className="ry-setrow-field">{field}</span>
    </div>
  );
}
