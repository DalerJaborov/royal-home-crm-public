import { useState } from "react";
import { dushanbeDateTime } from "../../lib/date";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvestigationCaseDetail, InvestigationCaseRow, InvestigationCaseConfig, SellerControlPreviewPage } from "@royal-home/shared";
import { api } from "../../lib/api";
import { Rh2Sheet } from "../rh2/Rh2Sheet";

const statuses = { OPEN: "Новая проверка", REVIEWING: "На рассмотрении", CLEARED: "Подозрение снято", CONFIRMED: "Подтверждено руководителем" } as const;
type Status = keyof typeof statuses;
const label = (status: string) => statuses[status as Status] ?? status;

export function InvestigationCasesPanel() {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["investigation-cases", page], queryFn: () => api<{ items: InvestigationCaseRow[]; total: number }>(`/security/cases?page=${page}`) });
  const preview = useQuery({ queryKey: ["investigation-automation-preview"], queryFn: () => api<{ items: Array<{ id: string; name: string; kind: string }> }>("/security/cases/automation-preview") });
  return <section className="card" aria-label="Дела и доказательства">
    <h2>Дела и доказательства</h2>
    <p className="sub">Закрытый разбор для руководства. Сигналы не означают вину; решение не отправляет уведомлений и не меняет баллы.</p>
    <RecurrenceConfig />
    <SellerControlPreview />
    <details className="card my-3"><summary>Предпросмотр новых проверок — без звонков</summary>
      <p className="sub">Эти записи не набирают клиентов. Изменение настроек позже не активирует их задним числом. Показаны последние 25 записей каждого вида.</p>
      {preview.isPending ? <p>Загрузка…</p> : preview.isError ? <p role="alert">Не удалось загрузить предпросмотр. <button type="button" onClick={() => void preview.refetch()}>Повторить</button></p>
        : preview.data?.items.length ? preview.data.items.map(row => <p key={row.id}>{row.name} · {row.kind === "BUYER" ? "Покупатель" : "Собственник"} · Только предпросмотр</p>) : <p>Записей пока нет.</p>}
    </details>
    {list.isPending ? <p role="status">Загрузка дел…</p> : list.isError ? <p role="alert">Не удалось загрузить дела. <button type="button" className="pill ghost" onClick={() => void list.refetch()}>Повторить</button></p> : <>
      {!list.data?.items.length && <p>Новых дел нет. Старые материалы автоматически не импортируются.</p>}
      <div className="grid gap-3">{list.data?.items.map(row => <button type="button" className="pill ghost text-left whitespace-normal" key={row.id} onClick={() => setSelected(row.id)}>
        <span>{row.subjectAgent?.fullName ?? "Без ответственного"} · {label(row.status)}<br />{row._count.evidence} материалов · {row._count.decisions} решений</span>
      </button>)}</div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className="pill ghost" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Назад</button>
        <span>Страница {page}</span>
        <button type="button" className="pill ghost" disabled={page * 25 >= (list.data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>Далее</button>
      </div>
    </>}
    {selected && <CaseDetail key={selected} id={selected} onClose={() => setSelected(null)} />}
  </section>;
}

function CaseDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const cache = useQueryClient();
  const detail = useQuery({ queryKey: ["investigation-case", id], queryFn: () => api<InvestigationCaseDetail>(`/security/cases/${id}`) });
  const [status, setStatus] = useState<Status>("REVIEWING");
  const [note, setNote] = useState("");
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [level, setLevel] = useState<"C1" | "C2" | "C3">("C1");
  // Keep the exact request on an uncertain response; explicit refresh starts a new decision.
  const [attempt, setAttempt] = useState<{ requestKey: string; revision: number; status: Status; note: string; level?: "C1" | "C2" | "C3" } | null>(null);
  const mutation = useMutation({ retry: false, mutationFn: (body: NonNullable<typeof attempt>) => api<{ decision: { mirrorWarning?: string | null } }>(`/security/cases/${id}/decisions`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (result) => { setDecisionMessage(result.decision.mirrorWarning ?? "Решение сохранено"); setAttempt(null); setNote(""); await cache.invalidateQueries({ queryKey: ["investigation-cases"] }); await detail.refetch(); },
  });
  return <Rh2Sheet title="Разбор дела" onClose={onClose} dismissible={!mutation.isPending}>
    {detail.isPending ? <p role="status">Загрузка материалов…</p> : detail.isError ? <p role="alert">Не удалось загрузить дело. <button type="button" onClick={() => void detail.refetch()}>Повторить</button></p> : detail.data && <div className="grid gap-4">
      <p>{detail.data.level} · {label(detail.data.status)} · {detail.data.subjectAgent?.fullName ?? "Без ответственного"}</p>
      <div className="flex flex-wrap gap-3">
        {detail.data.clientId && <a className="pill ghost" href={`/clients/${detail.data.clientId}`}>Карточка клиента</a>}
        {detail.data.propertyId && <a className="pill ghost" href={`/properties/${detail.data.propertyId}`}>Карточка объекта</a>}
      </div>
      <p className="sub">Групп источников: {detail.data.independentSources}. Несколько выводов из одного звонка не считаются отдельными подтверждениями.</p>
      <h3>Материалы</h3>
      {detail.data.evidence.map(item => <article key={item.id} className="card min-w-0 break-words"><p className="whitespace-pre-wrap">{item.summary}</p><small>{dushanbeDateTime(item.occurredAt)} · {item.sourceType}</small></article>)}
      <h3>История решений</h3>
      {!detail.data.decisions.length && <p>Решений пока нет.</p>}
      {detail.data.decisions.map(item => <article key={item.id} className="card break-words"><strong>{label(item.newStatus)}</strong><p className="whitespace-pre-wrap">{item.note}</p><small>{dushanbeDateTime(item.createdAt)}</small></article>)}
      <label>Решение<select className="w-full" value={status} disabled={mutation.isPending || !!attempt} onChange={e => setStatus(e.target.value as Status)}>{Object.entries(statuses).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
      {status === "REVIEWING" && <label>Уровень рассмотрения<select className="w-full" value={level} disabled={mutation.isPending || !!attempt} onChange={e => setLevel(e.target.value as typeof level)}>
        <option value="C1">C1 — первичный сигнал</option><option value="C2">C2 — требуется проверка обстоятельств</option><option value="C3">C3 — углублённая проверка</option>
      </select></label>}
      <label>Основания<textarea className="w-full" rows={4} maxLength={4000} value={note} disabled={mutation.isPending || !!attempt} onChange={e => setNote(e.target.value)} /></label>
      {mutation.isError && <p role="alert">{mutation.error instanceof Error ? mutation.error.message : "Решение не сохранено"}</p>}
      {decisionMessage && <p role="status">{decisionMessage}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="pill" disabled={mutation.isPending || note.trim().length < 5} onClick={() => {
        const body = attempt ?? { requestKey: crypto.randomUUID(), revision: detail.data!.revision, status, note: note.trim(), ...(status === "REVIEWING" ? { level } : {}) };
        setAttempt(body); mutation.mutate(body);
      }}>{mutation.isPending ? "Сохранение…" : attempt ? "Повторить то же решение" : "Сохранить решение"}</button>
      {attempt && !mutation.isPending && <button type="button" className="pill ghost" onClick={async () => { await detail.refetch(); setAttempt(null); mutation.reset(); }}>Обновить дело</button>}</div>
    </div>}
  </Rh2Sheet>;
}

function RecurrenceConfig() {
  const cache = useQueryClient();
  const config = useQuery({ queryKey: ["investigation-config"], queryFn: () => api<{ config: InvestigationCaseConfig | null }>("/security/cases/config") });
  const recurrence = useQuery({ queryKey: ["investigation-recurrence"], queryFn: () => api<{ evaluation: string; clearedCases: number; groups: Array<{ subjectAgentId: string; agentName: string; cases: number; cleared: number; pending: number; confirmed: number; sourceGroups: number; evaluation: string }> }>("/security/cases/recurrence") });
  const [editing, setEditing] = useState(false);
  const [sample, setSample] = useState("");
  const [repeat, setRepeat] = useState("");
  const [days, setDays] = useState("30");
  const save = useMutation({ retry: false, mutationFn: (value: InvestigationCaseConfig | null) => api("/security/cases/config", { method: "PUT", body: JSON.stringify({ config: value }) }),
    onSuccess: async () => { setEditing(false); await cache.invalidateQueries({ queryKey: ["investigation-config"] }); await cache.invalidateQueries({ queryKey: ["investigation-recurrence"] }); },
  });
  const names: Record<string, string> = { NOT_CONFIGURED: "Пороги не заданы", INSUFFICIENT_SAMPLE: "Недостаточно дел для оценки", REPEATED_CASES_FOR_REVIEW: "Повторяющиеся дела — изучить вручную", BELOW_REPEAT_THRESHOLD: "Ниже выбранного порога", INCOMPLETE_DATA: "Выборка неполная", PREVIEW: "Предварительный обзор" };
  return <details className="card my-3"><summary>Повторяемость и настройки</summary>
    <p className="sub">Считаются отдельные зарегистрированные дела, а не все сделки сотрудника. Полнота телефонии неизвестна. Пороги не устанавливают вину и не запускают оповещения.</p>
    {config.isError || recurrence.isError ? <p role="alert">Данные временно недоступны. <button type="button" onClick={() => { void config.refetch(); void recurrence.refetch(); }}>Повторить</button></p> : <>
      <p>{recurrence.data ? names[recurrence.data.evaluation] ?? recurrence.data.evaluation : "Загрузка…"}</p>
      {recurrence.data?.groups.map(row => <p key={row.subjectAgentId} className="break-words">{row.agentName}: дел {row.cases}, снято подозрений {row.cleared}, на проверке {row.pending}, подтверждено человеком {row.confirmed}. {names[row.evaluation] ?? row.evaluation}</p>)}
      <p>Дел с решением «подозрение снято» за период: {recurrence.data?.clearedCases ?? "—"}.</p>
    </>}
    {!editing ? <button type="button" className="pill ghost" disabled={config.isPending || config.isError} onClick={() => {
      setSample(config.data?.config ? String(config.data.config.minSample) : ""); setRepeat(config.data?.config ? String(config.data.config.repeatThreshold) : ""); setDays(String(config.data?.config?.windowDays ?? 30)); setEditing(true);
    }}>Настроить пороги</button> : <div className="grid gap-3">
      <label>Минимум зарегистрированных дел<input type="number" min={1} max={1000000} step={1} value={sample} onChange={e => setSample(e.target.value)} /></label>
      <label>Порог повторяющихся неснятых дел<input type="number" min={1} max={1000000} step={1} value={repeat} onChange={e => setRepeat(e.target.value)} /></label>
      <label>Период, дней<input type="number" min={1} max={3660} step={1} value={days} onChange={e => setDays(e.target.value)} /></label>
      {save.isError && <p role="alert">{save.error instanceof Error ? save.error.message : "Не удалось сохранить"}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className="pill" disabled={save.isPending || !sample || !repeat || !days} onClick={() => save.mutate({ minSample: Number(sample), repeatThreshold: Number(repeat), windowDays: Number(days) })}>Сохранить</button>
        <button type="button" className="pill ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>Отключить оценку</button>
        <button type="button" className="pill ghost" disabled={save.isPending} onClick={() => setEditing(false)}>Отмена</button></div>
    </div>}
  </details>;
}

function SellerControlPreview() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["seller-control-preview", page], enabled: open,
    queryFn: () => api<SellerControlPreviewPage>(`/security/cases/seller-control-preview?page=${page}`) });
  const when = (date: string | null) => date ? dushanbeDateTime(date) : "Нет данных";
  const states: Record<string, string> = { COMPLETE: "Количество соответствует", MISSING: "Не все объекты оформлены", UNCERTAIN: "Нужно уточнить исходные данные" };
  return <details className="card my-3" onToggle={event => setOpen(event.currentTarget.open)}><summary>Контроль объектов продавца — предпросмотр</summary>
    <p className="sub">Только чтение. Уведомления и проверки не создаются. Черновики без фото или видео не считаются принятыми; передача материалов на проверку учитывается по существующему правилу, а не как одобрение руководителя.</p>
    <p className="sub">Бездействие РОП неизвестно: нет связанного подтверждения передачи вопроса и срока ответа. Автоматическая эскалация владельцу не предлагается.</p>
    {query.isPending ? <p>Загрузка…</p> : query.isError ? <p role="alert">Не удалось получить факты. <button type="button" onClick={() => void query.refetch()}>Повторить</button></p> : <>
      {query.data?.items.map(row => <article className="card my-2" key={row.id}>
        <a href={`/clients/${row.id}`}>{row.name}</a><p>{row.agentName ?? "Без ответственного"} · {states[row.state] ?? row.state}</p>
        <p>Заявлено: {row.expected ?? "неизвестно"}; материалов передано: {row.accepted}; черновиков: {row.drafts}; проданных/снятых: {row.terminal}.</p>
        {row.state === "UNCERTAIN" && <p>Количество без актуальной даты, неизвестно или есть завершённые объекты — нужна ручная сверка.</p>}
        <p>Дата приёмки/встречи: {when(row.anchorAt)}. Попытка агента: {when(row.lastAgentAttemptAt)}. Сообщение клиента: {when(row.lastClientMessageAt)}.</p>
        <p>{row.hasPlannedNextStep ? "Следующий шаг уже назначен." : row.workingDaysSilent !== null ? `По существующему календарному расчёту: ${row.workingDaysSilent} рабочих дней без движения. Только предварительная проверка.` : "Нет подтверждённого вывода о простое."}</p>
      </article>)}
      {!query.data?.items.length && <p>В этой выборке продавцов нет.</p>}
      <div className="flex gap-2 flex-wrap"><button type="button" className="pill ghost" disabled={page === 1} onClick={() => setPage(n => n - 1)}>Назад</button>
        <span>Страница {page}</span><button type="button" className="pill ghost" disabled={page * 50 >= (query.data?.total ?? 0)} onClick={() => setPage(n => n + 1)}>Далее</button></div>
    </>}
  </details>;
}
