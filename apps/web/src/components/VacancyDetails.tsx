import { useState, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, FileText, MapPin, MessageCircle, MoreHorizontal, Phone, Printer, Trash2 } from "lucide-react";
import { RECRUITMENT_FACT_LABELS, type RecruitmentResumeFacts } from "@royal-home/shared";
import { useInviteCallRecordingUrl, useSetVacancyStatus, useVacancyConversation, type JobApplication } from "../hooks/useVacancies";
import { MessageAttachments } from "./MessageAttachments";
import { MutationError } from "./MutationError";
import { CallClientButton } from "./CallClientButton";
import { VacancyPriority } from "./VacancyRow";
import { VoiceNotePlayer } from "./VoiceNotePlayer";
import { api } from "../lib/api";
import { browserDeps, openPrivateFile } from "../lib/openPrivateFile";
import { useIsReadOnly } from "../lib/permissions";
import { candidateResumeFacts, candidateTitle, candidateStudyState, CANDIDATE_STAGE_LABELS } from "../lib/vacanciesResume";
import { vacancyChatLanguageText, vacancyChannelLabel, vacancyFilterReason, vacancyInterviewLabel, vacancyReceivedLabel } from "../lib/vacanciesView";

/** Open the original through the vacancy's authorized file endpoint. */
export function VacancyFileButton({ applicationId, file, portfolioIndex, label }: {
  applicationId: string; file: string; portfolioIndex?: number; label?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  function open() {
    setState("loading");
    const endpoint = portfolioIndex === undefined ? `/vacancies/${encodeURIComponent(applicationId)}/cv`
      : `/vacancies/${encodeURIComponent(applicationId)}/portfolio/${portfolioIndex}`;
    const load = () => api<Blob>(endpoint, { responseType: "blob" });
    // Synchronous window creation before download also works on iOS.
    void openPrivateFile(file, browserDeps(load)).then(ok => setState(ok ? "idle" : "error"));
  }
  return <button type="button" className="vacancy-file-button" onClick={open} disabled={state === "loading"}>
    <FileText size={19} aria-hidden="true" /><span>{state === "loading" ? "Открываем…" : state === "error" ? "Не открылось — повторить" : label || "Открыть оригинал резюме"}</span>
    <ExternalLink size={15} aria-hidden="true" />
  </button>;
}

export function VacancyOriginals({ item }: { item: JobApplication }) {
  const saved = !!item.cvFile || !!item.customerPortfolio?.length;
  return <section className="vacancy-originals" aria-label="Оригиналы материалов">
    <div className="vacancy-originals-heading">{saved ? <CheckCircle2 size={21} aria-hidden="true" /> : <FileText size={21} aria-hidden="true" />}<strong>{saved ? "Материалы сохранены" : "Оригиналы материалов"}</strong></div>
    <p>{saved ? "Проверьте сведения по тому, что прислал кандидат." : "Файл резюме пока не прикреплён. Текст отклика доступен в анкете."}</p>
    {item.cvFile && <VacancyFileButton applicationId={item.id} file={item.cvFile} />}
    {!!item.customerPortfolio?.length && <p>Работ в портфолио: {item.customerPortfolio.length}. Они доступны в разделе «Работы кандидата».</p>}
  </section>;
}

function ResumeSection({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`vacancy-resume-section ${className}`}><h3>{title}</h3>{children}</section>;
}

function FactText({ value, fact }: { value?: string | null; fact?: RecruitmentResumeFacts[keyof RecruitmentResumeFacts] }) {
  return <>{value ? <p className="vacancy-resume-text">{value}</p> : <p className="vacancy-missing">Не указано</p>}
    {fact && <details className="vacancy-fact-source"><summary>Слова кандидата</summary><blockquote>{fact.quote}</blockquote></details>}
  </>;
}

function PhoneField({ item }: { item: JobApplication }) {
  const readOnly = useIsReadOnly();
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(item.phone ?? "");
  const mutation = useSetVacancyStatus();
  if (!editing) return <div className="vacancy-phone-field"><span>{item.phone || "Телефон не указан"}</span>{!readOnly && <button type="button" className="vacancy-text-button" onClick={() => { setDraft(item.phone ?? ""); setEditing(true); }}>{item.phone ? "Изменить" : "Добавить"}</button>}</div>;
  return <form className="vacancy-phone-editor" onSubmit={event => { event.preventDefault(); mutation.mutate({ id: item.id, phone: draft.trim() || null }, { onSuccess: () => setEditing(false) }); }}>
    <label className="vacancy-field"><span>Телефон кандидата</span><input type="tel" autoComplete="tel" value={draft} onChange={event => setDraft(event.target.value)} maxLength={40} /></label>
    <div className="vacancy-form-buttons"><button className="vacancy-button" disabled={mutation.isPending} type="submit">Сохранить</button><button className="vacancy-button secondary" disabled={mutation.isPending} type="button" onClick={() => setEditing(false)}>Отмена</button></div>
    <MutationError mutation={mutation} fallback="Не удалось сохранить телефон" />
  </form>;
}

export function VacancyDetails({ item, onPrint, onDelete }: {
  item: JobApplication;
  /** Печать этой анкеты (экран собирает лист печати сам). */
  onPrint?(): void;
  /** «Удалить навсегда» — передаётся только админу/директору. */
  onDelete?(): void;
}) {
  const readOnly = useIsReadOnly();
  const [showChat, setShowChat] = useState(false);
  const conversation = useVacancyConversation(item.id);
  const facts = candidateResumeFacts(item);
  const files = conversation.data?.files ?? [], messages = conversation.data?.messages ?? [];
  const reason = vacancyFilterReason(item);
  const work = facts.experience?.value || item.experience;
  const education = facts.education?.value || item.education;
  const city = facts.city?.value || item.city;
  const chatLanguage = item.chatLanguage ? vacancyChatLanguageText(item.chatLanguage) : null;
  const study = candidateStudyState(item);
  const employment = facts.employedNow?.value ?? item.employedNow;
  const missing = item.recruitmentAssessment?.missing ?? [];
  const showStudy = study != null || missing.includes("studyingNow");
  const showEmployment = employment != null || missing.includes("employedNow");
  const terminal = item.status === "HIRED" || item.status === "REJECTED";
  const age = facts.age?.value ?? item.age;
  return <article className="vacancy-resume" aria-labelledby="candidate-resume-title">
    <div className="vacancy-resume-paper">
      <header className="vacancy-person-heading">
        <div className="vacancy-person-badges"><span className="vacancy-stage-badge">{CANDIDATE_STAGE_LABELS[item.status]}</span><VacancyPriority item={item} /></div>
        <h2 id="candidate-resume-title" tabIndex={-1}>{candidateTitle(item)}</h2>
        <p className={item.positionTitle ? "vacancy-position-title" : "vacancy-position-title none"}>{item.positionTitle || "Без вакансии"}</p>
        {item.priorityReason && <p className="vacancy-priority-reason">Оценка: {item.priorityReason}</p>}
        <ul className="vacancy-person-meta"><li><MapPin size={16} aria-hidden="true" />{city || "Город не указан"}</li><li><MessageCircle size={16} aria-hidden="true" />{chatLanguage ? `Общение: ${chatLanguage.charAt(0).toLocaleUpperCase("ru")}${chatLanguage.slice(1)}` : "Язык общения не выбран"}</li><li><Phone size={16} aria-hidden="true" />{item.phone || "Нужен телефон"}</li></ul>
        <div className="vacancy-person-actions">
          {!readOnly && <CallClientButton candidateId={item.id} phone={item.phone} variant="full" label="Позвонить" className="vacancy-button secondary" title="Звонок через телефонную станцию CRM" />}
          {!readOnly && !terminal && <button type="button" className="vacancy-button secondary" onClick={openInvite}>Пригласить</button>}
          {onPrint && <button type="button" className="vacancy-button secondary" onClick={onPrint}><Printer size={17} aria-hidden="true" />Распечатать</button>}
          {item.cvFile && <VacancyFileButton applicationId={item.id} file={item.cvFile} label="Оригинал резюме" />}
          {onDelete && !readOnly && <details className="vacancy-menu"><summary aria-label="Ещё действия"><MoreHorizontal size={18} aria-hidden="true" /></summary>
            <div className="vacancy-menu-list" role="menu"><button type="button" role="menuitem" className="vacancy-text-button danger" onClick={event => { (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); onDelete(); }}><Trash2 size={16} aria-hidden="true" />Удалить навсегда</button></div>
          </details>}
        </div>
        <p className="vacancy-muted vacancy-resume-source">{item.recruitmentResume ? "Из резюме и ответов кандидата. Источники сохранены." : "Сохранённые сведения из анкеты. Проверьте по оригиналам."}</p>
      </header>
      <dl className="vacancy-fact-grid" aria-label="Коротко о кандидате">
        <div><dt>Возраст</dt><dd>{age ?? "Не выяснено"}</dd></div>
        <div><dt>Город</dt><dd>{city || "Не выяснено"}</dd></div>
        <div><dt>Опыт в продажах</dt><dd>{yesNo(item.salesExperience)}</dd></div>
        <div><dt>Машина</dt><dd>{yesNo(item.hasCar)}</dd></div>
        <div><dt>Сильное желание</dt><dd>{yesNo(item.strongMotivation)}</dd></div>
        <div><dt>Диплом по профилю</dt><dd>{yesNo(item.targetEducation)}</dd></div>
      </dl>
      <div className="vacancy-resume-columns"><div className="vacancy-resume-main">
        <ResumeSection title="О себе"><FactText value={facts.about?.value} fact={facts.about} /></ResumeSection>
        <ResumeSection title="Опыт работы"><FactText value={work} fact={facts.experience} /></ResumeSection>
        <ResumeSection title="Работы кандидата">
          {item.customerPortfolio?.length ? <ul className="vacancy-portfolio">{item.customerPortfolio.map((entry, index) => <li key={"url" in entry ? entry.url : entry.file}>
            {"url" in entry ? <a href={entry.url} target="_blank" rel="noopener noreferrer nofollow" className="vacancy-portfolio-link"><ExternalLink size={24} aria-hidden="true" /><strong>Работа {index + 1}</strong><span>Открыть ссылку кандидата</span></a>
              : <VacancyFileButton applicationId={item.id} file={entry.file} portfolioIndex={index} label={`Работа ${index + 1} · открыть файл`} />}
          </li>)}</ul> : <p className="vacancy-missing">Примеры работ пока не присланы.</p>}
        </ResumeSection>
        <ResumeSection title="Контакт"><PhoneField item={item} /><p className="vacancy-muted">Отклик: {vacancyChannelLabel(item.channel)} · {vacancyReceivedLabel(item.createdAt)}</p></ResumeSection>
        {item.achievements && <ResumeSection title="Достижения"><p className="vacancy-resume-text">{item.achievements}</p></ResumeSection>}
      </div><aside className="vacancy-resume-facts" aria-label="Сведения о кандидате">
        <ResumeSection title="Навыки"><FactText value={facts.skills?.value} fact={facts.skills} /></ResumeSection>
        <ResumeSection title="Инструменты"><FactText value={facts.tools?.value} fact={facts.tools} /></ResumeSection>
        <ResumeSection title="Образование"><FactText value={education} fact={facts.education} /></ResumeSection>
        <ResumeSection title="Языки"><FactText value={facts.languages?.value || item.languages} fact={facts.languages} /></ResumeSection>
        <ResumeSection title="Готовность к работе"><dl className="vacancy-readiness"><div><dt>Когда готов начать</dt><dd>{facts.startWhen?.value || item.startWhen || "Нужно уточнить"}</dd></div>
          {showEmployment && <div><dt>Сейчас работает</dt><dd>{employment == null ? "Нужно уточнить" : employment ? "Да" : "Нет"}</dd></div>}{showStudy && <div><dt>Сейчас учится</dt><dd>{study == null ? "Нужно уточнить" : study ? "Да" : "Нет"}</dd></div>}</dl></ResumeSection>
      </aside></div>
      {item.recruitmentAssessment?.warnings.map(warning => <p className="vacancy-notice" key={warning}>{warning}</p>)}
      {reason && !item.customerInquiryId && <details className="vacancy-legacy-assessment"><summary>Проверка прежней анкеты</summary><p>{reason}.{item.eligibleOverride ? " Руководитель взял кандидата в работу." : " Это справочная проверка. Решение принимает руководитель."}</p></details>}
      {item.status === "INTERVIEW" && item.interviewAt && <p className="vacancy-notice">Собеседование: {vacancyInterviewLabel(item.interviewAt)}. Назначенная дата сама по себе не означает, что кандидат подтвердил участие.</p>}
      {item.inviteCall && <section className="vacancy-invite-result"><h3>Последний звонок ассистента</h3><p>{item.inviteCall.text}</p>{item.inviteCall.summary && <p>{item.inviteCall.summary}</p>}{item.inviteCall.hasRecording && <InviteCallRecording applicationId={item.id} />}</section>}
      {(item.interviewNote || item.rejectionReason || item.rejectionReasonVoiceUrl) && <ResumeSection title="Заметки руководителя">{item.interviewNote && <p>{item.interviewNote}</p>}{item.rejectionReason && <p>Причина отказа: {item.rejectionReason}</p>}{item.rejectionReasonVoiceUrl && <VoiceNotePlayer url={item.rejectionReasonVoiceUrl} />}</ResumeSection>}
      <ResumeSection title="Что написал сам" className="vacancy-own-words">{item.rawText ? <p className="vacancy-resume-text">{item.rawText}</p> : <p className="vacancy-missing">Отдельный текст анкеты не сохранён.</p>}</ResumeSection>
      <details className="vacancy-original-text"><summary>Вложения кандидата{files.length ? ` · ${files.length}` : ""}</summary>
        {!conversation.isLoading && !conversation.isError && !files.length && <p className="vacancy-missing">Файлов в переписке нет.</p>}
        {conversation.isLoading && <p role="status">Загружаем вложения…</p>}
        {conversation.isError && <p role="alert">Материалы не загрузились. <button type="button" className="vacancy-text-button" onClick={() => void conversation.refetch()}>Повторить</button></p>}
        {files.length > 0 && <MessageAttachments attachments={files} />}
      </details>
      <section className="vacancy-chat-section"><button type="button" className="vacancy-text-button" aria-expanded={showChat} onClick={() => setShowChat(value => !value)}>{showChat ? "Скрыть переписку" : "Показать переписку"}{messages.length ? ` · ${messages.length}` : ""}</button>
        {showChat && <div className="vacancy-chat-thread">{conversation.isLoading ? <p role="status">Загружаем переписку…</p> : conversation.isError ? <p role="alert">Не удалось загрузить переписку. <button type="button" className="vacancy-text-button" onClick={() => void conversation.refetch()}>Повторить</button></p>
          : messages.length ? messages.map((message, index) => <div className={`vacancy-chat-message ${message.role === "user" ? "candidate" : ""}`} key={index}><strong>{message.role === "user" ? "Кандидат" : "Сотрудник или ассистент"}</strong><p>{message.content}</p></div>) : <p className="vacancy-missing">Сообщения для этой анкеты пока недоступны. Сохранённые сведения и файлы остаются в анкете.</p>}</div>}
      </section>
      <p className="vacancy-resume-disclaimer">Неуказанные сведения не означают отказ. Решение о приглашении принимает руководитель.</p>
      {Object.keys(facts).length > 0 && <span className="sr-only">Сведения с источниками: {Object.keys(facts).map(key => RECRUITMENT_FACT_LABELS[key as keyof RecruitmentResumeFacts]).join(", ")}</span>}
    </div>
  </article>;
}

const yesNo = (value: boolean | null | undefined) => value == null ? "Не выяснено" : value ? "Да" : "Нет";

/** «Пригласить» в шапке ведёт в ту же форму, что кнопка панели действий:
 *  одна реализация приглашения, без второй копии формы. */
function openInvite() {
  const button = document.getElementById("candidate-invite-button") as HTMLButtonElement | null;
  if (button && !button.disabled) { button.click(); return; }
  const panel = document.getElementById("candidate-next-actions");
  panel?.scrollIntoView({ block: "start", behavior: "smooth" }); panel?.focus();
}

function InviteCallRecording({ applicationId }: { applicationId: string }) {
  const recording = useInviteCallRecordingUrl();
  const [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  if (url) return <audio controls preload="none" src={url} className="vacancy-recording" />;
  return <div><button type="button" className="vacancy-text-button" disabled={recording.isPending} onClick={() => { setFailed(false); recording.mutate(applicationId, { onSuccess: response => setUrl(response.url), onError: () => setFailed(true) }); }}>{recording.isPending ? "Загружаем запись…" : "Послушать разговор"}</button>{failed && <p role="alert">Запись не открылась. Попробуйте ещё раз.</p>}</div>;
}
