import { useState } from "react";
import { CLEANUP_TARGET_LABELS, type CleanupMode, type CleanupScope, type CleanupTarget } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import { useCleanupPreview, useRunCleanup } from "../hooks/useDataCleanup";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Кнопка «Очистить» (владелец 28.11.2026) для уведомлений, оповещений директору и журнала ошибок.
 * Видна только тем, у кого право «Менять настройки CRM» (директор/админ): сервер проверяет то же право.
 *
 * Простыми словами и без сюрпризов: два варианта («только разобранное» и «всё»), число строк до удаления,
 * явное «это нельзя вернуть». Одна и та же кнопка на ПК и телефоне — класс и подпись задаёт экран-хозяин.
 */

const MODE_TEXT: Record<CleanupTarget, Record<CleanupMode, { title: string; hint: string }>> = {
  notifications: {
    handled: { title: "Только прочитанное", hint: "Непрочитанные и те, что ждут решения, останутся." },
    all: { title: "Всё", hint: "Удалится и непрочитанное." },
  },
  directorAlerts: {
    handled: { title: "Только уже разобранное", hint: "То, что очередь уже доставила. Ещё ждущие останутся." },
    all: { title: "Всё", hint: "Удалится и то, что ещё ждёт отправки." },
  },
  errorLog: {
    handled: { title: "Только разобранное", hint: "Ошибки с отметкой «разобрано». Неразобранные останутся." },
    all: { title: "Всё", hint: "Удалятся и неразобранные ошибки." },
  },
};

export function CleanupButton({
  target,
  scope = "all",
  label = "Очистить",
  className = "pill ghost sm",
  whose,
  onDone,
}: {
  target: CleanupTarget;
  /** Только для уведомлений: «mine» — свои, «all» — у всех сотрудников. */
  scope?: CleanupScope;
  label?: string;
  className?: string;
  /** Чьи записи: подставляется в вопрос («у вас» / «у всех сотрудников»). */
  whose?: string;
  onDone?: (count: number) => void;
}) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CleanupMode>("handled");
  const preview = useCleanupPreview({ target, mode, scope }, open);
  const run = useRunCleanup();
  const [done, setDone] = useState<number | null>(null);
  if (!can("settings.manage")) return null;

  const close = () => {
    setOpen(false);
    run.reset();
  };
  const count = preview.data?.count;
  const placeText = whose ?? (target === "notifications" ? (scope === "mine" ? "у вас" : "у всех сотрудников") : "");

  return (
    <>
      <button type="button" className={className} onClick={() => { setDone(null); setMode("handled"); setOpen(true); }}>
        {label}
      </button>
      {done !== null && !open && (
        <span className="quiet" role="status" style={{ marginLeft: 8 }}>
          Удалено: {done}
        </span>
      )}
      {open && (
        <ConfirmDialog
          title={`Очистить: ${CLEANUP_TARGET_LABELS[target].toLowerCase()}${placeText ? ` (${placeText})` : ""}?`}
          description={
            preview.isError
              ? "Не удалось посчитать, сколько записей удалится. Попробуйте ещё раз."
              : count === undefined
                ? "Считаем, сколько записей удалится…"
                : count === 0
                  ? "Здесь нечего удалять."
                  : `Будет удалено записей: ${count}. Вернуть их будет нельзя.`
          }
          confirmLabel={count ? `Удалить ${count}` : "Удалить"}
          confirmDisabled={run.isPending || preview.isLoading || preview.isError || !count}
          dismissible={!run.isPending}
          onCancel={close}
          onConfirm={() =>
            run.mutate(
              { target, mode, scope },
              {
                onSuccess: (res) => {
                  setDone(res.count);
                  onDone?.(res.count);
                  setOpen(false);
                },
              }
            )
          }
        >
          <fieldset style={{ border: 0, padding: 0, margin: "12px 0 0" }}>
            <legend className="lab">Что удалить</legend>
            {(["handled", "all"] as const).map((m) => (
              <label key={m} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0" }}>
                <input type="radio" name={`cleanup-mode-${target}`} checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  <b>{MODE_TEXT[target][m].title}</b>
                  <br />
                  <span className="quiet">{MODE_TEXT[target][m].hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {run.isError && <p role="alert">{run.error.message}</p>}
        </ConfirmDialog>
      )}
    </>
  );
}
