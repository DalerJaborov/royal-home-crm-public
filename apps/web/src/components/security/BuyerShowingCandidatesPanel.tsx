import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { BuyerShowingCandidatePreview } from "@royal-home/shared";
import { api } from "../../lib/api";
import { dushanbeDateTime } from "../../lib/date";
import { useAgents } from "../../hooks/useAgents";

const labels: Record<string, string> = { RECORDED: "Показ внесён", WAITING: "Срок проверки не наступил", MISSING_SHOWING: "Соответствующий показ не найден", MATCH_UNCERTAIN: "Есть показ этого объекта; связь с договорённостью требует проверки", ASSIGNMENT_ENDED: "Прежняя работа завершена" };
export function BuyerShowingCandidatesPanel() {
  const [ropAgentId, setRopAgentId] = useState("");
  const agents = useAgents(); const cache = useQueryClient();
  const start = useMutation({ retry: false, mutationFn: (row: BuyerShowingCandidatePreview) => api("/security/cases/seller-control/buyer-candidate", {
    method: "POST", body: { buyerCandidateId: row.id, candidateRevision: row.revision, ropAgentId, requestKey: crypto.randomUUID() } }),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ["seller-control-episodes"] }); } });
  const query = useQuery({ queryKey: ["buyer-showing-candidates"], queryFn: () => api<{ items: BuyerShowingCandidatePreview[] }>("/security/cases/buyer-showing-candidates") });
  return <details className="card my-3"><summary>Договорённости о показе — предпросмотр</summary>
    <p className="sub">Последние 100 договорённостей из разговоров и переписки. Предварительные записи не создают задач. Рабочее исполнение доступно только новым отдельно разрешённым записям и при включённом серверном допуске.</p>
    {query.data?.items.some(row => row.executionMode === "LIVE") && <label>Ответственный руководитель<select value={ropAgentId} onChange={e => setRopAgentId(e.target.value)}><option value="">Выберите</option>{agents.data?.filter(a => a.isActive && ["MANAGER", "ADMIN", "DIRECTOR"].includes(a.role)).map(a => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label>}
    {start.isError && <p role="alert">{start.error.message}</p>}
    {query.isPending ? <p>Загрузка…</p> : query.isError ? <p role="alert">Не удалось загрузить договорённости. <button onClick={() => void query.refetch()}>Повторить</button></p>
      : !query.data?.items.length ? <p>Новых договорённостей нет. Старые данные автоматически не импортируются.</p>
      : <div className="grid gap-3">{query.data.items.map(row => <div key={row.id} className="card">
        <a href={`/clients/${row.clientId}`}>Карточка клиента</a><p>{row.sourceType === "CALL" ? "Разговор" : "Переписка"} · {row.proposedAt ? dushanbeDateTime(row.proposedAt) : "Точное время не установлено"}</p>
        <p>{labels[row.evaluation] ?? "Требуется проверка"}</p>
        {row.confidence === "OBJECT_UNKNOWN" && <p>Объект не установлен — нужна проверка исходного разговора.</p>}
        {row.plannedAction && <p>Предлагается обычное напоминание агенту. Пока не отправлено.</p>}
        <p className="sub">Повторная проверка: {row.followupDueAt ? dushanbeDateTime(row.followupDueAt) : "срок не настроен"}. Уровни проверки автоматически не меняются.</p>
        {row.executionMode === "LIVE" && row.evaluation === "MISSING_SHOWING" && <button disabled={start.isPending || !ropAgentId} onClick={() => start.mutate(row)}>Создать рабочую задачу</button>}
      </div>)}</div>}
  </details>;
}
