import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ClientWorkflowObservationView, ManualContactPreviewPage, NamedAssignmentPreviewPage } from "@royal-home/shared";
import { api } from "../../lib/api";
import { dushanbeDateTime } from "../../lib/date";

const kinds: Record<string, string> = { NAMED_ASSIGNMENT: "Объяснение назначения", NAMED_CLIENT_REQUEST: "Упоминание сотрудника",
  SHOWING_DELIVERY_CONTEXT: "Отправки объекта до записи показа", PROPERTY_DISPATCH: "Отправка подборки из CRM" };
const manualLabels: Record<string, string> = { MANUAL_ONLY_LOCAL_RECORDS: "В локальном журнале найдены только ручные звонки", ELECTRONIC_ACTIVITY_FOUND: "Найден электронный след", INSUFFICIENT_WINDOW: "Назначению меньше 30 дней", TRUNCATED_UNKNOWN: "Журнал требует отдельной проверки", NO_LOCAL_ACTIVITY: "В локальном журнале действий нет" };
const states: Record<string, string> = { DELIVERY_CONFIRMED: "Провайдер подтвердил доставку. Прочтение неизвестно.", PROVIDER_ACCEPTED: "Отправка принята провайдером. Доставка и прочтение не подтверждены.",
  AVAILABLE_TO_VIEW: "Опубликовано в виджете. Просмотр не подтверждён.", EXPOSURE_RECORDED: "Есть запись предложения объекта; это не квитанция доставки.",
  DELIVERY_UNCONFIRMED: "Подтверждение отправки не найдено. Полнота журнала неизвестна.", DISPATCH_ACCEPTED: "CRM получила успешный ответ отправки. Доставка на устройство и прочтение неизвестны." };
