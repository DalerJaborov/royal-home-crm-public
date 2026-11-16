import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Building2, UserRound } from "lucide-react";
import type { TransferRequestView } from "@royal-home/shared";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { MutationError } from "./MutationError";
import { usePendingTransferReviews, useRespondTransferRequest } from "../hooks/useTransferRequests";
import { useAuthStore } from "../store/auth";
import { hapticSuccess, hapticTap } from "../lib/haptics";
import { toast, useToastStore } from "../store/toast";

/**
 * БОЛЬШОЕ ОКНО ДИРЕКТОРУ: «РОП ПЕРЕДАЛ КАРТОЧКУ — ПОДТВЕРДИТЬ?» (владелец 16.11.2026, вторая редакция).
 *
 * РОП передаёт объект или клиента сразу; директору (и администратору) встаёт окно на весь экран — на ПК и на
 * телефоне, одним компонентом — с двумя решениями: «Подтвердить» и «Отклонить» (отклонить — вернуть карточку
 * прежнему хозяину). Агентам и самому РОП окно не показывается вовсе. Не ответили — передача остаётся.
 *
 * Данные — GET /transfer-requests/pending; свежесть — живое событие `transfer.pending` и запасной опрос.
 * «Отвечу позже» сворачивает окно в плашку, решение остаётся в силе.
 */
export function TransferConfirmWindow() {
  const me = useAuthStore((s) => s.agent);
  const isReviewer = me?.role === "DIRECTOR" || me?.role === "ADMIN";
  const { data } = usePendingTransferReviews(isReviewer);
  const items = useMemo(() => data ?? [], [data]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const visible = items.filter((r) => !hidden.has(r.id));
  const current = visible[0] ?? null;
  const collapsedCount = items.length - visible.length;
  const currentId = current?.id ?? null;

  useEffect(() => {
    if (currentId) hapticTap();
  }, [currentId]);

  if (!me || !isReviewer || items.length === 0) return null;

  return (
    <Rh2Portal>
      {current ? (
        <TransferDialog
          key={current.id}
          request={current}
          more={visible.length - 1}
          onLater={() => setHidden((s) => new Set(s).add(current.id))}
        />
      ) : (
        <button type="button" className="tc-quiet" onClick={() => setHidden(new Set())} aria-label="Передачи ждут вашего решения. Открыть">
          <i aria-hidden="true" />
          <span>Ждёт вашего решения: {collapsedCount}</span>
        </button>
      )}
    </Rh2Portal>
  );
}

export function TransferDialog({ request, more, onLater }: { request: TransferRequestView; more: number; onLater: () => void }) {
  const respond = useRespondTransferRequest(request.id);
  const isProperty = request.kind === "PROPERTY";

  // Пока окно на весь экран, фоновая пилюля «Сохранено» гасится (как у окна лида).
  useEffect(() => {
    useToastStore.getState().setSuspended(true);
    return () => useToastStore.getState().setSuspended(false);
  }, []);

  const answer = (decision: "confirm" | "decline") => {
    if (respond.isPending) return;
    respond.mutate(
      { decision },
      {
        // Окно закрывается само, когда запрос уходит из списка, а тосты гасит приглушение окна:
        // снимаем его до показа, иначе итог (в том числе ошибка возврата) никто не увидит.
        onSuccess: () => {
          hapticSuccess();
          useToastStore.getState().setSuspended(false);
          toast.success(decision === "confirm" ? "Подтверждено" : "Отклонено: карточка возвращена прежнему хозяину");
        },
        onError: (err) => {
          useToastStore.getState().setSuspended(false);
          toast.error(err instanceof Error ? err.message : "Не удалось отправить решение");
        },
      }
    );
  };

  return (
    <div className="tc-wrap" role="alertdialog" aria-modal="true" aria-labelledby={`tc-title-${request.id}`} data-no-sheet data-no-drag>
      <div className="tc-card">
        <div className="tc-top">
          <i aria-hidden="true" />
          <span>
            Руководитель продаж передал {isProperty ? "объект" : "клиента"}
            {more > 0 ? ` · ещё ${more}` : ""}
          </span>
        </div>

        <div className="tc-body">
          <div className="tc-ico" aria-hidden="true">
            {isProperty ? <Building2 /> : <UserRound />}
          </div>
          <h1 className="tc-title" id={`tc-title-${request.id}`}>
            {request.targetTitle}
          </h1>
          <p className="tc-flow">
            <span>{request.fromAgent?.fullName ?? "Прежний хозяин"}</span>
            <ArrowRight className="i" aria-hidden="true" />
            <b>{request.toAgent?.fullName ?? "другому агенту"}</b>
          </p>
          <p className="tc-who">
            Передал: <b>{request.requestedBy?.fullName ?? "руководитель"}</b>
          </p>
          <div className="tc-reason">
            <span className="tc-reason-lab">Причина</span>
            <span>{request.reason}</span>
          </div>
          <p className="tc-left">
            <span>
              «Подтвердить» — оставить как есть. «Отклонить» — вернуть {isProperty ? "объект" : "клиента"} прежнему хозяину. Не
              ответите — передача останется.
            </span>
          </p>
        </div>

        <div className="tc-actions">
          <div className="tc-btns">
            <button type="button" className="tc-btn accept" disabled={respond.isPending} onClick={() => answer("confirm")}>
              {respond.isPending ? "Отправляем…" : "Подтвердить"}
            </button>
            <button type="button" className="tc-btn reject" disabled={respond.isPending} onClick={() => answer("decline")}>
              Отклонить
            </button>
          </div>
          <button type="button" className="tc-later" onClick={onLater}>
            Отвечу позже
          </button>
          {respond.isError && <MutationError variant="rh2" mutation={respond} fallback="Не удалось отправить решение" />}
        </div>
      </div>
    </div>
  );
}
