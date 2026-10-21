import { useState } from "react";
import { CalendarDays, CircleAlert, Sparkles, UserRoundCheck } from "lucide-react";
import type { RecruitmentPosition } from "@royal-home/shared";
import { useSetVacancyStatus, type JobApplication } from "../hooks/useVacancies";
import { useVacancyContactOptions } from "../hooks/useVacancyContact";
import { useIsReadOnly } from "../lib/permissions";
import { CallClientButton } from "./CallClientButton";
import { MutationError } from "./MutationError";
import { ConfirmDialog } from "./ConfirmDialog";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { VacancyContactForm, DeliveryList, AssistantFindings } from "./VacancyContactForm";
import { candidateMissingFacts, candidateMissingText, candidateTitle, legacyCandidatePositionPatch } from "../lib/vacanciesResume";
import { canOverrideRejected, interviewInputToIso, interviewIsoToInput, vacancyInterviewLabel } from "../lib/vacanciesView";

export function VacancyStageActions({ item, positions, positionsLoading = false, positionsError = false, onPositionsRetry }: {
  item: JobApplication; positions?: RecruitmentPosition[]; positionsLoading?: boolean; positionsError?: boolean; onPositionsRetry?(): void;
}) {
  const mutation = useSetVacancyStatus();
  const readOnly = useIsReadOnly();
  const options = useVacancyContactOptions(item.id, !readOnly);
  const [mode, setMode] = useState<"INVITE" | "CLARIFY" | "schedule" | "note" | "reject" | null>(null);
  const [notCandidate, setNotCandidate] = useState(false);
  const [interviewAt, setInterviewAt] = useState("");
  const [note, setNote] = useState("");
  const [voice, setVoice] = useState<VoiceNote | null>(null);
  const [formError, setFormError] = useState("");
  const missing = candidateMissingFacts(item);
  const busy = mutation.isPending;
  const contact = options.data;
  const contactWaiting = contact?.recentDeliveries.some(delivery => ["QUEUED", "IN_FLIGHT", "UNKNOWN"].includes(delivery.status)) ?? false;
  const canContact = !!contact && (contact.sms.available || contact.assistantCall.available) && !contactWaiting;
  const terminal = item.status === "HIRED" || item.status === "REJECTED";
  const legacy = !item.customerInquiryId;
  const positionPicker = <LegacyPositionPicker item={item} positions={positions} loading={positionsLoading} error={positionsError}
    onRetry={onPositionsRetry} busy={busy} onSave={positionKey => { const patch = legacyCandidatePositionPatch(item, positionKey, positions ?? []); if (patch) mutation.mutate(patch); }} />;
  function openSchedule() {
    setInterviewAt(item.interviewAt ? interviewIsoToInput(item.interviewAt) : "");
    setFormError(""); setMode("schedule");
  }
  function closeForm() { setMode(null); setFormError(""); mutation.reset(); }
  if (readOnly) return <p className="vacancy-notice">Доступ только для просмотра. Действия выполняет руководитель с правом изменения.</p>;
  return <div className="vacancy-stage-actions">
    {legacy && !item.positionKey && <section className="vacancy-position-assignment"><h3>Укажите вакансию</h3><p>Выберите вакансию для этой анкеты, чтобы использовать её условия в приглашении.</p>{positionPicker}</section>}
    {missing.length > 0 ? <div className="vacancy-next-summary warning"><CircleAlert size={21} aria-hidden="true" /><div><strong>Нужно уточнить</strong><p>{candidateMissingText(item)}.</p><small>Отсутствие сведений не означает отказ.</small></div></div>
      : <div className="vacancy-next-summary"><UserRoundCheck size={21} aria-hidden="true" /><div><strong>Сведения собраны</strong><p>Посмотрите опыт и материалы. Решение о следующем шаге за вами.</p></div></div>}
    {item.status === "INTERVIEW" && item.interviewAt && <div className="vacancy-next-summary"><CalendarDays size={21} aria-hidden="true" /><div><strong>Собеседование назначено</strong><p>{vacancyInterviewLabel(item.interviewAt)}</p></div></div>}
    {contact && <AssistantFindings deliveries={contact.recentDeliveries} />}
    {options.isPending && <p className="vacancy-muted" role="status">Проверяем способы связи…</p>}
    {options.isError && <p className="vacancy-notice" role="alert">Не удалось проверить способы связи. <button type="button" className="vacancy-text-button" onClick={() => void options.refetch()}>Повторить</button></p>}
    {contactWaiting && <p className="vacancy-notice">Предыдущее обращение ещё в работе или его результат не подтверждён. Проверьте статус перед повторной отправкой. <button type="button" className="vacancy-text-button" onClick={() => void options.refetch()}>Проверить статус</button></p>}
    {!terminal && missing.length > 0 && <>
      <button type="button" className="vacancy-button secondary" disabled={busy || !canContact || !contact?.clarification.available} onClick={() => setMode("CLARIFY")}><Sparkles size={18} aria-hidden="true" />Уточнить анкету</button>
      <p className="vacancy-muted">{contact?.clarification.available ? "Звонок ассистента или SMS: только недостающие сведения." : contact?.clarification.reason || "Доступные способы уточнения появятся после проверки."}</p>
    </>}
    {!terminal && <>
      <button type="button" className="vacancy-button" disabled={busy || !canContact} onClick={() => setMode("INVITE")}>Пригласить на собеседование</button>
      <p className="vacancy-muted">Приглашение: SMS или звонок ассистента. Перед отправкой вы проверите текст и дату.</p>
      {contact && !contact.sms.available && !contact.assistantCall.available && <p className="vacancy-notice">{contact.sms.reason || contact.assistantCall.reason || "Нет доступного способа связи. Уточните телефон в анкете."}</p>}
    </>}
    <CallClientButton candidateId={item.id} phone={item.phone} variant="full" label="Позвонить самому" className="vacancy-button secondary" title="Звонок через телефонную станцию CRM" />
    {item.status === "NEW" && <button type="button" className="vacancy-text-button" disabled={busy} onClick={() => mutation.mutate({ id: item.id, status: "REVIEWED" })}>Взять в работу</button>}
    {item.status === "INTERVIEW" && <button type="button" className="vacancy-button secondary" disabled={busy} onClick={() => mutation.mutate({ id: item.id, status: "INTERVIEWED" })}>Собеседование провели</button>}
    {item.status === "INTERVIEWED" && <button type="button" className="vacancy-button" disabled={busy} onClick={() => mutation.mutate({ id: item.id, status: "HIRED" })}>Принять на работу</button>}
    {terminal && <button type="button" className="vacancy-button secondary" disabled={busy} onClick={() => mutation.mutate({ id: item.id, status: "REVIEWED" })}>{item.status === "REJECTED" ? "Отменить отказ" : "Вернуть в работу"}</button>}
    <details className="vacancy-more-actions"><summary>Другие действия</summary>
      {legacy && item.positionKey && <div className="vacancy-assigned-position"><p className="vacancy-muted">Вакансия: <strong>{item.positionTitle || "Название не загружено"}</strong></p><details><summary>Изменить вакансию</summary>{positionPicker}</details></div>}
      {!terminal && <button type="button" className="vacancy-text-button" disabled={busy} onClick={openSchedule}>{item.interviewAt ? "Изменить дату без отправки" : "Только сохранить дату встречи"}</button>}
      <button type="button" className="vacancy-text-button" disabled={busy} onClick={() => { setNote(item.interviewNote || ""); setMode("note"); }}>Заметка руководителя</button>
      {item.status === "REJECTED" ? <>
        <label className="vacancy-checkbox"><input type="checkbox" checked={item.talentPool} disabled={busy} onChange={event => mutation.mutate({ id: item.id, talentPool: event.target.checked })} />Кадровый резерв</label>
        <button type="button" className="vacancy-text-button" disabled={busy} onClick={() => { setNote(item.rejectionReason || ""); setVoice(null); setMode("reject"); }}>{item.rejectionReason ? "Изменить причину отказа" : "Добавить причину отказа"}</button>
      </> : item.status !== "HIRED" && <button type="button" className="vacancy-text-button danger" disabled={busy} onClick={() => mutation.mutate({ id: item.id, status: "REJECTED" })}>Отказать · без отправки сообщения</button>}
      {!item.customerInquiryId && item.eligible === false && !item.eligibleOverride && canOverrideRejected(item) && <button type="button" className="vacancy-text-button" disabled={busy} onClick={() => mutation.mutate({ id: item.id, status: "REVIEWED", eligibleOverride: true })}>Взять в работу вопреки прежней проверке</button>}
      <button type="button" className="vacancy-text-button danger" disabled={busy} onClick={() => setNotCandidate(true)}>Это не кандидат на работу</button>
    </details>
    <MutationError mutation={mutation} fallback="Не удалось сохранить изменение" />
    {!!contact?.recentDeliveries.length && <section className="vacancy-recent-contact"><h3>Связь с кандидатом</h3><DeliveryList deliveries={contact.recentDeliveries} /></section>}
    {mode && (mode === "INVITE" || mode === "CLARIFY") && contact && <VacancyContactForm key={`${item.id}:${mode}`} item={item} options={contact} purpose={mode} onClose={closeForm} />}
    {mode && ["schedule", "note", "reject"].includes(mode) && <Rh2Sheet title={mode === "schedule" ? "Дата собеседования" : mode === "reject" ? "Причина отказа" : "Заметка руководителя"} onClose={closeForm} dismissible={!busy} closeOnBackdrop={false} className="vacancy-contact-sheet"
      onSubmit={event => { event.preventDefault();
        if (mode === "schedule") {
          const iso = interviewInputToIso(interviewAt);
          if (!iso || new Date(iso).getTime() <= Date.now()) { setFormError("Выберите будущую дату и время."); return; }
          mutation.mutate({ id: item.id, status: "INTERVIEW", interviewAt: iso }, { onSuccess: closeForm });
        } else mutation.mutate({ id: item.id, ...(mode === "note" ? { interviewNote: note.trim() || null } : { rejectionReason: note.trim() || null,
          ...(voice ? { rejectionReasonVoiceUrl: voice.url, rejectionReasonVoiceTranscript: voice.transcript } : {}) }) }, { onSuccess: closeForm });
      }} footer={<div className="vacancy-contact-scope vacancy-form-buttons"><button type="button" className="vacancy-button secondary" disabled={busy} onClick={closeForm}>Отмена</button><button type="submit" className="vacancy-button" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button></div>}>
      <div className="vacancy-contact-scope">{mode === "schedule" ? <><label className="vacancy-field"><span>Дата и время собеседования</span><input type="datetime-local" value={interviewAt} min={interviewIsoToInput(new Date())} required onChange={event => setInterviewAt(event.target.value)} /><small>Время Душанбе, UTC+5</small></label><p className="vacancy-notice">Сохранится только дата в CRM. Кандидат не получит SMS или звонок.</p></>
        : <><label className="vacancy-field"><span>{mode === "reject" ? "Причина отказа" : "Внутренняя заметка"}</span><textarea rows={5} value={note} maxLength={4000} onChange={event => setNote(event.target.value)} /></label><p className="vacancy-muted">Видно только сотрудникам. Кандидату не отправляется.</p>{mode === "reject" && <VoiceNoteButton uploadUrl="/me/voice-notes" value={voice} onChange={setVoice} />}</>}
        {formError && <p className="vacancy-form-error" role="alert">{formError}</p>}<MutationError mutation={mutation} fallback="Не удалось сохранить" />
      </div>
    </Rh2Sheet>}
    {notCandidate && <ConfirmDialog title="Это не кандидат на работу?" description={`Анкета «${candidateTitle(item)}» будет скрыта из подбора. Используйте это только для ошибочных откликов продавцов или покупателей. Обычный отказ оформляйте через «Отказать».`} confirmLabel="Скрыть из кандидатов" onCancel={() => setNotCandidate(false)} confirmDisabled={busy} dismissible={!busy} onConfirm={() => mutation.mutate({ id: item.id, status: "NOT_CANDIDATE" }, { onSuccess: () => setNotCandidate(false) })}><MutationError mutation={mutation} fallback="Не удалось скрыть анкету" /></ConfirmDialog>}
  </div>;
}

