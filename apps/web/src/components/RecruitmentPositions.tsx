import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { recruitmentPositionUpdateSchema, recruitmentPostCode, type RecruitmentPosition, type RecruitmentPositionInput } from "@royal-home/shared";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";

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
    {manage && editing && <PositionForm key={`${actor}:${epoch}:${editing === "new" ? "new" : editing.key}`}
      initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
  </section>;
}

function PositionForm({ initial, onClose }: { initial: RecruitmentPosition | null; onClose(): void }) {
  const actor = useAuthStore(s => s.agent?.id), epoch = useAuthStore(s => s.sessionEpoch), cache = useQueryClient();
  const [key] = useState(() => initial?.key ?? `position-${crypto.randomUUID()}`);
  const [draft, setDraft] = useState(() => initial ?? { titleRu: "", titleTg: "", detailsRu: "", detailsTg: "", isOpen: false });
  const [keywords, setKeywords] = useState(initial?.keywords.join("\n") ?? "");
  const [posts, setPosts] = useState(initial?.postCodes.join("\n") ?? ""), [error, setError] = useState("");
  const save = useMutation({ mutationFn: async () => {
    const values = posts.split(/\r?\n/).map(s => s.trim()).filter(Boolean), parsed = values.map(recruitmentPostCode);
    if (parsed.some(code => !code)) throw Error("Вставьте ссылки Instagram или коды публикаций: по одному в строке.");
    const payload = recruitmentPositionUpdateSchema.safeParse({ titleRu: draft.titleRu, titleTg: draft.titleTg,
      detailsRu: draft.detailsRu, detailsTg: draft.detailsTg, isOpen: draft.isOpen,
      postCodes: [...new Set(parsed as string[])], keywords: keywords.split(/\r?\n/).map(s => s.trim()).filter(Boolean), expectedRevision: initial?.revision ?? 0 });
    if (!payload.success) throw Error("Заполните названия на двух языках; условия — до 2000 символов, публикаций — до 24.");
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
    <label className="grid gap-1 mt-4">Публикации Instagram<textarea rows={3} value={posts} onChange={e => setPosts(e.target.value)} placeholder="Ссылка или код, по одному в строке" /></label>
    <label className="grid gap-1 mt-4">Ключевые слова отклика<textarea rows={2} value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="Например: контент. По одному слову в строке" /></label>
    <label className="flex gap-2 my-4"><input type="checkbox" checked={draft.isOpen} onChange={e => setDraft({ ...draft, isOpen: e.target.checked })} />Набор открыт</label>
    {error && <p role="alert">{error}</p>}
    <div className="flex flex-wrap gap-2"><button type="submit" className="pill" disabled={save.isPending}>{save.isPending ? "Сохраняем…" : "Сохранить"}</button>
      <button type="button" className="pill ghost" disabled={save.isPending} onClick={onClose}>Отмена</button></div>
  </form>;
}
