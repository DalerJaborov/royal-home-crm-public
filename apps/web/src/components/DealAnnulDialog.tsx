import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * «Аннулировать» закрытую сделку — с вопросом-подтверждением и обязательной
 * причиной (глубокая проверка 02.10.2026, C10; решение владельца «да, по советам»).
 * Окно ждёт ответа сервера: отказ показывается здесь же, а не теряется.
 */
export function DealAnnulDialog({
  clientName,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  clientName: string | null;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const tooShort = reason.trim().length < 3;
  return (
    <ConfirmDialog
      title="Аннулировать сделку?"
      description={`${clientName ? `Сделка с клиентом ${clientName}` : "Сделка"} перестанет считаться продажей — в отчётах, на доске почёта, в баллах и в финансах. Объект вернётся в продажу, баллы агента за сделку снимутся. Вернуть сделку будет нельзя.`}
      confirmLabel={pending ? "Аннулируем…" : "Аннулировать"}
      confirmDisabled={tooShort || pending}
      confirmHint={tooShort ? "Напишите причину" : undefined}
      dismissible={!pending}
      onConfirm={() => !tooShort && onConfirm(reason.trim())}
      onCancel={onCancel}
    >
      <label className="field" style={{ marginTop: 12 }}>
        <span className="lab">Причина</span>
        <textarea
          className="inp"
          style={{ maxWidth: "none", minHeight: 88 }}
          autoFocus
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Например: покупатель оказался подставным"
        />
      </label>
      {error && (
        <div className="quiet crit" role="alert" style={{ marginTop: 12 }}>
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
    </ConfirmDialog>
  );
}
