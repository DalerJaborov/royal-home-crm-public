import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CallbackRequestView } from "@royal-home/shared";
import {
  useCallbackDone,
  useCallbackRequests,
  useDeleteRequestDecision,
  type McDeleteRequests,
} from "../../hooks/useMissionControl";
import { useCan, useIsReadOnly } from "../../lib/permissions";
import { dushanbeTime } from "../../lib/date";
import { CButton, CChip } from "./ui";

/** Те же 10 секунд, что у подтверждения в строке решения: второй клик должен прийти вовремя. */
const CONFIRM_MS = 10_000;
const ROW = "grid gap-2 rounded-[14px] bg-row-alt px-4 py-3";

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Не удалось выполнить действие. Можно повторить.";
}

type DeleteRequestItem = McDeleteRequests["items"][number];

const deleteEndpoint = (kind: DeleteRequestItem["kind"], decision: "approve" | "reject") =>
  `POST /api/v1/${kind === "CLIENT" ? "clients" : "properties"}/delete-requests/:id/${decision}`;

/** Заявки на удаление: «Одобрить» (со вторым кликом) и «Отклонить» с обязательной причиной прямо в напоминаниях. */
export function CleanDeleteRequestRows({ requests }: { requests: McDeleteRequests["items"] }) {
  const can = useCan();
  const readOnly = useIsReadOnly();
  const decide = useDeleteRequestDecision();
  const [armed, setArmed] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const visible = requests.filter((item) => !readOnly && can(item.kind === "CLIENT" ? "clients.delete" : "properties.delete"));
  if (!visible.length) return null;

  async function run(item: DeleteRequestItem, decision: "approve" | "reject") {
    if (decide.isPending) return;
    if (decision === "approve" && armed !== item.id) {
      clearTimeout(timer.current);
      setArmed(item.id);
      timer.current = setTimeout(() => setArmed(null), CONFIRM_MS);
      return;
    }
    setError(null);
    clearTimeout(timer.current);
    setArmed(null);
    try {
      await decide.mutateAsync({ kind: item.kind, id: item.id, decision, note: reason });
      setRejecting(null);
      setReason("");
    } catch (cause) {
      setError({ id: item.id, text: errorText(cause) });
    }
  }

  return (
    <div className="grid gap-1.5" aria-label="Заявки на удаление">
      {visible.slice(0, 5).map((item) => {
        const pending = decide.isPending && decide.variables?.id === item.id;
        return (
          <div key={item.id} className={ROW}>
            <div className="min-w-0">
              <b className="block break-words text-[16px] font-semibold">
                {item.kind === "CLIENT" ? "Удалить клиента" : "Удалить объект"}: {item.title}
              </b>
              <span className="block break-words text-[13px] text-gray-500">
                {[item.reason, item.requestedBy].filter(Boolean).join(" · ")}
              </span>
            </div>
            {rejecting === item.id ? (
              <div className="grid gap-2">
                <label className="text-[13px] text-gray-600" htmlFor={`reject-${item.id}`}>Почему отклоняете (агент увидит)</label>
                <textarea id={`reject-${item.id}`} rows={2} maxLength={1000} value={reason} disabled={pending}
                  onChange={(event) => setReason(event.target.value)}
                  className="w-full rounded-[14px] border border-line-soft bg-card p-3 text-[14px] text-ink" />
                <div className="flex flex-wrap gap-2">
                  <CButton size="sm" disabled={pending || !reason.trim()} data-endpoint={deleteEndpoint(item.kind, "reject")} onClick={() => void run(item, "reject")}>
                    {pending ? "Отклоняем…" : "Отклонить заявку"}
                  </CButton>
                  <CButton variant="soft" size="sm" disabled={pending} onClick={() => { setRejecting(null); setReason(""); }}>Отмена</CButton>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <CButton size="sm" disabled={decide.isPending} data-endpoint={deleteEndpoint(item.kind, "approve")} onClick={() => void run(item, "approve")}>
                  {pending ? "Выполняем…" : armed === item.id ? "Точно удалить?" : "Одобрить"}
                </CButton>
                {armed === item.id && <CButton variant="soft" size="sm" onClick={() => { clearTimeout(timer.current); setArmed(null); }}>Отмена</CButton>}
                <CButton variant="soft" size="sm" disabled={decide.isPending} onClick={() => { setRejecting(item.id); setReason(""); setArmed(null); }}>Отклонить</CButton>
                <Link to={item.href} className="inline-flex min-h-11 items-center px-2 text-[13px] text-gray-600 underline">Открыть</Link>
              </div>
            )}
            {error?.id === item.id && <p role="alert" className="clean-decision-error m-0">{error.text}</p>}
          </div>
        );
      })}
      {visible.length > 5 && <p className="m-0 text-[13px] text-gray-600">Показаны 5 из {visible.length}. Остальные в архиве.</p>}
    </div>
  );
}

function callbackTitle(item: CallbackRequestView): string {
  return item.clientName || item.phone || "клиент просит позвонить";
}

/** «Просят перезвонить»: каждая просьба своей строкой с кнопкой «Готово» вместо одного счётчика. */
export function CleanCallbackRows({ enabled }: { enabled: boolean }) {
  const requests = useCallbackRequests(enabled);
  const done = useCallbackDone();
  const readOnly = useIsReadOnly();
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  if (!enabled || requests.isLoading) return null;
  if (requests.isError) return <p role="alert" className="clean-decision-error m-0">Очередь просьб о звонке не загрузилась.</p>;
  const items = (requests.data ?? []).filter((item) => !item.lifecycleStatus || item.lifecycleStatus === "QUEUED" || item.lifecycleStatus === "ACCEPTED");
  if (!items.length) return null;

  async function finish(item: CallbackRequestView) {
    if (done.isPending) return;
    setError(null);
    try { await done.mutateAsync(item); }
    catch (cause) { setError({ id: item.id, text: errorText(cause) }); }
  }

  return (
    <div className="grid gap-1.5" aria-label="Просят перезвонить">
      {items.slice(0, 5).map((item) => (
        <div key={item.id} className={ROW}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <b className="block break-words text-[16px] font-semibold">Перезвонить: {callbackTitle(item)}</b>
              <span className="block break-words text-[13px] text-gray-500">
                {[item.phone && item.clientName ? item.phone : null, item.topic, `с ${dushanbeTime(item.requestedAt)}`].filter(Boolean).join(" · ")}
              </span>
            </div>
            {item.lifecycleStatus === "ACCEPTED" && <CChip tone="gray">В работе</CChip>}
          </div>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <CButton size="sm" disabled={done.isPending} data-endpoint="POST /api/v1/me/callback-requests/:id/done" onClick={() => void finish(item)}>
                {done.isPending && done.variables?.id === item.id ? "Закрываем…" : "Готово"}
              </CButton>
              {item.clientShortId != null && <Link to={`/clients/${item.clientShortId}`} className="inline-flex min-h-11 items-center px-2 text-[13px] text-gray-600 underline">Открыть клиента</Link>}
            </div>
          )}
          {error?.id === item.id && <p role="alert" className="clean-decision-error m-0">{error.text}</p>}
        </div>
      ))}
      {items.length > 5 && <p className="m-0 text-[13px] text-gray-600">Показаны 5 из {items.length}.</p>}
    </div>
  );
}
