import { useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { VIDEO_HANDOFF_MUTATION_KEY, useCancelVideoHandoff, useVideoHandoffQueueState } from "../../hooks/useMarketing";
import { Rh2Sheet } from "../rh2/Rh2Sheet";

/**
 * ОБЩИЕ МЕЛОЧИ ОЧЕРЕДИ ХЕНДОФФА (25.09.2026, задание C — вынесено из
 * Pipeline.tsx, чтобы карточка объекта (PropertyVideoFixCard.tsx, блок
 * «Монтаж») пользовалась тем же диалогом снятия, а не своей копией).
 */

/** Идёт ли сейчас ЛЮБОЕ снятие/ход/пауза/придержка объекта — одно на весь
 *  экран (24.09.2026): несколько мутаций подряд, пока первая ещё не ответила,
 *  когда-то дали монтажёру лишний объект. */
export function useHandoffMutationBusy(): boolean {
  return useIsMutating({ mutationKey: VIDEO_HANDOFF_MUTATION_KEY }) > 0;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Не получилось. Обновите список и попробуйте ещё раз.";
}

/**
 * СНЯТЬ ДЕРЖАТЕЛЯ МЕСТА — ЯВНЫЙ ВЫБОР (24.09.2026). Раньше снятие молча и сразу
 * отдавало монтажёру следующий объект. Теперь окно называет, кому уйдёт место,
 * и даёт два действия: отдать место следующему или придержать очередь.
 *
 * Принимает только `id`/`shortId` (не весь `MarketingQueueRow`) — из карточки
 * объекта (PropertyVideoFixCard.tsx) под рукой только `Property`, не строка
 * конвейера с полями `pipeline`/`photoCount`/`videoHandoffQueuePosition`,
 * которые этому диалогу и не нужны.
 */
export function CancelHolderDialog({ id, shortId, onClose }: { id: string; shortId: number; onClose: () => void }) {
  const { data: queue } = useVideoHandoffQueueState();
  const cancel = useCancelVideoHandoff();
  const busy = useHandoffMutationBusy();
  const next = queue?.next ?? null;
  const paused = queue?.paused ?? false;
  // Причина придержки (25.09.2026, А4) — только когда реально ставим на паузу
  // (holdQueue=true): «отдать место следующему» её никак не использует.
  const [holdReason, setHoldReason] = useState("");

  const run = (holdQueue: boolean) =>
    cancel.mutate({ propertyId: id, holdQueue, reason: holdQueue ? holdReason.trim() || undefined : undefined }, { onSuccess: onClose });

  let queueText: string;
  if (paused) queueText = "Очередь на паузе — место останется свободным, следующий не уйдёт, пока не возобновите.";
  else if (next) queueText = `Следующий в очереди — №${next.shortId}. Можно сразу отдать место ему или придержать очередь.`;
  else queueText = "За ним в очереди никого нет.";

  return (
    <Rh2Sheet
      open
      onClose={onClose}
      dismissible={!cancel.isPending}
      title={`Снять №${shortId} с монтажа?`}
      role="alertdialog"
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose} disabled={cancel.isPending}>
            Отмена
          </button>
          {!paused && next ? (
            <>
              <button type="button" className="pill ghost" disabled={busy} onClick={() => run(true)}>
                Снять и придержать очередь
              </button>
              <button type="button" className="pill" disabled={busy} onClick={() => run(false)}>
                Снять и отдать место №{next.shortId}
              </button>
            </>
          ) : (
            <button type="button" className="pill" disabled={busy} onClick={() => run(false)}>
              Снять с монтажа
            </button>
          )}
        </>
      }
    >
      {!paused && next && (
        <p className="state">
          <input
            className="inp sm"
            style={{ width: "100%" }}
            placeholder="Причина придержки (необязательно)"
            value={holdReason}
            onChange={(e) => setHoldReason(e.target.value)}
            disabled={busy}
            aria-label="Причина придержки очереди"
          />
        </p>
      )}
      <p className="state">
        <span className="dot crit" />
        Монтажёр уже получил ролик в Telegram — ему придёт уведомление, что доделывать не нужно.
      </p>
      <p className="state">{queueText}</p>
      {cancel.isError && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {errorText(cancel.error)}
        </p>
      )}
    </Rh2Sheet>
  );
}
