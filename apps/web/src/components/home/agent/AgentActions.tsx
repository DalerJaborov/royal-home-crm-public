import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CallClientButton } from "../../CallClientButton";
import { ConfirmDialog } from "../../ConfirmDialog";
import { MutationError } from "../../MutationError";
import { Button } from "../../rh2";
import { ApiError } from "../../../lib/api";
import { toast } from "../../../store/toast";
import { useMobileUx } from "../../../hooks/useMobileUx";
import {
  isRequiresRelease,
  useAcceptLead,
  useAcceptReactivationOffer,
  useConfirmDuplicateReview,
  useDeclineLead,
  useDeclineReactivationOffer,
  useDenyDuplicateReview,
  type DuplicateReviewItem,
  type ReactivationOffer,
} from "../../../hooks/useClients";
import type { Client } from "../../../types";

/**
 * КНОПКИ РЕШЕНИЙ ГЛАВНОЙ АГЕНТА (06.10.2026, E1): принять или отклонить лид,
 * «это ваш клиент?», возврат прежнего клиента, звонок. Ни одно решение не
 * меняло смысла: те же хуки и те же запросы, что были в двух прежних главных
 * (ПК и телефон). Здесь они собраны один раз и стоят и в тёмной карточке
 * «Сначала это», и в строках очереди: размер задаёт `compact`, а не копия кода.
 */

/** `Button` требует причину у неактивной кнопки: пара «выключена + почему» собирается одним местом. */
const lock = (off: boolean, reason: string) =>
  off ? ({ disabled: true, disabledReason: reason } as const) : ({} as const);

/** Зелёная трубка 44: звонок только через CRM (`CallClientButton`, правило 06.08.2026). */
export function CallCircle({ clientId, phone }: { clientId: string | null | undefined; phone: string | null | undefined }) {
  return (
    <CallClientButton
      clientId={clientId}
      phone={phone}
      variant="icon"
      className="pill icon btn-call rh-btn rh-btn-round"
      title="Позвонить через CRM"
    />
  );
}

/**
 * Кнопка «Позвонить через CRM» с подписью, для тёмной карточки и строк-решений.
 * На телефоне подпись короче («Позвонить»): полная переносилась на две строки
 * (кадр главной агента 390). Смысл «через CRM» остаётся в `title`.
 */
export function CallWide({ clientId, phone }: { clientId: string | null | undefined; phone: string | null | undefined }) {
  const mobile = useMobileUx();
  return (
    <CallClientButton
      clientId={clientId}
      phone={phone}
      variant="full"
      label={mobile ? "Позвонить" : "Позвонить через CRM"}
      title="Позвонить через CRM"
      className="pill rh-btn rh-home-call"
      stopPropagation={false}
    />
  );
}

/** Принять / Отклонить лид. Отказ спрашивает подтверждение: первый подряд бесплатный, дальше минус к счёту. */
export function PendingLeadActions({ client, compact }: { client: Client; compact?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accept = useAcceptLead(client.id);
  const decline = useDeclineLead(client.id);
  const [confirming, setConfirming] = useState(false);
  const busy = accept.isPending || decline.isPending;
  const size = compact ? "sm" : "md";

  return (
    <>
      <Button
        size={size}
        loading={accept.isPending}
        {...lock(decline.isPending, "Отклоняем лид")}
        data-endpoint="POST /api/v1/clients/:id/accept"
        onClick={() =>
          accept.mutate(undefined, {
            onError: (err) => {
              // Портфель полон: сервер просит выбрать, кого освободить, а выбор есть только в карточке.
              if (isRequiresRelease(err)) navigate(`/clients/${client.shortId}`);
            },
          })
        }
      >
        {accept.isPending ? "Принятие…" : "Принять"}
      </Button>
      <Button
        size={size}
        variant="soft"
        loading={decline.isPending}
        {...lock(accept.isPending, "Принимаем лид")}
        data-endpoint="POST /api/v1/clients/:id/decline"
        onClick={() => setConfirming(true)}
      >
        {decline.isPending ? "Отклоняем…" : "Отклонить"}
      </Button>
      {accept.isError && (
        <div className="rh-home-err">
          <MutationError mutation={accept} fallback="Не удалось принять лид" variant="rh2" />
        </div>
      )}
      {decline.isError && !confirming && (
        <div className="rh-home-err">
          <MutationError mutation={decline} fallback="Не удалось отклонить лид" variant="rh2" />
        </div>
      )}
      {confirming && !busy && (
        <ConfirmDialog
          title="Отклонить лид?"
          description="Первый отказ подряд ничего не стоит Royal Score, второй и следующие подряд снижают счёт. Лид сразу уйдёт следующему свободному агенту, а если отдать некому или лид по вашему объекту — руководителю. Эту карточку вы больше не увидите."
          confirmLabel="Отклонить"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            decline.mutate(undefined, {
              onSuccess: (res) =>
                toast.success(res.reassignedTo ? "Отклонён: лид ушёл следующему агенту" : "Отклонён: лид ушёл руководителю"),
              // Пока агент решал, лид успел принять кто-то другой или права поменялись: список надо перечитать.
              onError: (err) => {
                if (err instanceof ApiError && [403, 404, 409].includes(err.status)) {
                  toast.error(err.message);
                  void qc.invalidateQueries({ queryKey: ["clients"] });
                }
              },
            });
          }}
        />
      )}
    </>
  );
}

/** «Это ваш клиент?» (раздел L, 03.09.2026): пока агент не ответит, похожая заявка никому не раздаётся. */
export function DuplicateReviewActions({ review, compact }: { review: DuplicateReviewItem; compact?: boolean }) {
  const confirm = useConfirmDuplicateReview(review.id);
  const deny = useDenyDuplicateReview(review.id);
  const busy = confirm.isPending || deny.isPending;
  const size = compact ? "sm" : "md";
  return (
    <>
      <Button
        size={size}
        loading={confirm.isPending}
        {...lock(deny.isPending, "Сохраняем ответ")}
        data-endpoint="POST /api/v1/clients/duplicate-reviews/:id/confirm"
        onClick={() => !busy && confirm.mutate()}
      >
        Да, мой
      </Button>
      <Button
        size={size}
        variant="soft"
        loading={deny.isPending}
        {...lock(confirm.isPending, "Сохраняем ответ")}
        data-endpoint="POST /api/v1/clients/duplicate-reviews/:id/deny"
        onClick={() => !busy && deny.mutate()}
      >
        Другой
      </Button>
    </>
  );
}

/** Прежний клиент написал снова (разбор 31.08.2026, п.12): вернуть карточку себе или отказаться. */
export function ReactivationActions({ offer, compact }: { offer: ReactivationOffer; compact?: boolean }) {
  const accept = useAcceptReactivationOffer(offer.id);
  const decline = useDeclineReactivationOffer(offer.id);
  const busy = accept.isPending || decline.isPending;
  const size = compact ? "sm" : "md";
  return (
    <>
      <Button
        size={size}
        loading={accept.isPending}
        {...lock(decline.isPending, "Сохраняем ответ")}
        data-endpoint="POST /api/v1/clients/reactivation-offers/:id/accept"
        onClick={() => !busy && accept.mutate()}
      >
        Принять
      </Button>
      <Button
        size={size}
        variant="soft"
        loading={decline.isPending}
        {...lock(accept.isPending, "Сохраняем ответ")}
        data-endpoint="POST /api/v1/clients/reactivation-offers/:id/decline"
        onClick={() => !busy && decline.mutate()}
      >
        Отклонить
      </Button>
    </>
  );
}
