import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canViewInvestigations, type PostShowingCohortConfig, type PostShowingCohortView } from "@royal-home/shared";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import { dushanbeDateTime } from "../lib/date";

export function PostShowingCohort() {
  const role = useAuthStore(s => s.agent?.role), can = useCan();
  if (!canViewInvestigations(role) || !can("clients.securityReview")) return null;
  return <PrivateCohort />;
}
function PrivateCohort() {
  const [opened, setOpened] = useState(false), [draft, setDraft] = useState<PostShowingCohortConfig | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["post-showing-cohort"], queryFn: () => api<PostShowingCohortView>("/reports/post-showing-cohort"), enabled: opened, retry: false });
  const data = query.data, config = draft ?? data?.config;
  const fields: Array<[keyof PostShowingCohortConfig, string]> = [["windowDays", "Окно, дней"], ["minAgentShowings", "Минимум показов агента"], ["minPeerShowings", "Минимум показов остальных"], ["minSilentCases", "Минимум случаев"], ["minRatio", "Отношение долей"], ["minGapPercentagePoints", "Разница, процентных пунктов"]];
  return <section className="card space-y-3 p-4" aria-label="Сравнение результатов после показов">
    <button className="pill" type="button" onClick={() => setOpened(!opened)}>Факты после показов · агент и остальные</button>
    {opened && <>
      {query.isPending && <p role="status">Загружаем подтверждённые записи…</p>}
      {query.error && <p role="alert">{query.error.message}. Отсутствие данных не означает нулевую долю.</p>}
      {data && <PostShowingCohortFacts data={data} />}
      {config && <details><summary>Пороги сравнения</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{fields.map(([key, label]) => <label className="text-sm" key={key}>{label}<input type="number" className="input w-full" value={config[key]} step={key === "minRatio" ? 0.1 : 1} onChange={event => setDraft({ ...config, [key]: Number(event.target.value) })} /></label>)}</div><p className="mt-2 text-xs">Пороги не устанавливают виновность, не меняют баллы и не создают C4 автоматически.</p><button className="pill mt-2" disabled={busy} type="button" onClick={async () => { setBusy(true); setError(""); try { await api("/reports/post-showing-cohort/config", { method: "PUT", body: config }); setDraft(null); await qc.invalidateQueries({ queryKey: ["post-showing-cohort"] }); } catch (err) { setError(err instanceof Error ? err.message : "Настройки не сохранены"); } finally { setBusy(false); } }}>Сохранить пороги</button></details>}
      {error && <p role="alert">{error}</p>}
    </>}
  </section>;
}

export function PostShowingCohortFacts({ data }: { data: PostShowingCohortView }) {
  return <>
        <p className="text-sm">Период: {dushanbeDateTime(data.from)} — {dushanbeDateTime(data.to)}. Срез: {dushanbeDateTime(data.asOf)}.</p>
        <p className="rounded border p-3 text-sm">Неответ на завершённые попытки опроса и невыясненный результат разделены. Ответивший роботу с отказом или неясным итогом не считается молчащим. Ни один показатель не доказывает виновность.</p>
        {data.evaluation === "TRUNCATED" && <p role="alert">Объём данных превышает предел выборки. Доли не рассчитаны.</p>}
        {data.evaluation === "DEFINITION_PENDING" && <p role="status">Сохранён ранний срез без классификации. Исторические доли не пересчитаны.</p>}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Агент</th><th>Записей</th><th>Ответ в CRM</th><th>Ответ роботу</th><th>Результат опроса не уточнён</th><th>Неопределённость</th></tr></thead><tbody>{data.agents.map(a => <tr key={a.agentId}><td>{a.agentName}</td><td>{a.recorded}</td><td>{a.publicResponses}</td><td>{a.robotResponses}</td><td>{a.unresolvedSurvey}</td><td>{a.unknown}</td></tr>)}</tbody></table></div>
        <div className="grid gap-2 sm:grid-cols-2">{data.agents.map(a => <div className="rounded border p-3 text-sm" key={a.agentId}><strong>{a.agentName}</strong><p>Не ответили на завершённые попытки: {a.silent ?? "неизвестно"} из {a.eligible ?? "неизвестно"}.</p><p>Доля агента: {a.ratePercent === null ? "нет данных" : `${a.ratePercent.toFixed(1)}%`}. Остальные: {a.peerRatePercent === null ? "нет данных" : `${a.peerRatePercent.toFixed(1)}%`} ({a.peerEligible ?? "неизвестно"} наблюдений).</p><p>{a.evaluation === "INSUFFICIENT_SAMPLE" ? "Недостаточная выборка для сравнения по порогам." : a.evaluation === "ZERO_OR_MISSING_PEER_BASELINE" ? "Нулевая или отсутствующая база остальных: отношение долей не определено." : a.aboveDescriptiveThreshold ? "Порог описательного сравнения превышен; необходим разбор человеком." : "Автоматический вывод о сотруднике не формируется."}</p></div>)}</div>
        <p className="text-sm">Всего записанных показов: {data.coverage.recordedShowings}. Без снимка агента опроса: {data.coverage.unobserved}. Предварительные опросы: {data.coverage.preview}. Незавершённые: {data.coverage.pending}. С пересечением простоя станции: {data.coverage.stationOutage}. Дата проведения не подтверждена: {data.coverage.occurrenceUnconfirmed}.</p>
        {data.limitations.map(text => <p className="text-xs text-slate-600" key={text}>{text}</p>)}
      </>;
}
