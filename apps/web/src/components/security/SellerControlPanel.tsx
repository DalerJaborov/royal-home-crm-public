import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isSellerControlRopRole, sellerControlConfigSchema, type SellerControlPage, type SellerControlPreviewPage, type SellerControlCommand } from "@royal-home/shared";
import { api } from "../../lib/api";
import { dushanbeDateTime } from "../../lib/date";
import { useAgents } from "../../hooks/useAgents";

const stageNames: Record<string, string> = { AGENT_TASK: "Работа агента", ROP_RECEIPT: "Ожидается получение руководителем",
  ROP_ACTION: "Работа руководителя", DIRECTOR: "Рассмотрение директором", RESOLVED: "Завершено", CANCELLED: "Прекращено" };
const eventNames: Record<string, string> = { STARTED: "Эпизод начат", AGENT_DEADLINE_ELAPSED: "Срок агента истёк",
  SOURCE_RESCHEDULED: "Новая дата приёма подтверждена разговором", CONTROL_PAUSED: "Срок приостановлен на время отсутствия", CONTROL_RESUMED: "Срок возобновлён",
  ROP_RECEIVED: "Получение отмечено", ROP_ACTION_RECORDED: "Действие руководителя записано",
  ROP_RECEIPT_NOT_RECORDED: "Получение в срок не отмечено", ROP_RESULT_NOT_CONFIRMED: "Результат в срок не подтверждён",
  RESOLVED_BY_MANAGER: "Закрыто руководителем", CANCELLED_BY_MANAGER: "Прекращено руководителем",
  INVENTORY_COMPLETE: "Объекты дополнены", ASSIGNMENT_ENDED: "Назначение завершено" };
