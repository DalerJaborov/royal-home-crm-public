import { useState, type ReactNode } from "react";
import { Archive, Ban, CalendarDays, FileText, MoreHorizontal, NotebookPen, Phone, RotateCcw, Sparkles, Trash2, UserRoundCheck, UserX } from "lucide-react";
import { RECRUITMENT_NOTE_MAX_LENGTH, RECRUITMENT_REJECTION_REASON_MAX_LENGTH, type RecruitmentPosition } from "@royal-home/shared";
import { useSetVacancyStatus, type JobApplication } from "../hooks/useVacancies";
import { useVacancyContactOptions } from "../hooks/useVacancyContact";
import { useIsReadOnly } from "../lib/permissions";
import { MutationError } from "./MutationError";
import { ConfirmDialog } from "./ConfirmDialog";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { CallClientButton } from "./CallClientButton";
import { ClientMoreMenu, type MoreGroup } from "./ClientMoreMenu";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";
import { VacancyContactForm } from "./VacancyContactForm";
import { candidateMissingFacts, candidateMissingText, candidateTitle, legacyCandidatePositionPatch } from "../lib/vacanciesResume";
import { canOverrideRejected, interviewInputToIso, interviewIsoToInput, vacancyInterviewLabel } from "../lib/vacanciesView";
import { candidateStaffTextError } from "../lib/vacancyQueue";

type Mode = "INVITE" | "CLARIFY" | "schedule" | "note" | "reject" | "phone" | "position";

/** Что вызвать из меню «Ещё» — экран передаёт, меню только собирает пункты. */
export interface VacancyMoreHandlers {
  open(mode: Exclude<Mode, "INVITE">): void;
  setStatus(patch: { status?: JobApplication["status"]; eligibleOverride?: boolean; talentPool?: boolean }): void;
  notCandidate(): void;
  delete?(): void;
}

/**
 * Пункты меню «Ещё» карточки кандидата — чистая сборка, без состояния: что
 * доступно, решает этап анкеты; права на удаление передаёт экран (`delete`).
 */
export function vacancyMoreGroups(item: JobApplication, ctx: { canClarify: boolean; clarifyHint?: string; busy: boolean }, on: VacancyMoreHandlers): MoreGroup[] {
  const terminal = item.status === "HIRED" || item.status === "REJECTED";
  const legacy = !item.customerInquiryId;
  const missing = candidateMissingFacts(item).length > 0;
  const work: MoreGroup["items"] = [];
  if (!terminal && missing) work.push({ key: "clarify", label: "Уточнить анкету", icon: Sparkles, onSelect: () => on.open("CLARIFY"), disabled: ctx.busy || !ctx.canClarify,
    hint: ctx.clarifyHint || "Звонок ассистента или SMS: только недостающие сведения" });
  if (!terminal) work.push({ key: "schedule", label: item.interviewAt ? "Изменить дату без отправки" : "Только сохранить дату встречи", icon: CalendarDays, onSelect: () => on.open("schedule"), disabled: ctx.busy,
    hint: "Кандидат не получит SMS или звонок" });
  work.push({ key: "note", label: "Заметка руководителя", icon: NotebookPen, onSelect: () => on.open("note"), disabled: ctx.busy });
  const stage: MoreGroup["items"] = [];
  if (item.status === "NEW") stage.push({ key: "review", label: "Взять в работу", icon: UserRoundCheck, onSelect: () => on.setStatus({ status: "REVIEWED" }), disabled: ctx.busy });
  if (item.status === "REJECTED") {
    stage.push({ key: "pool", label: "Кадровый резерв", icon: Archive, value: item.talentPool ? "Да" : "Нет", onSelect: () => on.setStatus({ talentPool: !item.talentPool }), disabled: ctx.busy });
    stage.push({ key: "reason", label: item.rejectionReason ? "Изменить причину отказа" : "Добавить причину отказа", icon: NotebookPen, onSelect: () => on.open("reject"), disabled: ctx.busy });
  } else if (item.status !== "HIRED") stage.push({ key: "reject", label: "Отказать · без отправки сообщения", icon: Ban, tone: "danger", onSelect: () => on.setStatus({ status: "REJECTED" }), disabled: ctx.busy });
  if (terminal) stage.push({ key: "back", label: item.status === "REJECTED" ? "Отменить отказ" : "Вернуть в работу", icon: RotateCcw, onSelect: () => on.setStatus({ status: "REVIEWED" }), disabled: ctx.busy });
  if (legacy && item.eligible === false && !item.eligibleOverride && canOverrideRejected(item)) stage.push({ key: "override", label: "Взять в работу вопреки прежней проверке", icon: UserRoundCheck,
    onSelect: () => on.setStatus({ status: "REVIEWED", eligibleOverride: true }), disabled: ctx.busy });
  const record: MoreGroup["items"] = [];
  if (legacy && item.positionKey) record.push({ key: "position", label: "Изменить вакансию", icon: FileText, value: item.positionTitle || undefined, onSelect: () => on.open("position"), disabled: ctx.busy });
  record.push({ key: "phone", label: item.phone ? "Изменить телефон" : "Добавить телефон", icon: Phone, value: item.phone || undefined, onSelect: () => on.open("phone"), disabled: ctx.busy });
  record.push({ key: "not-candidate", label: "Это не кандидат на работу", icon: UserX, tone: "danger", onSelect: on.notCandidate, disabled: ctx.busy });
  if (on.delete) record.push({ key: "delete", label: "Удалить анкету навсегда", icon: Trash2, tone: "danger", onSelect: on.delete, disabled: ctx.busy });
  return [{ key: "work", items: work }, { key: "stage", title: "Этап", items: stage }, { key: "record", title: "Анкета", items: record }];
}

