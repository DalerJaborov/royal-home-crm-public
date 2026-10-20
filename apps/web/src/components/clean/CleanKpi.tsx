import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CCard } from "./ui";

/** Shared dashboard KPI leaf: one surface, one icon/text row, real navigation. */
export function CleanKpi({ icon, label, value, children, to }: {
  icon: ReactNode; label: string; value: string; children?: ReactNode; to?: string;
}) {
  const content = <CCard className="clean-kpi grid gap-3 p-[18px_20px]">
    <div className="flex items-center gap-2.5 text-[13px] text-gray-600">
      <span className="clean-kpi-icon grid size-7 shrink-0 place-items-center rounded-full bg-row-alt text-gray-700 [&_svg]:size-4">{icon}</span>
      <span className="clean-kpi-label min-w-0 break-words">{label}</span>
    </div>
    <div className="clean-kpi-value text-[40px] font-semibold leading-none tracking-[-.03em] tabular-nums">{value}</div>
    {children ? <div>{children}</div> : <div className="h-[26px]" />}
  </CCard>;
  if (!to) return content;
  const className = "block min-w-0 rounded-[20px] text-ink no-underline";
  return to.startsWith("#") ? <a href={to} className={className}>{content}</a> : <Link to={to} className={className}>{content}</Link>;
}
