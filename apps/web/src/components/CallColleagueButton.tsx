import { useState } from "react";
import { PhoneCall } from "lucide-react";
import { useCallAgent } from "../hooks/useAgents";

/**
 * Позвонить коллеге через офисную АТС.
 *
 * Внутренние звонки станция умеет и без CRM — достаточно набрать 1008 на софтфоне, —
 * но помнить, что 1008 это Наргиза, никто не обязан, а список номеров на стене
 * устаревает в тот же день. Кнопка звонит по имени: сначала звонит собственная
 * трубка сотрудника, после ответа станция соединяет с коллегой.
 *
 * Отличается от CallClientButton намеренно: это внутренний вызов, он не пишется в
 * хронологию клиента и не влияет на Royal Score, поэтому и кнопка другая, и запасного
 * пути «позвонить с личного мобильного» здесь нет — если АТС недоступна, коллеге
 * можно написать.
 */
export function CallColleagueButton({
  agentId,
  extension,
  className,
}: {
  agentId: string;
  /** Внутренний номер коллеги. Нет номера — нет и кнопки: звонить некуда. */
  extension?: string | null;
  className?: string;
}) {
  const callAgent = useCallAgent(agentId);
  const [error, setError] = useState<string | null>(null);

  if (!extension) return null;

  async function handleCall() {
    setError(null);
    try {
      await callAgent.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось позвонить");
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={handleCall}
        disabled={callAgent.isPending}
        title={`Позвонить через АТС на внутренний ${extension}`}
        className={
          className ??
          "flex min-h-11 items-center gap-1.5 rounded-lg border border-blue/15 bg-blue/6 px-3 py-1.5 text-[15px] font-semibold text-blue transition-colors hover:bg-blue/12 disabled:opacity-60 md:min-h-0"
        }
      >
        <PhoneCall className="h-3.5 w-3.5" />
        {callAgent.isPending ? "Соединяем…" : `Позвонить · ${extension}`}
      </button>
      {error && <span className="text-[13px] text-red">{error}</span>}
    </span>
  );
}
