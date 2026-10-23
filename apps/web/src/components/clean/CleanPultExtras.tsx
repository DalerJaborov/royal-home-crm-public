import { useState } from "react";
import { GraduationCap, Settings2, UsersRound } from "lucide-react";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { LinkButton } from "../rh2/Button";
import { BotTrainer } from "../trainer/BotTrainer";
import { CButton, CLink } from "./ui";

export interface CleanPultExtrasProps {
  canTrainer: boolean;
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

/** Restore DirectorHome's existing tools without loading trainer queries until opened. */
export function CleanPultExtras({ canTrainer, canVacancies, canSettings, newApplications }: CleanPultExtrasProps) {
  const [open, setOpen] = useState<"trainer" | null>(null);
  const showCandidates = canVacancies && newApplications !== undefined;
  if (!canTrainer && !showCandidates && !canSettings) return null;
  return <>
    <div className="flex flex-wrap gap-3" aria-label="Дополнительные инструменты пульта">
      {canTrainer && <CButton variant="soft" size="lg" onClick={() => setOpen("trainer")}>
        <GraduationCap aria-hidden="true" />Тренажёр бота
      </CButton>}
      {showCandidates && <CLink to="/vacancies" variant="soft" size="lg">
        <UsersRound aria-hidden="true" />Кандидаты · {newApplications}
      </CLink>}
      {canSettings && <CLink to="/settings?tab=system&task=workspace" variant="soft" size="lg">
        <Settings2 aria-hidden="true" />Настройки пульта
      </CLink>}
    </div>
    {open === "trainer" && canTrainer && <Rh2Sheet title="Тренажёр бота" wide onClose={() => setOpen(null)}>
      <BotTrainer compact />
    </Rh2Sheet>}
  </>;
}
