import { useState, type ReactNode } from "react";
import { ExternalLink, FileText } from "lucide-react";
import { RECRUITMENT_FACT_LABELS, type RecruitmentResumeFacts } from "@royal-home/shared";
import { useInviteCallRecordingUrl, useVacancyConversation, type JobApplication } from "../hooks/useVacancies";
import { useVacancyContactOptions } from "../hooks/useVacancyContact";
import { MessageAttachments } from "./MessageAttachments";
import { VoiceNotePlayer } from "./VoiceNotePlayer";
import { DeliveryList, AssistantFindings } from "./VacancyContactForm";
import { api } from "../lib/api";
import { browserDeps, openPrivateFile } from "../lib/openPrivateFile";
import { useIsReadOnly } from "../lib/permissions";
import { candidateResumeFacts, candidateStudyState } from "../lib/vacanciesResume";
import { vacancyChatLanguageText, vacancyChannelLabel, vacancyFilterReason, vacancyInterviewLabel, vacancyReceivedLabel } from "../lib/vacanciesView";

/**
 * Содержимое карточки кандидата `/vacancies/:id` по вкладкам (23.10.2026):
 * «Анкета», «Переписка», «Связь», «Материалы». Шапка и действия — на странице
 * (pages/VacancyDetail.tsx), здесь только то, что внутри вкладок.
 */

const yesNo = (value: boolean | null | undefined) => value == null ? "Не выяснено" : value ? "Да" : "Нет";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="grid gap-2"><h3 className="text-[16px] font-semibold text-ink">{title}</h3>{children}</section>;
}

function Missing({ children }: { children: ReactNode }) {
  return <p className="text-[15px] text-gray-500">{children}</p>;
}

function FactText({ value, fact }: { value?: string | null; fact?: RecruitmentResumeFacts[keyof RecruitmentResumeFacts] }) {
  return <>{value ? <p className="vacancy-resume-text">{value}</p> : <Missing>Не указано</Missing>}
    {fact && <details className="vacancy-fact-source"><summary>Слова кандидата</summary><blockquote>{fact.quote}</blockquote></details>}
  </>;
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Коротко о кандидате">
    {rows.map(([label, value]) => <div key={label} className="min-w-0 rounded-[14px] bg-row-alt p-3">
      <dt className="text-[13px] text-gray-500">{label}</dt><dd className="mt-1 break-words text-[16px] font-semibold text-ink">{value}</dd>
    </div>)}
  </dl>;
}

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
  return <button type="button" className="pill ghost" onClick={open} disabled={state === "loading"}>
    <FileText className="i" aria-hidden="true" />{state === "loading" ? "Открываем…" : state === "error" ? "Не открылось — повторить" : label || "Открыть оригинал резюме"}
  </button>;
}