function LegacyPositionPicker({ item, positions, loading, error, onRetry, busy, onSave }: {
  item: JobApplication; positions?: RecruitmentPosition[]; loading: boolean; error: boolean; onRetry?: () => void;
  busy: boolean; onSave(positionKey: string): void;
}) {
  const [positionKey, setPositionKey] = useState(item.positionKey || "");
  if (loading) return <p className="vacancy-muted" role="status">Загружаем вакансии…</p>;
  if (error) return <p className="vacancy-notice" role="alert">Список вакансий не загрузился. {onRetry && <button type="button" className="vacancy-text-button" onClick={onRetry}>Повторить</button>}</p>;
  if (!positions?.length) return <p className="vacancy-muted">Нет доступных вакансий для выбора. Добавьте вакансию на соседней вкладке.</p>;
  const valid = positions.some(position => position.key === positionKey);
  return <form className="vacancy-position-form" onSubmit={event => { event.preventDefault(); if (valid && positionKey !== item.positionKey && !busy) onSave(positionKey); }}>
    <label className="vacancy-field"><span>Вакансия</span><select value={positionKey} required disabled={busy} onChange={event => setPositionKey(event.target.value)}>
      <option value="">Выберите вакансию</option>{positions.map(position => <option key={position.key} value={position.key}>{position.titleRu}{position.isOpen ? "" : " · набор закрыт"}</option>)}
    </select></label>
    <button type="submit" className="vacancy-button secondary" disabled={busy || !valid || positionKey === item.positionKey}>{busy ? "Сохраняем…" : "Сохранить вакансию"}</button>
  </form>;
}
