import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCan } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { dushanbeDate } from "../lib/date";
import { PropertyPeople } from "./PropertyPeople";
import { TransferPropertyModal } from "./TransferPropertyModal";
import type { Property } from "../types";

/**
 * «Кто ведёт объект» с передачей и принятием (24.09.2026).
 *
 * Сами строки людей рисует `PropertyPeople` — один компонент на все экраны
 * карточки (в том числе карточку монтажёра, где передачи нет). Здесь — то, что
 * нужно только полной карточке: заголовок с кнопкой «Передать другому агенту»
 * для руководства, история последней передачи, и плашка «Объект передан вам»
 * с кнопкой «Принять объект» для нового хозяина. Таймера у принятия нет —
 * объект, в отличие от лида, никого не заставляет ждать.
 *
 * Хозяин объекта на сервере — `propertyOwnerAgentId` (intake ?? assigned ??
 * createdBy); после передачи оба поля равны получателю, поэтому «передан мне»
 * проверяется по `intakeAgent`.
 *
 * Рендерится ВНУТРИ `.card` вызывающего экрана: раскладки карточки оборачивают
 * блок по-разному (отступы, соседние секции), и своя обёртка здесь дала бы
 * карточку в карточке.
 */
export function PropertyOwnerCard({
  property,
  showIntakeShare = false,
  ownerPhoneInField = false,
}: {
  property: Property;
  /** Доля принявшего объект — финансовая информация, только при finance.view. */
  showIntakeShare?: boolean;
  /** Номер собственника уже стоит в поле «Телефон собственника» ниже — см. PropertyPeople. */
  ownerPhoneInField?: boolean;
}) {
  const can = useCan();
  const myId = useAuthStore((s) => s.agent?.id);
  const qc = useQueryClient();
  const [transferOpen, setTransferOpen] = useState(false);
  const canManage = can("properties.editForeign");
  // Передать объект — только тому, кто распределяет клиентов (глубокая проверка
  // 02.10.2026, A4): вместе с объектом уезжает карточка продавца, а сервер на это
  // требует clients.assign. У маркетинга и монтажёра editForeign есть, а
  // clients.assign нет — кнопка открывала пустой список агентов (GET /agents им
  // закрыт) и была мёртвой.
  const canTransfer = canManage && can("clients.assign");

  const isPendingForMe = !!property.handoverPendingSince && !!myId && property.intakeAgent?.id === myId;
  const isPendingForOther = !!property.handoverPendingSince && !isPendingForMe;

  const acceptHandover = useMutation({
    mutationFn: () => api<{ ok: true }>(`/properties/${property.id}/accept-handover`, { method: "POST" }),
    meta: { silent: true },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["property"] });
      qc.invalidateQueries({ queryKey: ["properties"] });
    },
  });

  const handoverDate = property.handoverPendingSince
    ? dushanbeDate(property.handoverPendingSince, { day: "numeric", month: "long" })
    : null;

  return (
    <>
      <div className="sec-h stack">
        <h2>Кто ведёт объект</h2>
        {canTransfer && (
          <button type="button" className="pill ghost sm" onClick={() => setTransferOpen(true)}>
            Передать другому агенту
          </button>
        )}
      </div>

      {isPendingForMe && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            Объект передан вам
            {property.handoverFromAgent ? ` от ${property.handoverFromAgent.fullName}` : ""}
            {handoverDate ? `, ${handoverDate}` : ""}
            {property.handoverReason ? `. Причина: ${property.handoverReason}` : ""}
          </span>
          <button
            type="button"
            className="pill sm"
            onClick={() => acceptHandover.mutate()}
            disabled={acceptHandover.isPending}
          >
            {acceptHandover.isPending ? "Принимаем…" : "Принять объект"}
          </button>
        </div>
      )}
      {acceptHandover.isError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">
            {acceptHandover.error instanceof Error ? acceptHandover.error.message : "Не удалось принять объект"}
          </span>
        </div>
      )}

      <PropertyPeople property={property} showIntakeShare={showIntakeShare} ownerPhoneInField={ownerPhoneInField} />

      {property.handoverFromAgent && !isPendingForMe && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Передан от {property.handoverFromAgent.fullName}
            {handoverDate ? ` ${handoverDate}` : ""}
            {property.handoverReason ? `: ${property.handoverReason}` : ""}
          </span>
        </div>
      )}

      {isPendingForOther && canManage && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Ждёт принятия: {property.intakeAgent?.fullName ?? "новый хозяин"}
            {handoverDate ? ` с ${handoverDate}` : ""}
          </span>
        </div>
      )}

      {transferOpen && <TransferPropertyModal property={property} onClose={() => setTransferOpen(false)} />}
    </>
  );
}
