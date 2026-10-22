import { useState } from "react";
import { MIN_PROPERTY_PHOTOS } from "@royal-home/shared";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { useProperty } from "../../hooks/useProperties";
import { useApprovePropertyMaterials, useRejectPropertyMaterials, type ReviewMaterial } from "../../hooks/useMissionControl";
import type { ActionRowReview } from "../pult/ActionRow";
import { formatPropertyCode } from "../../lib/clientFormat";
import { CButton, CLink } from "./ui";

/**
 * «Проверить материалы» на месте: фото объекта и два решения на каждый материал.
 * Те же роуты, что в карточке (`review/approve` и `review/reject`), правила готовности зеркальны
 * серверным: фото — не меньше MIN_PROPERTY_PHOTOS, видео — хотя бы один ролик.
 * Причина возврата обязательна: агент должен понять, что переснять.
 */
export default function CleanPropertyReviewSheet({ review, onClose, onDecided }: {
  review: ActionRowReview; onClose: () => void; onDecided: () => void;
}) {
  const { data: property, isLoading, isError } = useProperty(String(review.shortId));
  const approve = useApprovePropertyMaterials();
  const reject = useRejectPropertyMaterials();
  const [rejecting, setRejecting] = useState<ReviewMaterial | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const busy = approve.isPending || reject.isPending;

  const photos = property?.photos ?? [];
  const materials = property ? ([
    { id: "photos", title: "Фото", approved: !!property.photosApprovedAt,
      blocked: photos.length >= MIN_PROPERTY_PHOTOS ? null : `Мало фотографий: ${photos.length} из ${MIN_PROPERTY_PHOTOS}. Дождитесь, пока агент догрузит остальные.` },
    { id: "video", title: "Видео", approved: !!property.videoApprovedAt,
      blocked: (property.videoCount ?? 0) > 0 ? null : "Агент ещё не загрузил видео объекта." },
  ] as const) : [];

  async function decide(material: ReviewMaterial, kind: "approve" | "reject") {
    if (busy) return;
    setError("");
    setPending(`${material}:${kind}`);
    try {
      if (kind === "approve") await approve.mutateAsync({ propertyId: review.propertyId, material });
      else await reject.mutateAsync({ propertyId: review.propertyId, material, reason });
      setRejecting(null);
      setReason("");
      // Строка пульта закрывается, когда по ОБОИМ материалам решение принято или возвращено;
      // иначе остаётся в очереди — оставшийся материал ещё ждёт.
      const rest = materials.filter((item) => item.id !== material && !item.approved);
      if (kind === "reject" || rest.length === 0) onDecided();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Не удалось сохранить решение. Можно повторить.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Rh2Sheet title={`${formatPropertyCode(review.shortId)} · материалы`} wide onClose={onClose}>
      <p className="m-0 mb-3 text-[14px] text-gray-600">{review.title}</p>
      {isLoading && <p role="status">Загружаем материалы…</p>}
      {isError && <p role="alert" className="clean-decision-error">Не удалось загрузить объект. Откройте карточку.</p>}
      {property && (
        <div className="grid gap-4">
          {photos.length > 0
            ? <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Фотографии объекта">
              {photos.slice(0, 12).map((photo) => <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden rounded-[14px] bg-row-alt">
                <img src={photo.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
              </a>)}
            </div>
            : <p className="m-0 text-gray-600">Фотографий нет.</p>}
          {photos.length > 12 && <p className="m-0 text-[13px] text-gray-600">Показаны 12 из {photos.length}. Остальные — в карточке.</p>}
          {materials.map((material) => (
            <div key={material.id} className="grid gap-2 rounded-[14px] bg-row-alt p-3">
              <b className="text-[16px]">{material.title}</b>
              {material.approved
                ? <p className="m-0 text-[14px] text-gray-600">Одобрено.</p>
                : <>
                  {material.blocked && <p className="m-0 text-[14px] text-gray-600">{material.blocked}</p>}
                  {rejecting === material.id
                    ? <div className="grid gap-2">
                      <label htmlFor={`review-reason-${material.id}`} className="text-[13px] text-gray-600">Что переделать (агент увидит это сообщение)</label>
                      <textarea id={`review-reason-${material.id}`} rows={3} maxLength={500} value={reason} disabled={busy}
                        onChange={(event) => setReason(event.target.value)}
                        className="w-full rounded-[14px] border border-line-soft bg-card p-3 text-[14px] text-ink" />
                      <div className="flex flex-wrap gap-2">
                        <CButton size="sm" disabled={busy || !reason.trim()} data-endpoint="POST /api/v1/properties/:id/review/reject" onClick={() => void decide(material.id, "reject")}>
                          {pending === `${material.id}:reject` ? "Возвращаем…" : "Вернуть агенту"}
                        </CButton>
                        <CButton variant="soft" size="sm" disabled={busy} onClick={() => { setRejecting(null); setReason(""); }}>Отмена</CButton>
                      </div>
                    </div>
                    : <div className="flex flex-wrap gap-2">
                      <CButton size="sm" disabled={busy || !!material.blocked} data-endpoint="POST /api/v1/properties/:id/review/approve" onClick={() => void decide(material.id, "approve")}>
                        {pending === `${material.id}:approve` ? "Одобряем…" : "Одобрить"}
                      </CButton>
                      <CButton variant="soft" size="sm" disabled={busy} onClick={() => { setRejecting(material.id); setReason(""); }}>Вернуть с причиной</CButton>
                    </div>}
                </>}
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="clean-decision-error">{error}</p>}
      <div className="mt-4"><CLink to={`/properties/${review.shortId}`} variant="soft" size="sm">Открыть карточку</CLink></div>
    </Rh2Sheet>
  );
}