/**
 * Действия карточки кандидата: ряд `.acts` в шапке (Позвонить, Пригласить,
 * следующий шаг этапа, слот экрана для «Распечатать», «Ещё») и всё остальное —
 * в шторке «Ещё». Формы — шторками Rh2Sheet, ничего не раскрывается в строке.
 */
export function VacancyStageActions({ item, positions, positionsLoading = false, positionsError = false, onPositionsRetry, onDelete, children }: {
  item: JobApplication; positions?: RecruitmentPosition[]; positionsLoading?: boolean; positionsError?: boolean; onPositionsRetry?(): void;
  /** «Удалить навсегда» — экран передаёт только админу/директору. */
  onDelete?(): void;
  /** Кнопки экрана в том же ряду (Распечатать) — видны и в режиме просмотра. */
  children?: ReactNode;
}) {
  const mutation = useSetVacancyStatus();
  const readOnly = useIsReadOnly();
  const options = useVacancyContactOptions(item.id, !readOnly);
  const [mode, setMode] = useState<Mode | null>(null);
  const [more, setMore] = useState(false);
  const [notCandidate, setNotCandidate] = useState(false);
  const [interviewAt, setInterviewAt] = useState("");
  const [note, setNote] = useState("");
  const [phone, setPhone] = useState("");
  const [voice, setVoice] = useState<VoiceNote | null>(null);
  const [formError, setFormError] = useState("");
  const missing = candidateMissingFacts(item);
  const busy = mutation.isPending;
  const contact = options.data;
  const contactWaiting = contact?.recentDeliveries.some(delivery => ["QUEUED", "IN_FLIGHT", "UNKNOWN"].includes(delivery.status)) ?? false;
  const canContact = !!contact && (contact.sms.available || contact.assistantCall.available) && !contactWaiting;
  const terminal = item.status === "HIRED" || item.status === "REJECTED";
  const legacy = !item.customerInquiryId;
  const savePosition = (positionKey: string) => { const patch = legacyCandidatePositionPatch(item, positionKey, positions ?? []); if (patch) mutation.mutate(patch, { onSuccess: closeForm }); };
  const positionPicker = <LegacyPositionPicker item={item} positions={positions} loading={positionsLoading} error={positionsError}
    onRetry={onPositionsRetry} busy={busy} onSave={savePosition} />;
  function open(next: Exclude<Mode, "INVITE">) {
    setMore(false); setFormError(""); mutation.reset();
    if (next === "schedule") setInterviewAt(item.interviewAt ? interviewIsoToInput(item.interviewAt) : "");
    if (next === "note") setNote(item.interviewNote || "");
    if (next === "reject") { setNote(item.rejectionReason || ""); setVoice(null); }
    if (next === "phone") setPhone(item.phone ?? "");
    setMode(next);
  }
  function closeForm() { setMode(null); setFormError(""); mutation.reset(); }
  const advance = item.status === "NEW" ? { label: "Взять в работу", status: "REVIEWED" as const }
    : item.status === "INTERVIEW" ? { label: "Собеседование провели", status: "INTERVIEWED" as const }
      : item.status === "INTERVIEWED" ? { label: "Принять на работу", status: "HIRED" as const }
        : terminal ? { label: item.status === "REJECTED" ? "Отменить отказ" : "Вернуть в работу", status: "REVIEWED" as const } : null;
  const actsStyle = { display: "flex", flexWrap: "wrap", gap: 10 } as const;

  if (readOnly) return <div style={{ gridColumn: "1 / -1", display: "grid", gap: 12 }}>
    {children && <div className="acts" style={actsStyle}>{children}</div>}
    <p className="quiet"><span className="dot" /><span className="txt">Доступ только для просмотра. Действия выполняет руководитель с правом изменения.</span></p>
  </div>;
  const groups = vacancyMoreGroups(item, { canClarify: canContact && !!contact?.clarification.available, clarifyHint: contact?.clarification.available ? undefined : contact?.clarification.reason, busy },
    { open, setStatus: patch => { setMore(false); mutation.mutate({ id: item.id, ...patch }); }, notCandidate: () => { setMore(false); setNotCandidate(true); },
      delete: onDelete ? () => { setMore(false); onDelete(); } : undefined });
  return <div style={{ gridColumn: "1 / -1", display: "grid", gap: 12 }}>
    <div className="acts" style={actsStyle}>
      <CallClientButton candidateId={item.id} phone={item.phone} variant="full" label="Позвонить" className="pill ghost" title="Звонок через телефонную станцию CRM" />
      {!terminal && <button type="button" id="candidate-invite-button" className="pill" disabled={busy || !canContact} onClick={() => setMode("INVITE")}>Пригласить на собеседование</button>}
      {advance && <button type="button" className="pill ghost" disabled={busy} onClick={() => mutation.mutate({ id: item.id, status: advance.status })}>{advance.label}</button>}
      {children}
      <button type="button" className="pill ghost" aria-haspopup="dialog" onClick={() => setMore(true)}><MoreHorizontal className="i" aria-hidden="true" />Ещё</button>
    </div>
    {legacy && !item.positionKey && <div className="quiet warn" style={{ flexWrap: "wrap" }}><span className="dot warn" /><span className="txt"><b>Укажите вакансию.</b> Её условия войдут в приглашение.</span>{positionPicker}</div>}
    {missing.length > 0 && <p className="quiet warn"><span className="dot warn" /><span className="txt">Нужно уточнить: {candidateMissingText(item)}. Отсутствие сведений не означает отказ.</span></p>}
    {item.status === "INTERVIEW" && item.interviewAt && <p className="quiet"><span className="dot ok" /><span className="txt">Собеседование назначено: {vacancyInterviewLabel(item.interviewAt)}</span></p>}
    {options.isPending && <p className="quiet" role="status"><span className="dot" /><span className="txt">Проверяем способы связи…</span></p>}
    {options.isError && <div className="quiet warn" role="alert"><span className="dot warn" /><span className="txt">Не удалось проверить способы связи.</span><button type="button" className="lnk" onClick={() => void options.refetch()}>Повторить</button></div>}
    {contactWaiting && <div className="quiet warn"><span className="dot warn" /><span className="txt">Предыдущее обращение ещё в работе или его результат не подтверждён. Проверьте статус перед повторной отправкой.</span><button type="button" className="lnk" onClick={() => void options.refetch()}>Проверить статус</button></div>}
    {!terminal && contact && !contact.sms.available && !contact.assistantCall.available && <p className="quiet warn"><span className="dot warn" /><span className="txt">{contact.sms.reason || contact.assistantCall.reason || "Нет доступного способа связи. Уточните телефон в анкете."}</span></p>}
    <MutationError mutation={mutation} fallback="Не удалось сохранить изменение" />

    {more && <Rh2Sheet title="Ещё" onClose={() => setMore(false)}><ClientMoreMenu groups={groups} /></Rh2Sheet>}
    {mode && (mode === "INVITE" || mode === "CLARIFY") && contact && <VacancyContactForm key={`${item.id}:${mode}`} item={item} options={contact} purpose={mode} onClose={closeForm} />}
    {mode === "position" && <Rh2Sheet title="Вакансия кандидата" onClose={closeForm} dismissible={!busy} closeOnBackdrop={false}>{positionPicker}<MutationError mutation={mutation} fallback="Не удалось сохранить вакансию" /></Rh2Sheet>}
    {mode && ["schedule", "note", "reject", "phone"].includes(mode) && <Rh2Sheet title={mode === "schedule" ? "Дата собеседования" : mode === "reject" ? "Причина отказа" : mode === "phone" ? "Телефон кандидата" : "Заметка руководителя"} onClose={closeForm} dismissible={!busy} closeOnBackdrop={false}
      onSubmit={event => { event.preventDefault(); setFormError("");
        if (mode === "schedule") {
          const iso = interviewInputToIso(interviewAt);
          if (!iso || new Date(iso).getTime() <= Date.now()) { setFormError("Выберите будущую дату и время."); return; }
          mutation.mutate({ id: item.id, status: "INTERVIEW", interviewAt: iso }, { onSuccess: closeForm });
        } else if (mode === "phone") mutation.mutate({ id: item.id, phone: phone.trim() || null }, { onSuccess: closeForm });
        else {
          const noteError = candidateStaffTextError(note, mode === "note" ? "note" : "reject");
          if (noteError) { setFormError(noteError); return; }
          mutation.mutate({ id: item.id, ...(mode === "note" ? { interviewNote: note.trim() || null } : { rejectionReason: note.trim() || null,
            ...(voice ? { rejectionReasonVoiceUrl: voice.url, rejectionReasonVoiceTranscript: voice.transcript } : {}) }) }, { onSuccess: closeForm });
        }
      }} footer={<><button type="button" className="pill ghost" disabled={busy} onClick={closeForm}>Отмена</button><button type="submit" className="pill" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button></>}>
      {mode === "schedule" ? <><label className="fld"><span className="lab">Дата и время собеседования</span><input type="datetime-local" value={interviewAt} min={interviewIsoToInput(new Date())} required onChange={event => setInterviewAt(event.target.value)} /><span className="msg">Время Душанбе, UTC+5</span></label>
        <p className="quiet warn"><span className="dot warn" /><span className="txt">Сохранится только дата в CRM. Кандидат не получит SMS или звонок.</span></p></>
        : mode === "phone" ? <label className="fld"><span className="lab">Телефон кандидата</span><input type="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} maxLength={40} /></label>
          : <><label className="fld"><span className="lab">{mode === "reject" ? "Причина отказа" : "Внутренняя заметка"}</span><textarea rows={5} value={note} maxLength={mode === "reject" ? RECRUITMENT_REJECTION_REASON_MAX_LENGTH : RECRUITMENT_NOTE_MAX_LENGTH} onChange={event => setNote(event.target.value)} /><span className="msg">Видно только сотрудникам. Кандидату не отправляется. До {mode === "reject" ? RECRUITMENT_REJECTION_REASON_MAX_LENGTH : RECRUITMENT_NOTE_MAX_LENGTH} символов.</span></label>
            {mode === "reject" && <VoiceNoteButton uploadUrl="/me/voice-notes" value={voice} onChange={setVoice} />}</>}
      {formError && <p className="quiet crit" role="alert"><span className="dot crit" /><span className="txt">{formError}</span></p>}<MutationError mutation={mutation} fallback="Не удалось сохранить" />
    </Rh2Sheet>}
    {notCandidate && <ConfirmDialog title="Это не кандидат на работу?" description={`Анкета «${candidateTitle(item)}» будет скрыта из подбора. Используйте это только для ошибочных откликов продавцов или покупателей. Обычный отказ оформляйте через «Отказать».`} confirmLabel="Скрыть из кандидатов" onCancel={() => setNotCandidate(false)} confirmDisabled={busy} dismissible={!busy} onConfirm={() => mutation.mutate({ id: item.id, status: "NOT_CANDIDATE" }, { onSuccess: () => setNotCandidate(false) })}><MutationError mutation={mutation} fallback="Не удалось скрыть анкету" /></ConfirmDialog>}
  </div>;
}

