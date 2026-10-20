import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { dealRejectBody } from "../lib/dealReject";

/** «Вернуть на доработку» — с обязательной причиной для агента (аудит 23.09.2026, №35). */
export function DealRejectDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (body: { stage: "CONTRACT_SIGNED"; rejectReason: string }) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const body = dealRejectBody(reason);
  return (
    <ConfirmDialog
      title="Вернуть на доработку?"
      description="Сделка вернётся на этап «Договор подписан». Агент увидит, что поправить, и отправит снова."
      confirmLabel="Вернуть"
      danger={false}
      confirmDisabled={!body}
      onConfirm={() => body && onConfirm(body)}
      onCancel={onCancel}
    >
      <label className="field" style={{ marginTop: 12 }}>
        <span className="lab">Что поправить</span>
        <textarea
          className="inp"
          style={{ maxWidth: "none", minHeight: 88 }}
          autoFocus
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Например: комиссия не совпадает с договором"
        />
      </label>
    </ConfirmDialog>
  );
}
