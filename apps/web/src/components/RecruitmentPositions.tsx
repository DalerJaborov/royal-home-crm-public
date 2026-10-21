import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { recruitmentPositionUpdateSchema, recruitmentPostCode, recruitmentRecoveryRequestSchema,
  DEFAULT_RECRUITMENT_SCREENING_RULES, RECRUITMENT_FACT_LABELS, type RecruitmentScreeningRules,
  type RecruitmentFactKey, type RecruitmentPosition, type RecruitmentPositionInput } from "@royal-home/shared";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import { dushanbeDateTime } from "../lib/date";

type Catalog = { items: RecruitmentPosition[] };
export function RecruitmentPositions() {
  const can = useCan(), actor = useAuthStore(s => s.agent?.id), epoch = useAuthStore(s => s.sessionEpoch);
  const query = useQuery({ queryKey: ["recruitment-positions", actor], enabled: can("vacancies.view"),
    queryFn: () => api<Catalog>("/vacancies/positions", { expectAgentId: actor }) });
  const [editing, setEditing] = useState<RecruitmentPosition | "new" | null>(null);
  const manage = can("settings.manage");
  const templates = useQuery({ queryKey: ["recruitment-templates", actor], enabled: manage,
    queryFn: () => api<{ items: Array<RecruitmentPositionInput & { key: string }> }>("/vacancies/positions/templates", { expectAgentId: actor }) });
  return <section aria-labelledby="recruitment-positions-title">
    <div className="pg-h"><div><h2 id="recruitment-positions-title">Открытые позиции</h2>
      <p className="sub">Бот берёт вакансии и условия из этого списка. Закрытая позиция больше не предлагается. Анкеты кандидатов остаются в соседней вкладке.</p></div>
      {manage && <button type="button" className="pill" onClick={() => setEditing("new")}>Добавить вакансию</button>}
    </div>
    {manage && templates.data && <div className="flex flex-wrap gap-2 mb-4" aria-label="Заготовки вакансий">
      {templates.data.items.filter(item => !query.data?.items.some(existing => existing.key === item.key)).map(item =>
        <button key={item.key} type="button" className="pill ghost" onClick={() => setEditing({ ...item, revision: 0 })}>
          Заполнить: {item.titleRu}
        </button>)}
      <p className="sub w-full">Заготовка не открывает набор: проверьте условия и сохраните карточку с включённым набором.</p>
    </div>}
    {query.isError && <div role="alert"><p>Не удалось обновить вакансии.</p><button type="button" className="pill ghost" onClick={() => void query.refetch()}>Повторить</button></div>}
    {query.isPending ? <p role="status">Загружаем вакансии…</p> : !query.data ? null : <>
      {!query.data.items.length && <p>Пока ни одной позиции. Добавьте должность и откройте набор, чтобы бот мог её предложить.</p>}
      <div className="list">{query.data.items.map(item => <article key={item.key} className="row">
        <div className="body"><h3>{item.titleRu}</h3><p>{item.titleTg}</p>
          <p className="sub">{item.isOpen ? "Набор открыт" : "Набор закрыт"} · Привязано публикаций: {item.postCodes.length}</p></div>
        {manage && <div className="act"><button type="button" className="pill ghost" onClick={() => setEditing(item)}>Изменить</button></div>}
      </article>)}</div>
    </>}
    {manage && <RecruitmentRecovery key={`${actor}:${epoch}`} actor={actor} epoch={epoch} />}
    {manage && editing && <PositionForm key={`${actor}:${epoch}:${editing === "new" ? "new" : editing.key}`}
      initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
  </section>;
}

type RecoveryItem = { conversationId: string; status: string; reason?: string; scheduledAt?: string; providerReceiptPresent?: boolean; visibleInConversation?: boolean };
function RecruitmentRecovery({ actor, epoch }: { actor?: string; epoch: number }) {
  const [campaign, setCampaign] = useState("");
  const [recipients, setRecipients] = useState("");
  const [error, setError] = useState("");
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const send = useMutation({ mutationFn: (body: unknown) => api<{ items: RecoveryItem[] }>("/vacancies/positions/recovery", {
    method: "POST", body, expectAgentId: actor }),
    onSuccess: value => { setItems(value.items); setError(""); }, onError: () => setError("Не удалось получить результат. Обновите статус кампании перед повторной отправкой.") });
  const status = useMutation({ mutationFn: () => api<{ items: RecoveryItem[] }>(`/vacancies/positions/recovery/${encodeURIComponent(campaign)}`, { expectAgentId: actor }),
    onSuccess: value => { setItems(value.items); setError(""); }, onError: () => setError("Не удалось обновить статус кампании.") });
  return <details className="mt-5" key={`${actor}:${epoch}`}>
    <summary>Исправленные ответы кандидатам</summary>
    <p className="sub">Однократный ответ бота по проверенным откликам. Паузы сотрудника и ограничения канала сохраняются. Неизвестная доставка не повторяется.</p>
    <label className="block mt-3">Название кампании<input className="input w-full" value={campaign} onChange={e => setCampaign(e.target.value)} /></label>
    <label className="block mt-3">Проверенный список откликов (JSON)<textarea className="input w-full" rows={5} value={recipients} onChange={e => setRecipients(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-2 mt-3"><button type="button" className="pill" disabled={send.isPending || status.isPending} onClick={() => {
      try {
        const value = recruitmentRecoveryRequestSchema.safeParse({ campaign, recipients: JSON.parse(recipients) });
        if (!value.success) { setError("Проверьте название кампании и список откликов."); return; }
        send.mutate(value.data);
      } catch { setError("Список откликов должен быть корректным JSON."); }
    }}>Отправить исправленные ответы ботом</button>
      <button type="button" className="pill ghost" disabled={!/^[a-z0-9-]{8,64}$/.test(campaign) || status.isPending} onClick={() => status.mutate()}>Обновить статус кампании</button></div>
    {!!items.length && <div role="status"><p>Проверено откликов: {items.length}. Отправка подтверждена: {items.filter(item => item.status === "ACCEPTED" && item.providerReceiptPresent).length}.</p>
      <ul>{items.map(item => <li key={item.conversationId}>{item.conversationId.slice(0, 8)}: {item.status}{item.status === "READY" && item.scheduledAt ? ` — ${dushanbeDateTime(item.scheduledAt)}` : ""}{item.reason ? ` (${item.reason})` : ""}</li>)}</ul></div>}
  </details>;
}

function PositionForm({ initial, onClose }: { initial: RecruitmentPosition | null; onClose(): void }) {
  const actor = useAuthStore(s => s.agent?.id), epoch = useAuthStore(s => s.sessionEpoch), cache = useQueryClient();
  const [key] = useState(() => initial?.key ?? `position-${crypto.randomUUID()}`);
  const [draft, setDraft] = useState(() => initial ?? { titleRu: "", titleTg: "", detailsRu: "", detailsTg: "", isOpen: false });
  const [rules, setRules] = useState<RecruitmentScreeningRules>(() => structuredClone(initial?.screeningRules ?? DEFAULT_RECRUITMENT_SCREENING_RULES));
  const [keywords, setKeywords] = useState(initial?.keywords.join("\n") ?? "");
  const [posts, setPosts] = useState(initial?.postCodes.join("\n") ?? ""), [error, setError] = useState("");
  const save = useMutation({ mutationFn: async () => {
    const values = posts.split(/\r?\n/).map(s => s.trim()).filter(Boolean), parsed = values.map(recruitmentPostCode);
    if (parsed.some(code => !code)) throw Error("Вставьте ссылки Instagram или коды публикаций: по одному в строке.");
    const payload = recruitmentPositionUpdateSchema.safeParse({ titleRu: draft.titleRu, titleTg: draft.titleTg,
      detailsRu: draft.detailsRu, detailsTg: draft.detailsTg, isOpen: draft.isOpen, screeningRules: rules,
      postCodes: [...new Set(parsed as string[])], keywords: keywords.split(/\r?\n/).map(s => s.trim()).filter(Boolean), expectedRevision: initial?.revision ?? 0 });
    if (!payload.success) throw Error(payload.error.issues.some(issue => issue.path[0] === "screeningRules")
      ? "Проверьте правила: минимальный возраст от 16 до 100 лет или оставьте поле пустым."
      : "Заполните названия на двух языках; условия — до 2000 символов, публикаций — до 24, ключевых слов — до 16 без повторов.");
    return api<Catalog>(`/vacancies/positions/${key}`, { method: "PUT", body: payload.data, expectAgentId: actor });
  }, onSuccess: data => {
    const current = useAuthStore.getState();
    if (current.agent?.id !== actor || current.sessionEpoch !== epoch) return;
    cache.setQueryData(["recruitment-positions", actor], data); onClose();
  }, onError: err => setError(err instanceof Error ? err.message : "Не удалось сохранить вакансию") });
  return <form className="card" aria-label={initial ? "Изменить вакансию" : "Новая вакансия"}
    onSubmit={event => { event.preventDefault(); setError(""); save.mutate(); }}>
    <h3>{initial ? "Изменить вакансию" : "Новая вакансия"}</h3>
    <p className="sub">Только публичные условия. Телефоны кандидатов и внутренние заметки здесь не размещайте. Без указанной зарплаты бот её не называет.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1">Название на русском<input required maxLength={140} value={draft.titleRu} onChange={e => setDraft({ ...draft, titleRu: e.target.value })} /></label>
      <label className="grid gap-1">Ном ба тоҷикӣ<input required maxLength={140} value={draft.titleTg} onChange={e => setDraft({ ...draft, titleTg: e.target.value })} /></label>
      <label className="grid gap-1">Условия на русском<textarea rows={5} maxLength={2000} value={draft.detailsRu} onChange={e => setDraft({ ...draft, detailsRu: e.target.value })} /></label>
      <label className="grid gap-1">Шартҳо ба тоҷикӣ<textarea rows={5} maxLength={2000} value={draft.detailsTg} onChange={e => setDraft({ ...draft, detailsTg: e.target.value })} /></label>
    </div>
    <fieldset className="mt-5 border border-slate-200 rounded-xl p-4">
      <legend className="px-1 font-medium">Что выяснить у кандидата на эту должность</legend>
      <p className="sub mb-3">Правила действуют только для этой вакансии. Они подсказывают, что уточнить; решение о приглашении и найме принимает человек. Прежние решения и этапы кандидатов не меняются.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">Минимальный возраст (необязательно)<input className="input" type="number" min={16} max={100}
          value={rules.minimumAge ?? ""} onChange={event => setRules({ ...rules, minimumAge: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <div className="grid gap-2 content-start">
          <label className="flex gap-2"><input type="checkbox" checked={rules.allowStudying} onChange={event => setRules({ ...rules, allowStudying: event.target.checked })} />Можно совмещать с учёбой</label>
          <label className="flex gap-2"><input type="checkbox" checked={rules.allowOtherEmployment} onChange={event => setRules({ ...rules, allowOtherEmployment: event.target.checked })} />Можно совмещать с другой работой</label>
        </div>
      </div>
      <p className="sub mt-3">Нужные сведения. Отсутствие опыта не означает отказ; портфолио может заменить рассказ о себе.</p>
      <div className="grid gap-2 mt-2 sm:grid-cols-2">
        {(Object.keys(RECRUITMENT_FACT_LABELS) as RecruitmentFactKey[]).map(key => <label className="flex gap-2" key={key}>
          <input type="checkbox" checked={rules.requiredFacts.includes(key)} onChange={event => setRules({ ...rules,
            requiredFacts: event.target.checked ? [...rules.requiredFacts, key] : rules.requiredFacts.filter(value => value !== key) })} />{RECRUITMENT_FACT_LABELS[key]}
        </label>)}
      </div>
    </fieldset>
    <label className="grid gap-1 mt-4">Публикации Instagram<textarea rows={3} value={posts} onChange={e => setPosts(e.target.value)} placeholder="Ссылка или код, по одному в строке" /></label>
    <label className="grid gap-1 mt-4">Ключевые слова отклика<textarea rows={2} value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="Например: контент. По одному слову в строке" /></label>
    <label className="flex gap-2 my-4"><input type="checkbox" checked={draft.isOpen} onChange={e => setDraft({ ...draft, isOpen: e.target.checked })} />Набор открыт</label>
    {error && <p role="alert">{error}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" className="pill" disabled={save.isPending}>{save.isPending ? "Сохраняем…" : "Сохранить"}</button>
      <button type="button" className="pill ghost" disabled={save.isPending} onClick={onClose}>Отмена</button></div>
  </form>;
}