function LegacyPositionPicker({ item, positions, loading, error, onRetry, busy, onSave }: {
  item: JobApplication; positions?: RecruitmentPosition[]; loading: boolean; error: boolean; onRetry?: () => void;
  busy: boolean; onSave(positionKey: string): void;
}) {
  const [positionKey, setPositionKey] = useState(item.positionKey || "");
  if (loading) return <p className="quiet" role="status"><span className="dot" /><span className="txt">Загружаем вакансии…</span></p>;
  if (error) return <p className="quiet warn" role="alert"><span className="dot warn" /><span className="txt">Список вакансий не загрузился.</span>{onRetry && <button type="button" className="lnk" onClick={onRetry}>Повторить</button>}</p>;
  if (!positions?.length) return <p className="quiet"><span className="dot" /><span className="txt">Нет доступных вакансий для выбора. Добавьте вакансию на вкладке «Вакансии».</span></p>;
  const valid = positions.some(position => position.key === positionKey);
  return <form className="wrap" onSubmit={event => { event.preventDefault(); if (valid && positionKey !== item.positionKey && !busy) onSave(positionKey); }}>
    <label className="fld" style={{ flex: "1 1 220px" }}><span className="lab">Вакансия</span><select value={positionKey} required disabled={busy} onChange={event => setPositionKey(event.target.value)}>
      <option value="">Выберите вакансию</option>{positions.map(position => <option key={position.key} value={position.key}>{position.titleRu}{position.isOpen ? "" : " · набор закрыт"}</option>)}
    </select></label>
    <button type="submit" className="pill ghost sm" disabled={busy || !valid || positionKey === item.positionKey}>{busy ? "Сохраняем…" : "Сохранить вакансию"}</button>
  </form>;
}