/** «Анкета»: сведения сеткой, тексты из резюме с источниками, слова кандидата, заметки. */
export function VacancyDetails({ item }: { item: JobApplication }) {
  const facts = candidateResumeFacts(item);
  const reason = vacancyFilterReason(item);
  const chatLanguage = item.chatLanguage ? vacancyChatLanguageText(item.chatLanguage) : null;
  const study = candidateStudyState(item);
  const employment = facts.employedNow?.value ?? item.employedNow;
  const missing = item.recruitmentAssessment?.missing ?? [];
  const age = facts.age?.value ?? item.age;
  const rows: Array<[string, ReactNode]> = [
    ["Возраст", age ?? "Не выяснено"],
    ["Город", facts.city?.value || item.city || "Не выяснено"],
    ["Опыт в продажах", yesNo(item.salesExperience)],
    ["Машина", yesNo(item.hasCar)],
    ["Сильное желание", yesNo(item.strongMotivation)],
    ["Диплом по профилю", yesNo(item.targetEducation)],
    ["Когда готов начать", facts.startWhen?.value || item.startWhen || "Нужно уточнить"],
  ];
  if (employment != null || missing.includes("employedNow")) rows.push(["Сейчас работает", employment == null ? "Нужно уточнить" : employment ? "Да" : "Нет"]);
  if (study != null || missing.includes("studyingNow")) rows.push(["Сейчас учится", study == null ? "Нужно уточнить" : study ? "Да" : "Нет"]);
  return <article className="grid gap-6" aria-label="Анкета кандидата">
    <p className="text-[15px] text-gray-500">{chatLanguage ? `Общение: ${chatLanguage.charAt(0).toLocaleUpperCase("ru")}${chatLanguage.slice(1)}` : "Язык общения не выбран"}
      {" · "}{item.recruitmentResume ? "Из резюме и ответов кандидата, источники сохранены." : "Сохранённые сведения из анкеты, проверьте по оригиналам."}</p>
    {item.priorityReason && <p className="quiet"><span className="dot" /><span className="txt">Оценка: {item.priorityReason}</span></p>}
    <Facts rows={rows} />
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="О себе"><FactText value={facts.about?.value} fact={facts.about} /></Section>
      <Section title="Опыт работы"><FactText value={facts.experience?.value || item.experience} fact={facts.experience} /></Section>
      <Section title="Навыки"><FactText value={facts.skills?.value} fact={facts.skills} /></Section>
      <Section title="Инструменты"><FactText value={facts.tools?.value} fact={facts.tools} /></Section>
      <Section title="Образование"><FactText value={facts.education?.value || item.education} fact={facts.education} /></Section>
      <Section title="Языки"><FactText value={facts.languages?.value || item.languages} fact={facts.languages} /></Section>
      {item.achievements && <Section title="Достижения"><p className="vacancy-resume-text">{item.achievements}</p></Section>}
    </div>
    {item.recruitmentAssessment?.warnings.map(warning => <p className="quiet warn" key={warning}><span className="dot warn" /><span className="txt">{warning}</span></p>)}
    {reason && !item.customerInquiryId && <details className="vacancy-fact-source"><summary>Проверка прежней анкеты</summary><p>{reason}.{item.eligibleOverride ? " Руководитель взял кандидата в работу." : " Это справочная проверка. Решение принимает руководитель."}</p></details>}
    {item.status === "INTERVIEW" && item.interviewAt && <p className="quiet"><span className="dot" /><span className="txt">Собеседование: {vacancyInterviewLabel(item.interviewAt)}. Назначенная дата сама по себе не означает, что кандидат подтвердил участие.</span></p>}
    <Section title="Что написал сам">{item.rawText ? <p className="vacancy-resume-text">{item.rawText}</p> : <Missing>Отдельный текст анкеты не сохранён.</Missing>}</Section>
    {(item.interviewNote || item.rejectionReason || item.rejectionReasonVoiceUrl) && <Section title="Заметки руководителя">
      {item.interviewNote && <p className="vacancy-resume-text">{item.interviewNote}</p>}
      {item.rejectionReason && <p className="vacancy-resume-text">Причина отказа: {item.rejectionReason}</p>}
      {item.rejectionReasonVoiceUrl && <VoiceNotePlayer url={item.rejectionReasonVoiceUrl} />}
    </Section>}
    <p className="text-[14px] text-gray-500">Неуказанные сведения не означают отказ. Решение о приглашении принимает руководитель.</p>
    {Object.keys(facts).length > 0 && <span className="sr-only">Сведения с источниками: {Object.keys(facts).map(key => RECRUITMENT_FACT_LABELS[key as keyof RecruitmentResumeFacts]).join(", ")}</span>}
  </article>;
}

/** «Переписка»: реплики анкеты через разрешённый маршрут раздела, без ссылок наружу. */
export function VacancyConversation({ item }: { item: JobApplication }) {
  const conversation = useVacancyConversation(item.id);
  const messages = conversation.data?.messages ?? [];
  if (conversation.isLoading) return <p className="quiet" role="status"><span className="dot" /><span className="txt">Загружаем переписку…</span></p>;
  if (conversation.isError) return <div className="quiet warn" role="alert"><span className="dot warn" /><span className="txt">Не удалось загрузить переписку.</span><button type="button" className="lnk" onClick={() => void conversation.refetch()}>Повторить</button></div>;
  if (!messages.length) return <Missing>Сообщения для этой анкеты пока недоступны. Сохранённые сведения и файлы остаются в анкете.</Missing>;
  return <ol className="grid gap-3" aria-label="Переписка с кандидатом">{messages.map((message, index) =>
    <li key={index} className={message.role === "user" ? "max-w-[min(640px,100%)] rounded-[14px] bg-row-alt p-3" : "ml-auto max-w-[min(640px,100%)] rounded-[14px] bg-blue/10 p-3"}>
      <p className="text-[13px] font-semibold text-gray-500">{message.role === "user" ? "Кандидат" : "Сотрудник или ассистент"}</p>
      <p className="vacancy-resume-text mt-1">{message.content}</p>
    </li>)}</ol>;
}

