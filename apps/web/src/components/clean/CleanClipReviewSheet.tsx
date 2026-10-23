import { useState } from "react";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import type { PendingClip, PultInboxActions } from "../../hooks/usePultInbox";
import { formatPropertyCode } from "../../lib/clientFormat";
import { CButton, CLink } from "./ui";

/**
 * «Проверка ролика» на месте: плеер и два решения. Те же роуты, что в карточке объекта и в Telegram
 * (`clip-review/approve`, `clip-review/reject`). «Вернуть» — только с причиной: монтажёр должен
 * понять, что исправить; причина уходит комментарием к возврату.
 */
export default function CleanClipReviewSheet({ clip, actions, onClose, onDecided }: {
  clip: PendingClip; actions: Pick<PultInboxActions, "approveClip" | "rejectClip">;
  onClose: () => void; onDecided: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState("");
  const busy = pending !== null;

  async function decide(kind: "approve" | "reject") {
    if (busy) return;
    setError("");
    setPending(kind);
    try {
      if (kind === "approve") await actions.approveClip(clip.id);
      else await actions.rejectClip(clip.id, reason.trim());
      onDecided();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Не удалось сохранить решение. Можно повторить.");
      setPending(null);
    }
  }

  return (
    <Rh2Sheet title={`${formatPropertyCode(clip.shortId)} · проверка ролика`} wide onClose={onClose}>
      <p className="m-0 mb-3 text-[14px] text-gray-600">{clip.title}{clip.montajer ? ` · монтажёр ${clip.montajer.fullName}` : ""}</p>
      {clip.videoUrl
        ? <video controls playsInline preload="metadata" poster={clip.coverUrl ?? undefined} src={clip.videoUrl}
          aria-label={`Ролик объекта ${clip.title}`} className="mx-auto max-h-[60vh] w-full rounded-[14px] bg-row-alt" />
        : <p role="status" className="m-0 text-gray-600">Файл ролика не найден. Откройте карточку объекта.</p>}
      {rejecting
        ? <div className="mt-3 grid gap-2">
          <label htmlFor="clip-reject-reason" className="text-[13px] text-gray-600">Что исправить (монтажёр увидит это сообщение)</label>
          <textarea id="clip-reject-reason" rows={3} maxLength={2000} value={reason} disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-[14px] border border-line-soft bg-card p-3 text-[14px] text-ink" />
          <div className="flex flex-wrap gap-2">
            <CButton size="sm" disabled={busy || !reason.trim()} data-endpoint="POST /api/v1/properties/:id/clip-review/reject" onClick={() => void decide("reject")}>
              {pending === "reject" ? "Возвращаем…" : "Вернуть монтажёру"}
            </CButton>
            <CButton variant="soft" size="sm" disabled={busy} onClick={() => { setRejecting(false); setReason(""); }}>Отмена</CButton>
          </div>
        </div>
        : <div className="mt-3 flex flex-wrap gap-2">
          <CButton size="sm" disabled={busy} data-endpoint="POST /api/v1/properties/:id/clip-review/approve" onClick={() => void decide("approve")}>
            {pending === "approve" ? "Одобряем…" : "Одобрить"}
          </CButton>
          <CButton variant="soft" size="sm" disabled={busy} onClick={() => setRejecting(true)}>Вернуть</CButton>
        </div>}
      {error && <p role="alert" className="clean-decision-error">{error}</p>}
      <div className="mt-4"><CLink to={`/properties/${clip.shortId}`} variant="soft" size="sm">Открыть карточку</CLink></div>
    </Rh2Sheet>
  );
}
