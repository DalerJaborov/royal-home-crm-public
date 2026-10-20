import { useState } from "react";
import { deleteReasonLabelsFor, selectableDeleteReasonsFor, type DeleteRequestReason } from "@royal-home/shared";
import { useRequestDeleteClient } from "../hooks/useDeleteRequests";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { toast } from "../store/toast";
import type { Client } from "../types";

/**
 * «Направить на удаление» (решение владельца 30.08.2026).
 *
 * Агент не удаляет карточку — он объясняет, почему её не должно быть в базе, а
 * решает человек с правом `clients.delete`. Устройство окна повторяет
 * RefuseClientModal: выбор причины радиокнопками + необязательный комментарий,
 * к которому можно приложить голосовую заметку (VoiceNoteButton, 01.09.2026) —
 * файл как есть, без превращения в текст поля.
 *
 * ПРИЧИНЫ У ПРОДАВЦА И ПОКУПАТЕЛЯ РАЗНЫЕ — прямое требование владельца («окно
 * для продавца и для покупателя имеют разные варианты выбора — не путать»).
 * Отбор и подписи живут в @royal-home/shared (selectableDeleteReasonsFor,
 * deleteReasonLabelsFor), потому что тот же набор проверяет сервер: список,
 * написанный только в разметке, разошёлся бы с ним на первой же правке.
 *
 * Комментарий обязателен ровно в одном случае — причина «Другое»: без пары слов
 * такая заявка ничего не объясняет тому, кто будет её рассматривать.
 */
export function RequestDeleteClientModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const request = useRequestDeleteClient(client.id);
  const [reason, setReason] = useState<DeleteRequestReason | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);

  const labels = deleteReasonLabelsFor(client.kind);
  const commentRequired = reason === "OTHER";

  async function submit() {
    if (!reason) {
      setError("Выберите причину, по ней руководство и будет решать");
      return;
    }
    if (commentRequired && !comment.trim()) {
      setError("При причине «Другое» опишите её в комментарии");
      return;
    }
    setError(null);
    try {
      const result = await request.mutateAsync({
        reason,
        comment: comment.trim() || undefined,
        voiceNoteUrl: voiceNote?.url,
        voiceNoteTranscript: voiceNote?.transcript ?? undefined,
      });
      toast.success(result.message);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить заявку");
    }
  }

  return (
    <Rh2Sheet
      title="Направить на удаление"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={request.isPending}>
            {request.isPending ? "Отправляем…" : "Отправить заявку"}
          </button>
        </>
      }
    >
      <p className="state">
        Карточка не удалится сейчас: заявка уйдёт директору и админу, решение примет человек. Выберите причину,
        комментарий по желанию.
      </p>

      <div className="sec-t">Причина</div>
      {selectableDeleteReasonsFor(client.kind).map((r) => (
        <label key={r} className="chk">
          <input type="radio" name="delete-reason" checked={reason === r} onChange={() => setReason(r)} />
          {labels[r]}
        </label>
      ))}

      <div className="fld" style={{ marginTop: "var(--s4)" }}>
        <span className="lab">
          Комментарий {commentRequired ? "(обязателен при причине «Другое»)" : "(необязательно)"}
        </span>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
        <VoiceNoteButton uploadUrl="/me/voice-notes" value={voiceNote} onChange={setVoiceNote} />
      </div>

      {error && (
        <p className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </p>
      )}
    </Rh2Sheet>
  );
}
