import { useEffect, useState } from "react";
import { claimStepUp } from "../lib/stepUpOwners";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ABSENCE_KINDS, ABSENCE_KIND_LABELS, type AbsenceKind } from "@royal-home/shared";
import { api, ApiError } from "../lib/api";
import { dushanbeDayKey } from "../lib/date";
import { ConfirmDialog } from "./ConfirmDialog";
import { StepUpDialog } from "./StepUpDialog";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

/**
 * Экстренная заморозка / разморозка сотрудника (см. apps/api/src/routes/agents.ts,
 * POST /agents/:id/freeze и /unfreeze — сервер умел это с самого начала, кнопки в
 * интерфейсе не было НИ ОДНОЙ (найдено `npm run audit:dead` 27.08.2026): метка
 * «заморожен» показывалась в пяти местах, поставить или снять её было неоткуда.
 *
 * Заморозка ≠ деактивация: человек продолжает работать в CRM с текущими клиентами,
 * прекращается только выдача НОВОЙ работы (см. докстринг freeze-роута).
 *
 * ВИД ОТСУТСТВИЯ (владелец 09.09.2026: «дать отпуск / больничный»). Добавлен сюда,
 * а не отдельной кнопкой: отпуск и больничный — это та же заморозка, с теми же
 * последствиями (непринятые лиды уходят в очередь, KPI замирает). Отличается
 * только то, ЧТО БУДЕТ С ВЕРНУВШИМСЯ КЛИЕНТОМ этого агента: из отпуска человек
 * выходит в известный день, и продавца можно подержать в очереди до его выхода;
 * больничный кончается неизвестно когда, и карточка уходит другому сразу
 * (apps/api/src/lib/returningClientRouting.ts).
 *
 * Дата выхода необязательна и снимает заморозку сама
 * (apps/api/src/lib/absenceReturn.ts). У больничного её обычно и нет.
 */