export function WorkflowObservationsPanel() {
  const counts = useQuery({ queryKey: ["workflow-agent-preview"], queryFn: () => api<{ manual: Array<{ subjectAgentId: string; agentName: string; eligibleLocalCards: number; reviewSuggested: boolean }>;
    showingContexts: Array<{ subjectAgentId: string; agentName: string; recordedUnconfirmedContexts: number; reviewSuggested: boolean; countCompleteness: string }> }>("/security/cases/workflow-agent-preview") });
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["workflow-observations"], queryFn: () => api<{ items: ClientWorkflowObservationView[] }>("/security/cases/workflow-observations") });
  const manual = useQuery({ queryKey: ["manual-contact-preview", page], queryFn: () => api<ManualContactPreviewPage>(`/security/cases/manual-contact-preview?page=${page}`) });
  const named = useQuery({ queryKey: ["named-assignment-preview"], queryFn: () => api<NamedAssignmentPreviewPage>("/security/cases/named-assignment-preview") });
  return <details className="card my-3"><summary>Источники назначения и отправок — предпросмотр</summary>
    <p className="sub">Последние 100 новых наблюдений. Обычная просьба о сотруднике и неполный журнал не означают нарушения. Эти записи не меняют владельца, баллы или уровень проверки и не отправляют уведомления.</p>
    {query.isPending ? <p>Загрузка…</p> : query.isError ? <p role="alert">Данные недоступны. <button onClick={() => void query.refetch()}>Повторить</button></p>
      : !query.data?.items.length ? <p>Новых наблюдений нет. Исторический добор отключён.</p>
      : <div className="grid gap-3">{query.data.items.map(row => <article key={row.id} className="card">
        <h3>{kinds[row.kind] ?? "Наблюдение"}</h3><a href={`/clients/${row.clientId}`}>Карточка клиента</a>
        <p>{dushanbeDateTime(row.occurredAt)} · {row.sourceType}</p>
        {typeof row.payload.state === "string" && <p>{states[row.payload.state] ?? "Требуется проверка исходных данных"}</p>}
        {row.payload.verification === "UNVERIFIED" && <p>Только объяснение назначения. Слова клиента не подтверждены источником.</p>}
        {row.payload.verification === "AUTHENTICATED_CUSTOMER_TEXT" && <p>Цитата из входящего сообщения клиента.</p>}
        {row.payload.verification === "RECORDED_TEXT_SPEAKER_UNVERIFIED" && <p>Имя найдено в записи разговора. Кто именно произнёс просьбу, отдельно не установлено.</p>}
        {typeof row.payload.quote === "string" && <blockquote className="whitespace-pre-wrap break-words">{row.payload.quote}</blockquote>}
        {row.payload.coverage === "UNKNOWN" && <p className="sub">Полнота каналов доставки неизвестна; отсутствие записи не доказывает, что объект не отправляли.</p>}
      </article>)}</div>}
    <h3>Повторяемость за 30 дней</h3>
    <p className="sub">Только локальные записи. Полнота каналов неизвестна; это не доказанные «карманные» показы и не вывод о нарушении.</p>
    {counts.isError ? <p role="alert">Сводка временно недоступна</p> : <>
      {counts.data?.manual.map(row => <p key={row.subjectAgentId}>{row.agentName}: {row.eligibleLocalCards} карточек с одними ручными звонками в журнале.{row.reviewSuggested ? " Более трёх: предлагается проверить исходные данные." : ""}</p>)}
      {counts.data?.showingContexts.map(row => <p key={row.subjectAgentId}>{row.agentName}: {row.recordedUnconfirmedContexts} контекстов показов без найденной записи отправки.{row.reviewSuggested ? " Два или больше: требуется ручная проверка полноты журнала." : ""}{row.countCompleteness === "TRUNCATED_LOWER_BOUND" ? " Это нижняя граница: выборка ограничена." : ""}</p>)}
    </>}
    <h3>Ручные записи за 30 дней</h3>
    <p className="sub">Проверяем доступные станционные и CRM-сообщения. Неполный журнал не доказывает работу вне CRM; уровни проверки автоматически не меняются.</p>
    {manual.isPending ? <p>Загрузка…</p> : manual.isError ? <p role="alert">Контактные данные временно недоступны. <button onClick={() => void manual.refetch()}>Повторить</button></p>
      : manual.data?.items.map(row => <p key={row.clientId}><a href={`/clients/${row.clientId}`}>Клиент</a> · {row.manualCalls} ручных записей · {manualLabels[row.evaluation] ?? "Требуется проверка"}</p>)}
    <div className="flex gap-2"><button disabled={page === 1} onClick={() => setPage(value => value - 1)}>Назад</button><span>{page}</span><button disabled={page * 25 >= (manual.data?.total ?? 0)} onClick={() => setPage(value => value + 1)}>Далее</button></div>
    <h3>Именные назначения</h3><p className="sub">Считаются новые фактические назначения после включения журнала. Сравниваются одинаковые пути назначения; нужны полный период и минимальная выборка из настроек проверки. Ручное объяснение не считается подтверждённой цитатой.</p>
    {named.isPending ? <p>Загрузка…</p> : named.isError ? <p role="alert">Сравнение недоступно. <button onClick={() => void named.refetch()}>Повторить</button></p>
      : !named.data?.groups.length ? <p>Для сравнения ещё нет полной выборки.</p>
      : named.data.groups.map(row => <p key={`${row.subjectAgentId}:${row.sourceCohort}`}>
        {row.agentName}: {row.allObservedAssignments} назначений · {row.namedDeclared} именных объяснений · {row.namedSourceConfirmed} подтверждено входящим текстом · {row.peerAssignments} назначений у коллег по тому же пути.
        {row.evaluation === "PRIVATE_REVIEW_PREVIEW" ? " Доля выше двойной доли коллег: предлагается ручная проверка источников, без решения о нарушении."
          : row.evaluation === "NO_RELATIVE_EXCESS" ? " Повышенной доли по этому критерию нет." : " Сравнение пока не выполнено: недостаточно периода, настроек или сопоставимых данных."}
      </p>)}
  </details>;
}
