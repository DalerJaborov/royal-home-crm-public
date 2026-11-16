import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAgents } from "../hooks/useAgents";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import type { Property } from "../types";

/**
 * Передать один объект другому агенту — по руке, без ожидания увольнения
 * (в отличие от HandoverModal.tsx, который передаёт весь портфель уходящего
 * сотрудника). Новый хозяин прочитает причину и примет объект сам —
 * см. плашку принятия в PropertyOwnerCard.tsx, таймера нет.
 */
export function TransferPropertyModal({
  property,
  onClose,
}: {
  property: Property;
  onClose: () => void;
}) {
  const { data: agents } = useAgents();
  const qc = useQueryClient();
  const [toAgentId, setToAgentId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const currentOwnerId = property.intakeAgent?.id ?? property.assignedAgent?.id ?? null;
  const candidates = (agents ?? []).filter(
    (a) => a.isActive && a.role === "AGENT" && a.id !== currentOwnerId
  );

  const transfer = useMutation({
    mutationFn: () =>
      api<Property>(`/properties/${property.id}/transfer`, {
        method: "POST",
        body: { toAgentId, reason },
      }),
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["property"] });
      qc.invalidateQueries({ queryKey: ["properties"] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Не удалось передать объект"),
  });

  const canSubmit = !!toAgentId && reason.trim().length >= 3;

  return (
    <Rh2Sheet
      title="Передать объект"
      onClose={onClose}
      onSubmit={() => {
        setError(null);
        if (!canSubmit) return;
        transfer.mutate();
      }}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={!canSubmit || transfer.isPending}>
            {transfer.isPending ? "Передаём…" : "Передать объект"}
          </button>
        </>
      }
    >
      <label className="fld">
        <span className="lab">Кому передать</span>
        <select value={toAgentId} onChange={(e) => setToAgentId(e.target.value)}>
          <option value="">Выберите агента…</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.fullName}
            </option>
          ))}
        </select>
      </label>

      <label className="fld">
        <span className="lab">Почему передаёте</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        <span className="msg">
          Это прочитает новый хозяин перед тем, как принять объект. Продавец этого объекта, если он у прежнего
          агента, перейдёт вместе с объектом как новый лид.
        </span>
      </label>

      {error && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </Rh2Sheet>
  );
}
