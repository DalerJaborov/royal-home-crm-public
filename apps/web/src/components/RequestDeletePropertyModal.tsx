import { useState } from "react";
import {
  PROPERTY_DELETE_REQUEST_REASONS,
  PROPERTY_DELETE_REQUEST_REASON_LABELS,
  type PropertyDeleteRequestReason,
} from "@royal-home/shared";
import { useRequestDeleteProperty } from "../hooks/useDeleteRequests";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { toast } from "../store/toast";

/**
 * «Направить на удаление» для объекта (31.08.2026) — зеркало
 * RequestDeleteClientModal: агент не удаляет карточку сам, он объясняет,
 * почему её не должно быть в базе, а решает человек с правом
 * `properties.delete`. Причины у объекта общие (нет деления покупатель/
 * продавец, как у клиента) — берём таксономию PROPERTY_DELETE_REQUEST_REASONS
 * целиком, без отбора по типу карточки.
 *
 * Комментарий обязателен ровно в одном случае — причина «Другое»: без пары
 * слов такая заявка ничего не объясняет тому, кто будет её рассматривать.
 */
export function RequestDeletePropertyModal({
  propertyId,
  propertyTitle,
  onClose,
}: {
  propertyId: string;
  propertyTitle: string;
  onClose: () => void;
}) {
  const request = useRequestDeleteProperty(propertyId);
  const [reason, setReason] = useState<PropertyDeleteRequestReason | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);

  const commentRequired = reason === "OTHER" || reason === "SOLD_ELSEWHERE";
  // «Продано мимо агентства» требует хотя бы 20 символов (пачка 13, 11.09.2026):
  // короткая отписка ничего не даёт проверить СБ. Проверка зеркалит
  // propertyDeleteRequestSchema — сервер тот же лимит держит окончательным.
  const soldElsewhereTooShort = reason === "SOLD_ELSEWHERE" && comment.trim().length < 20;

  async function submit() {
    if (!reason) {
      setError("Выберите причину, по ней руководство и будет решать");
      return;
    }
    if (reason === "OTHER" && !comment.trim()) {
      setError("При причине «Другое» опишите её в комментарии");
      return;
    }
    if (soldElsewhereTooShort) {
      setError("Опишите подробнее (от 20 символов): через какое агентство прошла сделка");
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
        «{propertyTitle}» не удалится сейчас: заявка уйдёт директору и админу, решение примет человек. Выберите причину,
        комментарий по желанию.
      </p>

      <div className="sec-t">Причина</div>
      {PROPERTY_DELETE_REQUEST_REASONS.map((r) => (
        <label key={r} className="chk">
          <input type="radio" name="property-delete-reason" checked={reason === r} onChange={() => setReason(r)} />
          {PROPERTY_DELETE_REQUEST_REASON_LABELS[r]}
        </label>
      ))}

      <div className="fld" style={{ marginTop: "var(--s4)" }}>
        <span className="lab">
          Комментарий{" "}
          {reason === "SOLD_ELSEWHERE"
            ? "(обязателен, от 20 символов — через какое агентство прошла сделка)"
            : commentRequired
              ? "(обязателен при причине «Другое»)"
              : "(необязательно)"}
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
