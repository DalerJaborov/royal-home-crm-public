import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { dushanbeDateTime } from "../lib/date";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Пауза приёма лидов от руководителя (24.09.2026, владелец: «админу и директору
 * тоже кнопку внутри профиля работников… чтобы отдохнуть в тот день»).
 *
 * Та же пауза, что агент включает себе в профиле, а не «Отпуск / больничный»:
 * человек на месте, текущие клиенты и звонки остаются у него, KPI считается;
 * закрывается только выдача новых лидов. Непринятые лиды уходят в раздачу
 * (кроме лидов по его собственному объекту). Снять паузу руководителя агент
 * сам не может — сервер: routes/agents.ts, /agents/:id/lead-pause.
 */

const HOURS_OPTIONS: { hours: number; label: string }[] = [
  { hours: 4, label: "4 часа" },
  { hours: 8, label: "8 часов" },
  { hours: 24, label: "Сутки" },
  { hours: 48, label: "Двое суток" },
  { hours: 168, label: "Неделя" },
];

export function LeadPauseAgentModal({
  agent,
  onClose,
}: {
  agent: {
    id: string;
    fullName: string;
    leadsPausedUntil?: string | null;
    leadsPausedByName?: string | null;
    leadsPausedReason?: string | null;
  };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [hours, setHours] = useState(24);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const paused = !!agent.leadsPausedUntil && new Date(agent.leadsPausedUntil).getTime() > Date.now();

  function done() {
    for (const key of ["team", "agent-overview"]) qc.invalidateQueries({ queryKey: [key] });
    onClose();
  }
  const fail = (fallback: string) => (err: unknown) => setError(err instanceof Error ? err.message : fallback);

  const pause = useMutation({
    mutationFn: () =>
      api(`/agents/${agent.id}/lead-pause`, {
        method: "POST",
        body: { hours, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    onSuccess: done,
    onError: fail("Не удалось поставить паузу"),
  });
  const resume = useMutation({
    mutationFn: () => api(`/agents/${agent.id}/lead-pause`, { method: "DELETE" }),
    onSuccess: done,
    onError: fail("Не удалось снять паузу"),
  });

  const errorLine = error && (
    <p className="state err">
      <span className="dot crit" />
      {error}
    </p>
  );

  if (paused) {
    return (
      <ConfirmDialog
        title={`Вернуть в раздачу лидов: ${agent.fullName}`}
        description={[
          `Новые лиды не выдаются до ${dushanbeDateTime(agent.leadsPausedUntil!)}.`,
          agent.leadsPausedByName ? `Паузу поставил ${agent.leadsPausedByName}.` : "Паузу включил сам сотрудник.",
          agent.leadsPausedReason ? `Причина: «${agent.leadsPausedReason}».` : "",
          "После снятия новые лиды снова пойдут к нему.",
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={resume.isPending ? "Снимаем…" : "Вернуть в раздачу"}
        danger={false}
        confirmDisabled={resume.isPending}
        onConfirm={() => {
          setError(null);
          resume.mutate();
        }}
        onCancel={onClose}
      >
        {errorLine}
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      title={`Пауза лидов: ${agent.fullName}`}
      description="Сотрудник не получает новых лидов до конца срока. Текущие клиенты и звонки остаются у него, KPI считается как обычно. Непринятые лиды сразу уходят другим. Снять паузу сам он не сможет, только руководитель."
      confirmLabel={pause.isPending ? "Ставим…" : "Поставить паузу"}
      danger={false}
      confirmDisabled={pause.isPending}
      onConfirm={() => {
        setError(null);
        pause.mutate();
      }}
      onCancel={onClose}
    >
      <div className="fld" style={{ marginTop: 12 }}>
        <span className="lab">На сколько</span>
        <div className="seg" role="group" aria-label="Срок паузы">
          {HOURS_OPTIONS.map((o) => (
            <button key={o.hours} type="button" aria-pressed={hours === o.hours} onClick={() => setHours(o.hours)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <label className="fld">
        <span className="lab">Причина — необязательно, сотрудник её увидит</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={300}
          placeholder="Например: выходной"
        />
      </label>
      {errorLine}
    </ConfirmDialog>
  );
}
