import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { PultArea } from "@royal-home/shared";
import { DirectorAskSheet } from "../pult/DirectorAskSheet";
import { MorningBriefingCard } from "../pult/MorningBriefingCard";
import { CButton } from "./ui";
import { useIsReadOnly } from "../../lib/permissions";

/** Reuses the production briefing and ask contracts; no synthetic AI response. */
export function CleanDirectorAi({ enabled, askEnabled = true, areas }: { enabled: boolean; askEnabled?: boolean; areas?: PultArea[] }) {
  const [askOpen, setAskOpen] = useState(false);
  const readOnly = useIsReadOnly();
  const canAsk = askEnabled && !readOnly;
  if (!enabled) return null;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 max-w-[42ch] text-[16px] text-gray-600">{canAsk ? "Задайте вопрос к данным компании или откройте утренний брифинг." : readOnly ? "Готовый утренний брифинг по данным компании. Доступ только для просмотра." : "Откройте утренний брифинг. Вопросы к ИИ отключены в настройках пульта."}</p>
        {canAsk && <CButton disabled={!areas} title={!areas ? "Сначала загрузим данные пульта" : undefined} onClick={() => setAskOpen(true)}>
          <Sparkles size={20} aria-hidden="true" />Спросить ИИ
        </CButton>}
      </div>
      <div className="mb-4 [&_.brief-card]:border-0 [&_.brief-card]:bg-row-alt [&_.brief-card]:shadow-none [&_.brief-t]:text-[18px] [&_.brief-text]:text-[16px] [&_.brief-note]:text-[14px] [&_.brief-btn]:min-h-11">
        <MorningBriefingCard enabled={enabled} />
      </div>
      {/* Rh2Sheet supplies its own themed portal, focus trap, Escape and focus return. */}
      {canAsk && askOpen && areas && <DirectorAskSheet areas={areas} onClose={() => setAskOpen(false)} />}
    </>
  );
}