/** «Связь»: откуда отклик, последний звонок ассистента, история приглашений и уточнений. */
export function VacancyContactHistory({ item }: { item: JobApplication }) {
  const readOnly = useIsReadOnly();
  const options = useVacancyContactOptions(item.id, !readOnly);
  const deliveries = options.data?.recentDeliveries ?? [];
  return <div className="grid gap-6">
    <Section title="Отклик"><p className="text-[15px] text-ink">{vacancyChannelLabel(item.channel)} · {vacancyReceivedLabel(item.createdAt)}</p></Section>
    {item.inviteCall && <Section title="Последний звонок ассистента"><p className="vacancy-resume-text">{item.inviteCall.text}</p>
      {item.inviteCall.summary && <p className="vacancy-resume-text">{item.inviteCall.summary}</p>}
      {item.inviteCall.hasRecording && <InviteCallRecording applicationId={item.id} />}</Section>}
    <Section title="Приглашения и уточнения">{deliveries.length ? <DeliveryList deliveries={deliveries} />
      : options.isPending && !readOnly ? <Missing>Загружаем историю связи…</Missing> : <Missing>Приглашений и уточнений ещё не было.</Missing>}</Section>
    <AssistantFindings deliveries={deliveries} />
  </div>;
}

/** «Материалы»: оригинал резюме, работы кандидата, вложения из переписки. */
export function VacancyOriginals({ item }: { item: JobApplication }) {
  const conversation = useVacancyConversation(item.id);
  const files = conversation.data?.files ?? [];
  return <div className="grid gap-6">
    <Section title="Резюме">{item.cvFile ? <div className="wrap"><VacancyFileButton applicationId={item.id} file={item.cvFile} /></div>
      : <Missing>Файл резюме пока не прикреплён. Текст отклика доступен в анкете.</Missing>}</Section>
    <Section title="Работы кандидата">{item.customerPortfolio?.length ? <div className="wrap">{item.customerPortfolio.map((entry, index) => "url" in entry
      ? <a key={entry.url} href={entry.url} target="_blank" rel="noopener noreferrer nofollow" className="pill ghost"><ExternalLink className="i" aria-hidden="true" />Работа {index + 1}</a>
      : <VacancyFileButton key={entry.file} applicationId={item.id} file={entry.file} portfolioIndex={index} label={`Работа ${index + 1} · открыть файл`} />)}</div>
      : <Missing>Примеры работ пока не присланы.</Missing>}</Section>
    <Section title={`Вложения из переписки${files.length ? ` · ${files.length}` : ""}`}>
      {conversation.isLoading ? <Missing>Загружаем вложения…</Missing>
        : conversation.isError ? <div className="quiet warn" role="alert"><span className="dot warn" /><span className="txt">Материалы не загрузились.</span><button type="button" className="lnk" onClick={() => void conversation.refetch()}>Повторить</button></div>
          : files.length ? <MessageAttachments attachments={files} /> : <Missing>Файлов в переписке нет.</Missing>}
    </Section>
  </div>;
}

function InviteCallRecording({ applicationId }: { applicationId: string }) {
  const recording = useInviteCallRecordingUrl();
  const [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  if (url) return <audio controls preload="none" src={url} className="w-full max-w-[480px]" />;
  return <div><button type="button" className="pill ghost sm" disabled={recording.isPending} onClick={() => { setFailed(false); recording.mutate(applicationId, { onSuccess: response => setUrl(response.url), onError: () => setFailed(true) }); }}>{recording.isPending ? "Загружаем запись…" : "Послушать разговор"}</button>{failed && <p role="alert" className="text-[14px] text-red">Запись не открылась. Попробуйте ещё раз.</p>}</div>;
}