type ConfigDraft = { days: string[]; buyerFollowup: string; defaultRop: string };
// Owner-approved starting proposal; not an executable or persisted configuration.
const starterDraft: ConfigDraft = { days: ["2", "1", "2"], buyerFollowup: "2", defaultRop: "" };
export function SellerControlPanel() {
  const queryClient = useQueryClient();
  const page = useQuery({ queryKey: ["seller-control-episodes"], queryFn: () => api<SellerControlPage>("/security/cases/seller-control") });
  const candidates = useQuery({ queryKey: ["seller-control-candidates"], queryFn: () => api<SellerControlPreviewPage>("/security/cases/seller-control-preview?page=1") });
  const agents = useAgents();
  const [configDraft, setConfigDraft] = useState<ConfigDraft | null>(null);
  const savedConfig = page.data?.config;
  // Refetches refresh untouched fields; an in-progress edit keeps all its values.
  const editor = configDraft ?? (savedConfig ? {
    days: [savedConfig?.agentDueWorkingDays, savedConfig?.ropReceiptDueWorkingDays, savedConfig?.ropActionDueWorkingDays].map(value => value == null ? "" : String(value)),
    buyerFollowup: savedConfig?.buyerCandidateFollowupWorkingDays == null ? "" : String(savedConfig.buyerCandidateFollowupWorkingDays),
    defaultRop: savedConfig?.defaultRopAgentId ?? "",
  } : starterDraft);
  const { days, buyerFollowup, defaultRop } = editor;
  const [clientId, setClientId] = useState("");
  const [ropAgentId, setRopAgentId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const mutation = useMutation({ retry: false, mutationFn: ({ path, body, method = "POST" }: { path: string; body: object; method?: string }) =>
    api(`/security/cases/seller-control${path}`, { method, body }),
  onSuccess: async (_data, variables) => {
    setError("");
    await queryClient.invalidateQueries({ queryKey: ["seller-control-episodes"] });
    if (variables.path === "/config") setConfigDraft(null);
  },
  onError: (cause: Error) => setError(cause.message) });
  const save = () => {
    const config = { agentDueWorkingDays: Number(days[0]), ropReceiptDueWorkingDays: Number(days[1]), ropActionDueWorkingDays: Number(days[2]),
      ...(buyerFollowup.trim() ? { buyerCandidateFollowupWorkingDays: Number(buyerFollowup) } : {}),
      ...(defaultRop ? { defaultRopAgentId: defaultRop } : {}) };
    if (!sellerControlConfigSchema.safeParse(config).success) { setError("Заполните все три срока положительными целыми числами"); return; }
    mutation.mutate({ path: "/config", method: "PUT", body: { config } });
  };
  const command = (id: string, revision: number, action: SellerControlCommand["action"]) => {
    if (["ACTION", "RESOLVE", "CANCEL"].includes(action) && note.trim().length < 3) { setError("Опишите действие или решение"); return; }
    mutation.mutate({ path: `/${id}/commands`, body: { action, revision, requestKey: crypto.randomUUID(), ...(note.trim() ? { note: note.trim() } : {}) } });
  };
  return <details className="card my-3"><summary>Контроль работы с продавцом — моделирование</summary>
    <p className="sub">Только для руководства. Моделирование не создаёт задачи сотрудникам и не отправляет сообщения. Отметки моделирования не станут реальными при последующем запуске.</p>
    {page.isPending ? <p>Загрузка…</p> : page.isError ? <p role="alert">Не удалось загрузить контроль</p> : <>
      <p>{page.data.config ? `Настроенные сроки: агент — ${page.data.config.agentDueWorkingDays}, получение руководителем — ${page.data.config.ropReceiptDueWorkingDays}, действие — ${page.data.config.ropActionDueWorkingDays} рабочих дней.` : "Стартовые сроки подготовлены, но не сохранены. Эпизоды не запускаются."}</p>
      <p className="sub">Стартовый набор: агент — 2 рабочих дня, подтверждение руководителем — 1, действия руководителя — 2. Все сроки можно изменить; сохранение не включает рабочее исполнение.</p>
      <div className="grid gap-3 sm:grid-cols-3">{["Срок агента", "Срок получения руководителем", "Срок действия руководителя"].map((title, index) =>
        <label key={title}>{title}<input className="w-full" type="number" min={1} max={365} value={days[index]} placeholder="Рабочих дней" onChange={e => setConfigDraft({ ...editor, days: days.map((value, i) => i === index ? e.target.value : value) })} /></label>)}</div>
      <label className="block my-3">Повторная проверка кандидата показа: рабочих дней после первых трёх дней ожидания (необязательно)
        <input className="w-full" type="number" min={1} max={365} value={buyerFollowup} placeholder="Не настроено" onChange={e => setConfigDraft({ ...editor, buyerFollowup: e.target.value })} /></label>
      <p className="sub">Текущее значение: {page.data.config?.buyerCandidateFollowupWorkingDays ?? "не настроено"}. Только предварительная закрытая оценка; задачи и сообщения не отправляются.</p>
      <label>Руководитель для будущих автоматических задач по показам (необязательно)<select className="w-full" value={defaultRop} onChange={e => setConfigDraft({ ...editor, defaultRop: e.target.value })}><option value="">Не выбран</option>{agents.data?.filter(a => a.isActive && isSellerControlRopRole(a.role)).map(a => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label>
      <p className="sub">Выбор руководителя не включает исполнение: необходим отдельный серверный допуск. Предварительные записи никогда не становятся рабочими автоматически.</p>
      <div className="flex flex-wrap gap-2 my-3"><button className="pill" disabled={mutation.isPending} onClick={save}>Сохранить сроки</button>
        <button type="button" className="pill ghost" disabled={mutation.isPending} onClick={() => setConfigDraft({ ...starterDraft, defaultRop: editor.defaultRop })}>Заполнить стартовые сроки</button>
        <button className="pill ghost" disabled={mutation.isPending} onClick={() => mutation.mutate({ path: "/config", method: "PUT", body: { config: {} } })}>Отключить настройку</button></div>
      <div className="grid gap-3 sm:grid-cols-2"><label>Текущая карточка<select className="w-full" value={clientId} onChange={e => setClientId(e.target.value)}><option value="">Выберите карточку</option>
        {candidates.data?.items.filter(item => item.state === "MISSING").map(item => <option key={item.id} value={item.id}>{item.name} · принято {item.accepted} из {item.expected}</option>)}</select></label>
        <label>Ответственный руководитель<select className="w-full" value={ropAgentId} onChange={e => setRopAgentId(e.target.value)}><option value="">Выберите руководителя</option>
          {agents.data?.filter(agent => agent.isActive && isSellerControlRopRole(agent.role)).map(agent => <option key={agent.id} value={agent.id}>{agent.fullName}</option>)}</select></label></div>
      <p className="sub">Первые 50 текущих карточек; черновики не считаются принятыми объектами. Недостоверное количество требует уточнения.</p>
      <button className="pill my-3" disabled={mutation.isPending || !page.data.config || !clientId || !ropAgentId} onClick={() => mutation.mutate({ path: "", body: { clientId, ropAgentId, requestKey: crypto.randomUUID() } })}>Начать моделирование</button>
      <label className="block">Комментарий к действию<textarea className="w-full" maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
      {!page.data.episodes.length && <p>Эпизодов пока нет.</p>}
      {page.data.episodes.map(episode => <article className="card my-3 min-w-0" key={episode.id}>
        <strong>{stageNames[episode.status] ?? "Неизвестное состояние"} · {episode.executionMode === "PREVIEW" ? "Моделирование" : "Рабочий эпизод"}</strong>
        <p><a href={`/clients/${episode.clientId}`}>Открыть карточку</a></p>
        <p className="sub">Срок: {episode.ropActionDueAt || episode.ropReceiptDueAt || episode.agentDueAt ? dushanbeDateTime((episode.ropActionDueAt || episode.ropReceiptDueAt || episode.agentDueAt)!) : "не назначен"}</p>
        {!["RESOLVED", "CANCELLED"].includes(episode.status) && <div className="flex flex-wrap gap-2">
          {episode.executionMode === "PREVIEW" && <button className="pill ghost" disabled={mutation.isPending} onClick={() => command(episode.id, episode.revision, "TICK")}>Проверить сроки и факты</button>}
          {episode.executionMode === "PREVIEW" && episode.status === "ROP_RECEIPT" && <button className="pill ghost" disabled={mutation.isPending} onClick={() => command(episode.id, episode.revision, "RECEIPT")}>Смоделировать получение</button>}
          {episode.executionMode === "PREVIEW" && episode.status === "ROP_ACTION" && <button className="pill ghost" disabled={mutation.isPending} onClick={() => command(episode.id, episode.revision, "ACTION")}>Смоделировать действие</button>}
          <button className="pill ghost" disabled={mutation.isPending} onClick={() => command(episode.id, episode.revision, "RESOLVE")}>{episode.executionMode === "PREVIEW" ? "Закрыть моделирование" : "Завершить контроль"}</button>
          <button className="pill ghost" disabled={mutation.isPending} onClick={() => command(episode.id, episode.revision, "CANCEL")}>Прекратить</button></div>}
        <ul>{episode.events.map(event => <li key={event.id}>{event.type.startsWith("SIMULATED_") ? "Моделирование: " : ""}{eventNames[event.type.replace(/^SIMULATED_/, "")] ?? "Состояние проверено"} · {dushanbeDateTime(event.occurredAt)}</li>)}</ul>
      </article>)}
    </>}{error && <p role="alert">{error}</p>}
  </details>;
}
