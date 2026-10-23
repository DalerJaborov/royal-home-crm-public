import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { recruitmentPositionUpdateSchema, recruitmentPostCode, recruitmentRecoveryRequestSchema,
  DEFAULT_RECRUITMENT_SCREENING_RULES, RECRUITMENT_FACT_LABELS, type RecruitmentScreeningRules,
  type RecruitmentFactKey, type RecruitmentPosition, type RecruitmentPositionInput } from "@royal-home/shared";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { dushanbeDateTime } from "../lib/date";
import { CButton, CCard, CHead } from "./clean/ui";

type Catalog = { items: RecruitmentPosition[] };

/** Кнопка вкладки: CButton в оболочке Clean, кнопка набора `.pill` — в прежней оболочке. */
function Act({ clean, primary = false, type = "button", ...rest }: { clean: boolean; primary?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return clean ? <CButton variant={primary ? "primary" : "outline"} type={type} {...rest} />
    : <button type={type} className={primary ? "pill" : "pill ghost"} {...rest} />;
}

/** Поле формы — `.fld` темы: подпись `.lab` над полем, пояснение `.msg` под ним. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="fld"><span className="lab">{label}</span>{children}{hint && <span className="msg">{hint}</span>}</label>;
}

/** candidateCounts — число анкет по ключу вакансии (positionCounts сервера);
 *  нет у старого сервера — тогда строки с числом нет. */
export function RecruitmentPositions({ clean = false, candidateCounts, onOpenCandidates }: {
  clean?: boolean; candidateCounts?: Record<string, number>; onOpenCandidates?(positionKey: string): void;
} = {}) {
  const can = useCan(), actor = useAuthStore(s => s.agent?.id), epoch = useAuthStore(s => s.sessionEpoch);
  const query = useQuery({ queryKey: ["recruitment-positions", actor], enabled: can("vacancies.view"),
    queryFn: () => api<Catalog>("/vacancies/positions", { expectAgentId: actor }) });
  const [editing, setEditing] = useState<RecruitmentPosition | "new" | null>(null);
  const readOnly = useIsReadOnly();
  const manage = can("settings.manage") && !readOnly;
  const templates = useQuery({ queryKey: ["recruitment-templates", actor], enabled: manage,
    queryFn: () => api<{ items: Array<RecruitmentPositionInput & { key: string }> }>("/vacancies/positions/templates", { expectAgentId: actor }) });
  return <section className="grid gap-4" aria-label="Вакансии и условия">
    <CCard>
      <CHead title="Вакансии и условия" right={manage ? <Act clean={clean} primary onClick={() => setEditing("new")}>Добавить вакансию</Act> : undefined} />
      <p className="text-[15px] text-gray-500">Бот предлагает кандидатам открытые вакансии и рассказывает условия из этих карточек. Закрытие набора сохраняет все анкеты.</p>
      {readOnly && <p className="mt-2 text-[15px] text-gray-500">Доступен только просмотр вакансий.</p>}
      {manage && templates.data && <details className="vacancy-disclosure">
        <summary>Добавить из заготовки</summary>
        <div className="wrap" aria-label="Заготовки вакансий">{templates.data.items.filter(item => !query.data?.items.some(existing => existing.key === item.key)).map(item =>
          <Act clean={clean} key={item.key} onClick={() => setEditing({ ...item, revision: 0 })}>Заполнить: {item.titleRu}</Act>)}</div>
        <p className="text-[14px] text-gray-500">Заготовка не открывает набор: проверьте условия и сохраните карточку с включённым набором.</p>
      </details>}
    </CCard>
    {query.isError && <CCard role="alert"><div className="quiet warn"><span className="dot warn" /><span className="txt">Не удалось обновить вакансии.</span><Act clean={clean} onClick={() => void query.refetch()}>Повторить</Act></div></CCard>}
    {query.isPending ? <p className="quiet" role="status"><span className="dot" /><span className="txt">Загружаем вакансии…</span></p> : !query.data ? null : <>
      {!query.data.items.length && <CCard><p className="text-[15px] text-gray-500">{manage ? "Пока нет вакансий. Добавьте должность и откройте набор, чтобы бот мог её предложить." : "Пока нет вакансий."}</p></CCard>}
      <div className="grid gap-4 lg:grid-cols-2">{query.data.items.map(item => <CCard key={item.key}>
        <CHead title={item.titleRu} count={item.isOpen ? "Набор открыт" : "Набор закрыт"} right={manage ? <Act clean={clean} onClick={() => setEditing(item)}>Изменить</Act> : undefined} />
        <p className="text-[14px] text-gray-500">{item.titleTg}</p>
        {candidateCounts && (onOpenCandidates ? <button type="button" className="lnk" onClick={() => onOpenCandidates(item.key)}>Кандидатов: {candidateCounts[item.key] ?? 0}</button>
          : <p className="text-[14px] text-ink">Кандидатов: {candidateCounts[item.key] ?? 0}</p>)}
        <p className="vacancy-resume-text mt-2">{item.detailsRu || "Условия пока не указаны."}</p>
      </CCard>)}</div>
    </>}
    {manage && editing && <PositionForm key={`${actor}:${epoch}:${editing === "new" ? "new" : editing.key}`} clean={clean}
      initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    {manage && <RecruitmentRecovery key={`${actor}:${epoch}`} clean={clean} actor={actor} epoch={epoch} />}
  </section>;
}

type RecoveryItem = { conversationId: string; status: string; reason?: string; scheduledAt?: string; providerReceiptPresent?: boolean; visibleInConversation?: boolean };
function RecruitmentRecovery({ clean, actor, epoch }: { clean: boolean; actor?: string; epoch: number }) {
  const [campaign, setCampaign] = useState("");
  const [recipients, setRecipients] = useState("");
  const [error, setError] = useState("");
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const send = useMutation({ mutationFn: (body: unknown) => api<{ items: RecoveryItem[] }>("/vacancies/positions/recovery", {
    method: "POST", body, expectAgentId: actor }),
    onSuccess: value => { setItems(value.items); setError(""); }, onError: () => setError("Не удалось получить результат. Обновите статус кампании перед повторной отправкой.") });
  const status = useMutation({ mutationFn: () => api<{ items: RecoveryItem[] }>(`/vacancies/positions/recovery/${encodeURIComponent(campaign)}`, { expectAgentId: actor }),
    onSuccess: value => { setItems(value.items); setError(""); }, onError: () => setError("Не удалось обновить статус кампании.") });
  return <CCard><details className="vacancy-disclosure" key={`${actor}:${epoch}`}>
    <summary>Исправленные ответы кандидатам</summary>
    <p className="text-[14px] text-gray-500">Однократный ответ бота по проверенным откликам. Паузы сотрудника и ограничения канала сохраняются. Неизвестная доставка не повторяется.</p>
    <Field label="Название кампании"><input value={campaign} onChange={e => setCampaign(e.target.value)} /></Field>
    <Field label="Проверенный список откликов (JSON)"><textarea rows={5} value={recipients} onChange={e => setRecipients(e.target.value)} /></Field>
    {error && <p role="alert" className="quiet crit"><span className="dot crit" /><span className="txt">{error}</span></p>}
    <div className="wrap"><Act clean={clean} primary disabled={send.isPending || status.isPending} onClick={() => {
      try {
        const value = recruitmentRecoveryRequestSchema.safeParse({ campaign, recipients: JSON.parse(recipients) });
        if (!value.success) { setError("Проверьте название кампании и список откликов."); return; }
        send.mutate(value.data);
      } catch { setError("Список откликов должен быть корректным JSON."); }
    }}>Отправить исправленные ответы ботом</Act>
      <Act clean={clean} disabled={!/^[a-z0-9-]{8,64}$/.test(campaign) || status.isPending} onClick={() => status.mutate()}>Обновить статус кампании</Act></div>
    {!!items.length && <div role="status"><p>Проверено откликов: {items.length}. Отправка подтверждена: {items.filter(item => item.status === "ACCEPTED" && item.providerReceiptPresent).length}.</p>
      <ul>{items.map(item => <li key={item.conversationId}>{item.conversationId.slice(0, 8)}: {item.status}{item.status === "READY" && item.scheduledAt ? ` — ${dushanbeDateTime(item.scheduledAt)}` : ""}{item.reason ? ` (${item.reason})` : ""}</li>)}</ul></div>}
  </details></CCard>;
}

function PositionForm({ clean, initial, onClose }: { clean: boolean; initial: RecruitmentPosition | null; onClose(): void }) {
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
  const check = (checked: boolean, onChange: (checked: boolean) => void, label: ReactNode, k?: string) =>
    <label className="chk" key={k}><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>;
  return <CCard><form className="grid gap-4" aria-label={initial ? "Изменить вакансию" : "Новая вакансия"}
    onSubmit={event => { event.preventDefault(); setError(""); save.mutate(); }}>
    <CHead title={initial ? "Изменить вакансию" : "Новая вакансия"} className="mb-0" />
    <p className="text-[14px] text-gray-500">Только публичные условия. Телефоны кандидатов и внутренние заметки здесь не размещайте. Без указанной зарплаты бот её не называет.</p>
    <div className="grid gap-4 lg:grid-cols-2">
      <Field label="Название на русском"><input required maxLength={140} value={draft.titleRu} onChange={e => setDraft({ ...draft, titleRu: e.target.value })} /></Field>
      <Field label="Ном ба тоҷикӣ"><input required maxLength={140} value={draft.titleTg} onChange={e => setDraft({ ...draft, titleTg: e.target.value })} /></Field>
      <Field label="Условия на русском"><textarea rows={5} maxLength={2000} value={draft.detailsRu} onChange={e => setDraft({ ...draft, detailsRu: e.target.value })} /></Field>
      <Field label="Шартҳо ба тоҷикӣ"><textarea rows={5} maxLength={2000} value={draft.detailsTg} onChange={e => setDraft({ ...draft, detailsTg: e.target.value })} /></Field>
    </div>
    <fieldset className="grid gap-3">
      <legend className="text-[16px] font-semibold text-ink">Что выяснить у кандидата на эту должность</legend>
      <p className="text-[14px] text-gray-500">Правила действуют только для этой вакансии. Они подсказывают, что уточнить; решение о приглашении и найме принимает человек. Прежние решения и этапы кандидатов не меняются.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="Минимальный возраст (необязательно)"><input type="number" min={16} max={100}
          value={rules.minimumAge ?? ""} onChange={event => setRules({ ...rules, minimumAge: event.target.value === "" ? null : Number(event.target.value) })} /></Field>
        <div className="grid">
          {check(rules.allowStudying, value => setRules({ ...rules, allowStudying: value }), "Можно совмещать с учёбой")}
          {check(rules.allowOtherEmployment, value => setRules({ ...rules, allowOtherEmployment: value }), "Можно совмещать с другой работой")}
        </div>
      </div>
      <p className="text-[14px] text-gray-500">Нужные сведения. Отсутствие опыта не означает отказ; портфолио может заменить рассказ о себе.</p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(RECRUITMENT_FACT_LABELS) as RecruitmentFactKey[]).map(key => check(rules.requiredFacts.includes(key), value => setRules({ ...rules,
          requiredFacts: value ? [...rules.requiredFacts, key] : rules.requiredFacts.filter(item => item !== key) }), RECRUITMENT_FACT_LABELS[key], key))}
      </div>
    </fieldset>
    <details className="vacancy-disclosure">
      <summary>Где находить отклики</summary>
      <p className="text-[14px] text-gray-500">Публикации и ключевые слова помогают боту связать отклик с этой вакансией. Меняйте их при настройке новых объявлений.</p>
      <Field label="Публикации Instagram"><textarea rows={3} value={posts} onChange={e => setPosts(e.target.value)} placeholder="Ссылка или код, по одному в строке" /></Field>
      <Field label="Ключевые слова отклика"><textarea rows={2} value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="Например: контент. По одному слову в строке" /></Field>
    </details>
    {check(draft.isOpen, value => setDraft({ ...draft, isOpen: value }), <span>Набор открыт · <span className="text-gray-500">бот может предлагать эту вакансию кандидатам</span></span>)}
    {error && <p role="alert" className="quiet crit"><span className="dot crit" /><span className="txt">{error}</span></p>}
    <div className="wrap"><Act clean={clean} primary type="submit" disabled={save.isPending}>{save.isPending ? "Сохраняем…" : "Сохранить"}</Act>
      <Act clean={clean} disabled={save.isPending} onClick={onClose}>Отмена</Act></div>
  </form></CCard>;
}
