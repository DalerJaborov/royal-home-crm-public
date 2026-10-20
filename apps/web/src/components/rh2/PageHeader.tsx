import type { ReactNode } from "react";

/**
 * ЗАГОЛОВОК ЭКРАНА: единственный на странице (`.pg-h`: h1 + `.sub` + `.acts`).
 * Заголовок в шапке оболочки задаётся отдельно (`Rh2Screen title=…`), здесь —
 * заголовок внутри содержимого.
 */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="pg-h rh-pg-h">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      {actions ? <div className="acts">{actions}</div> : null}
    </header>
  );
}
