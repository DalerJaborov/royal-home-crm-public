import type { ReactNode } from "react";
import { RyHintText, TeamCircle, settingsIconFor, toneFor, useRyHint } from "./parts";

/**
 * Строки настроек в «Новом виде» (18.11.2026, макет `settingsGroupBody`):
 * переключатель — плитка с кругом-значком и крупным тумблером 56×34, число —
 * строка со значком и полем справа. Логика, подписи и обработчики — те же, что у
 * прежних SwitchRow/NumberRow: эти компоненты лишь другая разметка тех же пропсов.
 *
 * `hint` — «что происходит при текущем положении», то есть последствие (деньги,
 * очередь, данные). Он виден ВСЕГДА, спокойным серым текстом под названием
 * (решение ревью PR 279). Под «i» может уйти только `explain` — необязательная
 * чистая справка; в Настройках её сейчас не ставит никто.
 */
const filled = (value: ReactNode) => value !== null && value !== undefined && value !== "";

export function RoyalSwitchTile({ title, hint, explain, on, stateNode, switchNode, warning, className }: {
  title: string; hint: ReactNode; explain?: ReactNode; on: boolean; stateNode: ReactNode; switchNode: ReactNode;
  warning?: ReactNode; className?: string;
}) {
  const info = useRyHint(title);
  return (
    <div className={`ry-swt${className ? ` ${className}` : ""}`} data-on={on}>
      <span className="ry-swt-top">
        <TeamCircle icon={settingsIconFor(title)} tone="info" />
        <span className="ry-swt-ctl">{stateNode}{switchNode}</span>
      </span>
      <span className="ry-swt-t">
        <span>{title}</span>
        {filled(explain) && info.button}
      </span>
      {filled(hint) && <span className="ry-sub">{hint}</span>}
      {filled(explain) && <RyHintText id={info.id} open={info.open}>{explain}</RyHintText>}
      {warning && <p className="ry-swt-warn" role="note">{warning}</p>}
    </div>
  );
}

export function RoyalNumberRow({ label, hint, explain, field }: { label: string; hint: string; explain?: ReactNode; field: ReactNode }) {
  const info = useRyHint(label);
  return (
    <div className="ry-setrow">
      <TeamCircle icon={settingsIconFor(label)} tone={toneFor(label)} />
      <span className="ry-setrow-text">
        <span className="ry-setrow-title"><span>{label}</span>{filled(explain) && info.button}</span>
        {filled(hint) && <span className="ry-sub">{hint}</span>}
        {filled(explain) && <RyHintText id={info.id} open={info.open}>{explain}</RyHintText>}
      </span>
      <span className="ry-setrow-field">{field}</span>
    </div>
  );
}
