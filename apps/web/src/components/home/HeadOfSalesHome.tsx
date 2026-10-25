import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, Check, ClipboardList, RefreshCw, Users } from "lucide-react";
import type { SalesControlHome } from "@royal-home/shared";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth";
import { useCan } from "../../lib/permissions";
import { useTeamLive } from "../../hooks/useTeamLive";
import { dushanbeDateTime } from "../../lib/date";
import { CButton, CCard, CChip, CHead, CLink } from "../clean/ui";

export function HeadOfSalesHome() {
  const actorId = useAuthStore(state => state.agent?.id);
  const can = useCan();
  const queryClient = useQueryClient();
  const work = useQuery({ queryKey: ["rop-work", actorId], enabled: !!actorId,
    queryFn: () => api<SalesControlHome>("/dashboard/sales-control"), refetchInterval: 60_000 });
  const canSeeTeam = can("dashboard.analytics") && can("team.viewFull");
  const team = useTeamLive(canSeeTeam);
  const teamData = canSeeTeam ? team.data : undefined;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const reply = useMutation({ retry: false,
    mutationFn: (input: { taskId: string; action: "RECEIPT" | "ACTION"; requestKey: string; note?: string }) =>
      api(`/interactions/${input.taskId}/work-response`, { method: "POST", body: { action: input.action, requestKey: input.requestKey, ...(input.note ? { note: input.note } : {}) } }),
    onSuccess: async () => { await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["rop-work", actorId] }),
      queryClient.invalidateQueries({ queryKey: ["calendar"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] }),
    ]); },
  });
  const tasks = work.data?.tasks ?? [];
  const waiting = work.data ? tasks.filter(task => task.responseAction === "RECEIPT").length : null;
  const reporting = work.data ? tasks.filter(task => task.responseAction === "ACTION").length : null;
  const overdue = work.data ? tasks.filter(task => task.dueAt && Date.parse(task.dueAt) < Date.now()).length : null;
  const maximumLoad = Math.max(1, ...(teamData?.agents.map(agent => agent.activeLoad) ?? []));
  return <section className="mx-auto w-full max-w-[1240px] space-y-5 pb-8" aria-label="Кабинет РОПа">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><CChip>Кабинет РОПа</CChip><h1 className="mt-3 text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">Отдел продаж</h1>
        <p className="mt-2 max-w-xl text-[14px] text-gray-500">Работа команды и задачи, по которым нужен ваш ответ.</p></div>
      <div className="flex flex-wrap gap-2"><CLink to="/clients" variant="primary">Клиенты <ArrowUpRight /></CLink>
        <CLink to="/messages" variant="white">Чаты</CLink><CLink to="/deals" variant="white">Сделки</CLink></div>
    </header>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[["Ждут принятия", waiting], ["Нужен отчёт", reporting], ["Просрочено в очереди", overdue], ["В работе у команды", teamData ? teamData.agents.reduce((sum, agent) => sum + agent.activeLoad, 0) : null]].map(([label, value]) =>
        <CCard key={String(label)} className="p-4 sm:p-5"><p className="text-[13px] text-gray-500">{label}</p><p className="mt-2 text-[30px] font-semibold tabular-nums">{value ?? "—"}</p></CCard>)}
    </div>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <CCard className="min-w-0 p-4 sm:p-6"><CHead title="Требуют вашего ответа" right={<CButton variant="soft" size="icon" aria-label="Обновить задачи" onClick={() => void work.refetch()}><RefreshCw /></CButton>} />
        {work.isPending ? <p role="status" className="py-8 text-gray-500">Загружаем задачи…</p> : work.isError ? <div role="alert" className="py-5"><p>Не удалось загрузить задачи.</p><CButton variant="white" className="mt-3" onClick={() => void work.refetch()}>Повторить</CButton></div> : <>
          {!tasks.length && <div className="py-10 text-center"><Check className="mx-auto size-8 text-blue" /><h2 className="mt-3 text-[18px] font-semibold">Нет задач, требующих ответа</h2><p className="mt-2 text-[14px] text-gray-500">Свои встречи и другие задачи можно посмотреть в календаре.</p><CLink to="/calendar" variant="white" className="mt-4"><CalendarDays /> Открыть календарь</CLink></div>}
          {!work.data.actionsEnabled && tasks.length > 0 && <p className="my-3 text-[13px] text-gray-500">Ответы по этим задачам временно недоступны. Можно продолжить работу в карточке клиента.</p>}
          <div className="space-y-4">{tasks.map(task => <article key={task.id} className="rounded-[20px] bg-row-alt p-4">
            <div className="flex flex-wrap items-start justify-between gap-2"><Link className="font-semibold underline-offset-4 hover:underline" to={`/clients/${task.clientShortId}`}>{task.clientName}</Link><CChip>{task.responseAction === "RECEIPT" ? "Ожидает принятия" : task.responseAction === "ACTION" ? "Нужен отчёт" : "В работе"}</CChip></div>
            <p className="mt-2 text-[14px]">{task.title}</p><p className="mt-2 text-[13px] text-gray-500">{task.dueAt ? `Срок: ${dushanbeDateTime(task.dueAt)}` : "Срок не указан"}</p>
            {task.responseAction === "ACTION" && <label className="mt-4 block text-[13px] font-medium">Что сделано по клиенту<textarea value={notes[task.id] ?? ""} maxLength={2000} rows={3} className="mt-2 w-full rounded-[14px] border border-line bg-card p-3 text-[14px]" onChange={event => setNotes(old => ({ ...old, [task.id]: event.target.value }))} /></label>}
            <div className="mt-4 flex flex-wrap gap-2">{task.responseAction && work.data.actionsEnabled && <CButton disabled={reply.isPending || (task.responseAction === "ACTION" && (notes[task.id]?.trim().length ?? 0) < 3)} onClick={() => {
              if (!work.data?.actionsEnabled || !task.responseAction) return;
              reply.mutate({ taskId: task.id, action: task.responseAction, requestKey: crypto.randomUUID(), ...(task.responseAction === "ACTION" ? { note: notes[task.id].trim() } : {}) });
            }}>{task.responseAction === "RECEIPT" ? "Принять в работу" : "Сохранить отчёт"}</CButton>}<CLink to={`/clients/${task.clientShortId}`} variant="white">Открыть клиента</CLink></div>
          </article>)}</div>
          {work.data.limited && <p className="mt-4 text-[13px] text-gray-500">Показаны первые 100 записей. Остальные задачи доступны в календаре.</p>}
        </>}
        {reply.isError && <p role="alert" className="mt-4 text-[14px] text-red-600">{reply.error.message}</p>}
      </CCard>
      <div className="min-w-0 space-y-5">{canSeeTeam && <CCard className="p-4 sm:p-6"><CHead title="Нагрузка команды" right={<CLink to="/team" variant="soft" size="sm">Вся команда</CLink>} />
        {team.isPending ? <p role="status" className="mt-4 text-gray-500">Загружаем команду…</p> : team.isError ? <p role="alert" className="mt-4 text-gray-500">Данные команды пока недоступны.</p> : !teamData?.agents.length ? <p className="mt-4 text-gray-500">Сотрудников в этой очереди пока нет.</p> : <div className="mt-4 space-y-5">{teamData.agents.slice(0, 8).map(agent => <Link key={agent.id} to={`/team/${agent.id}`} className="block"><div className="flex min-w-0 items-center justify-between gap-3 text-[14px]"><span className="truncate font-medium">{agent.fullName}</span><span className="shrink-0 tabular-nums">{agent.activeLoad} клиентов</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-row-alt"><div className="h-full rounded-full bg-blue" style={{ width: `${agent.activeLoad / maximumLoad * 100}%` }} /></div><p className="mt-1 text-[13px] text-gray-500">Ждут принятия: {agent.pendingAccept}</p></Link>)}</div>}
      </CCard>}
      <CCard className="p-4 sm:p-6"><CHead title="Рабочие разделы" /><div className="mt-4 flex flex-wrap gap-2"><CLink to="/calendar" variant="white"><CalendarDays /> Календарь</CLink>{can("team.viewFull") && <CLink to="/team" variant="white"><Users /> Команда</CLink>}{can("reports.view") && <CLink to="/reports" variant="white"><ClipboardList /> Отчёты</CLink>}</div></CCard></div>
    </div>
  </section>;
}
