import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Building2, Clock, UserRound } from "lucide-react";
import type { TransferRequestView } from "@royal-home/shared";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { MutationError } from "./MutationError";
import { useNow } from "../hooks/useNow";
import { useIncomingTransferRequests, useRespondTransferRequest } from "../hooks/useTransferRequests";
import { useAuthStore } from "../store/auth";
import { hapticSuccess, hapticTap } from "../lib/haptics";
import { toast, useToastStore } from "../store/toast";

/**
 * БОЛЬШОЕ ОКНО «ПЕРЕДАТЬ ВАШЕГО КЛИЕНТА / ОБЪЕКТ?» (владелец 16.11.2026).
 *
 * «Прямо такое большое окно, как при звонках»: хозяину карточки приходит запрос
 * от РОП, окно встаёт на весь экран поверх CRM — на ПК и на телефоне, одним
 * компонентом (на широком экране карточка по центру, на узком во весь экран).
 * Два решения: «Подтвердить» и «Отказать». Не ответил — запрос сам отменяется
 * через срок из настроек, поэтому здесь есть обратный отсчёт.
 *
 * Данные — GET /transfer-requests/incoming; свежесть — живое событие
 * `transfer.pending` и запасной опрос раз в минуту. «Отвечу позже» сворачивает
 * окно в плашку, запрос остаётся в силе и напоминается пушем.
 */

export function transferLeftLabel(ms: number): string {
  if (ms <= 0) return "срок вышел";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

export function TransferConfirmWindow() {
  const me = useAuthStore((s) => s.agent);
  const { data } = useIncomingTransferRequests(!!me);
  const items = useMemo(() => data ?? [], [data]);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const visible = items.filter((r) => !hidden.has(r.id));
  const current = visible[0] ?? null;
  const collapsedCount = items.length - visible.length;
  const currentId = current?.id ?? null;

  useEffect(() => {
    if (currentId) hapticTap();
  }, [currentId]);

  if (!me || items.length === 0) return null;

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
        <button
          type="button"
          className="tc-quiet"
          onClick={() => setHidden(new Set())}
          aria-label="Вас просят передать карточку. Открыть"
        >
          <i aria-hidden="true" />
          <span>Ждёт вашего ответа: {collapsedCount}</span>
        </button>
      )}
    </Rh2Portal>
  );
}

export function TransferDialog({ request, more, onLater }: { request: TransferRequestView; more: number; onLater: () => void }) {
  const respond = useRespondTransferRequest(request.id);
  const now = useNow(true);
  const leftMs = new Date(request.expiresAt).getTime() - now;
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
        // снимаем его до показа, иначе итог (в том числе ошибка передачи) никто не увидит.
        onSuccess: () => {
          hapticSuccess();
          useToastStore.getState().setSuspended(false);
          toast.success(decision === "confirm" ? "Подтверждено: карточка передана" : "Отказано: карточка осталась у вас");
        },
        onError: (err) => {
          useToastStore.getState().setSuspended(false);
          toast.error(err instanceof Error ? err.message : "Не удалось отправить ответ");
        },
      }
    );
  };

  return (
    <div
      className="tc-wrap"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`tc-title-${request.id}`}
      data-no-sheet
      data-no-drag
    >
      <div className="tc-card">
        <div className="tc-top">
          <i aria-hidden="true" />
          <span>
            Просят передать {isProperty ? "ваш объект" : "вашего клиента"}
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
            <span>{request.fromAgent?.fullName ?? "Вы"}</span>
            <ArrowRight className="i" aria-hidden="true" />
            <b>{request.toAgent?.fullName ?? "другому агенту"}</b>
          </p>
          <p className="tc-who">
            Просит: <b>{request.requestedBy?.fullName ?? "руководитель"}</b>
          </p>
          <div className="tc-reason">
            <span className="tc-reason-lab">Причина</span>
            <span>{request.reason}</span>
          </div>
          <p className="tc-left">
            <Clock className="i" aria-hidden="true" />
            <span>
              Ответьте за <b>{transferLeftLabel(leftMs)}</b>. Не ответите — передача отменится, всё останется у вас.
            </span>
          </p>
        </div>

        <div className="tc-actions">
          <div className="tc-btns">
            <button type="button" className="tc-btn accept" disabled={respond.isPending} onClick={() => answer("confirm")}>
              {respond.isPending ? "Отправляем…" : "Подтвердить"}
            </button>
            <button type="button" className="tc-btn reject" disabled={respond.isPending} onClick={() => answer("decline")}>
              Отказать
            </button>
          </div>
          <button type="button" className="tc-later" onClick={onLater}>
            Отвечу позже
          </button>
          {respond.isError && <MutationError variant="rh2" mutation={respond} fallback="Не удалось отправить ответ" />}
        </div>
      </div>
    </div>
  );
}