/** «до 20 сентября» — хвост к названию вида отсутствия. Пусто, если срока нет. */
function absenceTail(until: string | null | undefined): string {
  if (!until) return " без указанного срока";
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return "";
  return ` до ${date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Asia/Dushanbe" })}`;
}
export function FreezeAgentModal({
  agent,
  onClose,
}: {
  agent: {
    id: string;
    fullName: string;
    frozen: boolean;
    frozenReason: string | null;
    frozenReasonVoiceUrl?: string | null;
    frozenReasonVoiceTranscript?: string | null;
    absenceKind?: AbsenceKind | null;
    absenceUntil?: string | null;
  };
  onClose: () => void;
}) {
  // Своё окно подтверждения — общее (GlobalStepUpHost) не открывается поверх.
  useEffect(() => claimStepUp(), []);
  const qc = useQueryClient();
  const [kind, setKind] = useState<AbsenceKind>("VACATION");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Прерванное 428-м действие — после подтверждения личности повторяем его же. */
  const [pendingStepUp, setPendingStepUp] = useState<{ run: () => void; description: string } | null>(null);

  function invalidateAfterChange() {
    for (const key of ["team", "hall-of-fame", "top-agents", "oversight"]) qc.invalidateQueries({ queryKey: [key] });
  }

  const freeze = useMutation({
    mutationFn: () =>
      api(`/agents/${agent.id}/freeze`, {
        method: "POST",
        body: {
          reason: reason.trim(),
          kind,
          // Пустое поле — «до неизвестно когда»: null, а не пропуск. undefined не
          // сериализуется в JSON и не отличим от «поле не трогали».
          until: until ? new Date(`${until}T09:00:00+05:00`).toISOString() : null,
          ...(voiceNote ? { reasonVoiceUrl: voiceNote.url, reasonVoiceTranscript: voiceNote.transcript ?? undefined } : {}),
        },
      }),
    onSuccess: () => {
      invalidateAfterChange();
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 428) {
        setPendingStepUp({
          run: () => freeze.mutate(),
          description: "Заморозка сотрудника останавливает выдачу ему новой работы, подтвердите, что это вы.",
        });
        return;
      }
      setError(err instanceof Error ? err.message : "Не удалось заморозить");
    },
  });

  const unfreeze = useMutation({
    mutationFn: () => api(`/agents/${agent.id}/unfreeze`, { method: "POST" }),
    onSuccess: () => {
      invalidateAfterChange();
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 428) {
        setPendingStepUp({
          run: () => unfreeze.mutate(),
          description: "Разморозка возвращает сотруднику выдачу лидов, подтвердите, что это вы.",
        });
        return;
      }
      setError(err instanceof Error ? err.message : "Не удалось разморозить");
    },
  });

  if (pendingStepUp) {
    return (
      <StepUpDialog
        description={pendingStepUp.description}
        onConfirmed={() => {
          const run = pendingStepUp.run;
          setPendingStepUp(null);
          run();
        }}
        onCancel={() => setPendingStepUp(null)}
      />
    );
  }

  if (agent.frozen) {
    return (
      <ConfirmDialog
        title={`Вернуть в строй: ${agent.fullName}`}
        description={[
          agent.absenceKind ? `${ABSENCE_KIND_LABELS[agent.absenceKind]}${absenceTail(agent.absenceUntil)}.` : "",
          agent.frozenReason ? `Причина: «${agent.frozenReason}».` : "",
          "Сотрудник снова начнёт получать новые лиды и входящие звонки.",
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={unfreeze.isPending ? "Возвращаем…" : "Вернуть в строй"}
        danger={false}
        confirmDisabled={unfreeze.isPending}
        onConfirm={() => {
          setError(null);
          unfreeze.mutate();
        }}
        onCancel={onClose}
      >
        {agent.frozenReasonVoiceUrl && (
          <div className="voice">
            <VoiceNotePlayer url={agent.frozenReasonVoiceUrl} />
            {agent.frozenReasonVoiceTranscript && (
              <span className="txt">Распознано: «{agent.frozenReasonVoiceTranscript}»</span>
            )}
          </div>
        )}
        {error && (
          <p className="state err">
            <span className="dot crit" />
            {error}
          </p>
        )}
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      title={`Отсутствие: ${agent.fullName}`}
      description="Сотрудник продолжает работать с текущими клиентами, но перестаёт получать новые лиды. Непринятые активные лиды сразу уходят в общую очередь. Вернуть в строй можно в любой момент."
      confirmLabel={freeze.isPending ? "Сохраняем…" : `Отметить: ${ABSENCE_KIND_LABELS[kind].toLowerCase()}`}
      confirmDisabled={freeze.isPending || reason.trim().length < 3}
      onConfirm={() => {
        setError(null);
        freeze.mutate();
      }}
      onCancel={onClose}
    >
      {/* Вид отсутствия и дата выхода — те же блоки `.fld` эталона, что и причина
          ниже: отпуск и больничный не отдельная форма, а уточнение той же. */}
      <div className="fld" style={{ marginTop: 12 }}>
        <span className="lab">Что случилось</span>
        <div className="seg" role="group" aria-label="Вид отсутствия">
          {ABSENCE_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {ABSENCE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </div>
      <label className="fld">
        <span className="lab">Дата выхода — необязательно</span>
        <input
          type="date"
          value={until}
          min={dushanbeDayKey(new Date(Date.now() + 864e5))}
          onChange={(e) => setUntil(e.target.value)}
        />
        <span className="msg">
          {until
            ? "В этот день сотрудник вернётся в строй сам — лиды и входящие звонки пойдут к нему снова."
            : "Без даты вернуть в строй придётся вручную."}
        </span>
      </label>

      {/* Поле причины и голосовая заметка — блок `.fld` эталона: подпись `.lab`,
          поле во всю ширину, подсказка `.msg`. Ничего не потеряно: причина
          по-прежнему обязательна (не короче трёх символов), голосовая заметка
          по-прежнему на своём месте. */}
      <label className="fld">
        <span className="lab">Причина (не короче 3 символов)</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder={
            kind === "VACATION"
              ? "Например: плановый отпуск"
              : kind === "SICK"
                ? "Например: на больничном"
                : "Например: разбирательство по жалобе клиента"
          }
        />
      </label>
      <div className="voice">
        <VoiceNoteButton uploadUrl="/me/voice-notes" value={voiceNote} onChange={setVoiceNote} />
      </div>
      {error && (
        <p className="state err">
          <span className="dot crit" />
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
