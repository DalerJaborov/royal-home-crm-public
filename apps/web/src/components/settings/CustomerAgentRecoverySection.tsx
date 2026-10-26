import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customerAgentQualityRecoveryStateSchema, customerAgentQualityRecoveryResultSchema,
  type CustomerAgentQualityRecoveryRequest } from "@royal-home/shared";
import { api, ApiError } from "../../lib/api";
import { ConfirmDialog } from "../ConfirmDialog";

const ownerKey = ["settings", "customer-agent"] as const;
const recoveryKey = [...ownerKey, "recovery"] as const;

function recoveryError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Результат пока не подтверждён. Повторная проверка использует тот же запрос и не создаёт второй возврат.";
  if (error.status === 428) return "Подтвердите личность администратора в настройках, затем проверьте результат ещё раз.";
  if (error.status === 403) return "Право управления настройками недоступно. Обновите состояние.";
  if (error.status === 409) return "Возврат пока недоступен: состояние изменилось или есть незавершённая работа. Обновите состояние.";
  return "Сервер не подтвердил возврат. Проверьте состояние перед следующим действием.";
}

/** Only included in the separately tested reserve build. No automatic recovery. */
export function CustomerAgentRecoverySection() {
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const [resume, setResume] = useState(false);
  const [request, setRequest] = useState<CustomerAgentQualityRecoveryRequest | null>(null);
  const state = useQuery({ queryKey: recoveryKey, retry: false,
    queryFn: async () => customerAgentQualityRecoveryStateSchema.parse(await api<unknown>("/settings/customer-agent/recovery-state")) });
  const recover = useMutation({ retry: false,
    mutationFn: async (body: CustomerAgentQualityRecoveryRequest) => customerAgentQualityRecoveryResultSchema.parse(
      await api<unknown>("/settings/customer-agent/recover-quality", { method: "POST", body })),
    onSuccess: async () => {
      setRequest(null); setReason(""); setResume(false);
      await cache.invalidateQueries({ queryKey: ownerKey });
    },
  });
  const data = state.data;
  const canPrepare = data?.status === "ready" && reason.trim().length > 0 &&
    (!data.requiresResumeFromOff || resume) && !recover.isPending;

  function prepare() {
    if (!data || !canPrepare) return;
    recover.reset();
    setRequest({ expectedPolicyRevision: data.policyRevision, requestId: crypto.randomUUID(), reason: reason.trim(),
      confirmQualityRecovery: true, ...(data.requiresResumeFromOff ? { acknowledgeResumeFromOff: true as const } : {}) });
  }

  return <div className="space-y-4">
    <div className="mod"><div className="t"><b>Резервная версия бота</b>
      <span>Этот раздел предназначен для согласованного восстановления после обновления. Возврат выполняет администратор или директор после проверки совместимости.</span></div></div>
    {state.isLoading && <p className="state">Проверяем возможность возврата…</p>}
    {state.isError && <p className="state err" role="alert">Не удалось проверить возможность возврата.</p>}
    {data?.status === "blocked" && <p className="state">Возврат сейчас недоступен. Завершите текущие операции и проверьте совместимость резервной версии.</p>}
    {data?.status === "already_recovered" && <p className="state" role="status">Резервная версия уже подключена. Повторный возврат не требуется.</p>}
    {data?.status === "ready" && <>
      <p className="state">Будущие сообщения уже подключённых диалогов продолжит резервная версия. История, права, каналы и лимиты сохранятся. Старые сообщения и неизвестные отправки повторно не запускаются.</p>
      <label className="fld"><span className="lab">Причина возврата</span><input value={reason} maxLength={500} disabled={!!request}
        onChange={event => setReason(event.target.value)} /></label>
      {data.requiresResumeFromOff && <label className="mod"><span className="t"><b>Возобновить работу после остановки</b>
        <span>Бот сейчас выключен. Подтверждаю его включение с прежними правами и лимитами.</span></span>
        <input type="checkbox" checked={resume} disabled={!!request} onChange={event => setResume(event.target.checked)} /></label>}
    </>}
    <div className="flex flex-wrap items-center gap-3">
      {data?.status === "ready" && <button type="button" className="pill" disabled={!canPrepare || !!request} onClick={prepare}>Подготовить возврат бота</button>}
      <button type="button" className="lnk" disabled={recover.isPending} onClick={() => void state.refetch()}>Обновить состояние возврата</button>
    </div>
    {request && <ConfirmDialog title="Подключить резервную версию бота?"
      description="Сервер ещё раз проверит версию, права и незавершённые операции. Состояние клиентов и подтверждённые действия сохранятся. Автоматические рассылки и новые права не включаются."
      confirmLabel={recover.isError ? "Проверить результат" : "Подключить резервную версию"}
      dismissible={!recover.isPending} confirmDisabled={recover.isPending}
      onCancel={() => { setRequest(null); recover.reset(); void state.refetch(); }}
      onConfirm={() => recover.mutate(request)}>
      <p className="state">Причина: {request.reason}</p>
      {request.acknowledgeResumeFromOff && <p className="state">Подтверждено включение бота после остановки.</p>}
      {recover.isError && <p className="state err" role="alert">{recoveryError(recover.error)}</p>}
    </ConfirmDialog>}
  </div>;
}
