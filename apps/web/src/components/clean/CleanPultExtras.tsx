import { Settings2, UsersRound } from "lucide-react";
import { LinkButton } from "../rh2/Button";
import { CLink } from "./ui";

export interface CleanPultExtrasProps {
  canVacancies: boolean;
  canSettings: boolean;
  /** Undefined means the system snapshot is unavailable, never zero applications. */
  newApplications?: number;
}

export function CleanCandidateSummary({ count }: { count: number }) {
  return <>
    <p className="quiet">{count} новых анкет</p>
    <div className="acts"><LinkButton to="/vacancies" size="sm">Открыть «Вакансии»</LinkButton></div>
  </>;
}

/** Restore DirectorHome's existing tools (the bot trainer was removed 13.11.2026). */
export function CleanPultExtras({ canVacancies, canSettings, newApplications }: CleanPultExtrasProps) {
  const showCandidates = canVacancies && newApplications !== undefined;
  if (!showCandidates && !canSettings) return null;
  return <div className="flex flex-wrap gap-3" aria-label="Дополнительные инструменты пульта">
    {showCandidates && <CLink to="/vacancies" variant="soft" size="lg">
      <UsersRound aria-hidden="true" />Кандидаты · {newApplications}
    </CLink>}
    {canSettings && <CLink to="/settings?tab=system&task=workspace" variant="soft" size="lg">
      <Settings2 aria-hidden="true" />Настройки пульта
    </CLink>}
  </div>;
}
