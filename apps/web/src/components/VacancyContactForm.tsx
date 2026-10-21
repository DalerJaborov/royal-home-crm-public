import { useState } from "react";
import { recruitmentContactPreviewSchema, type RecruitmentContactOptions, type RecruitmentCommunicationChannel, type RecruitmentContactPreview, type RecruitmentContactConfirmation } from "@royal-home/shared";
import type { JobApplication } from "../hooks/useVacancies";
import { usePreviewVacancyContact, useConfirmVacancyContact, useVacancyContactOptions } from "../hooks/useVacancyContact";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { MutationError } from "./MutationError";
import { interviewInputToIso, interviewIsoToInput } from "../lib/vacanciesView";
import { candidateTitle } from "../lib/vacanciesResume";
import { RECRUITMENT_DELIVERY_LABEL, recruitmentSendLabel } from "../lib/vacanciesContact";

export function VacancyContactForm({ item, options, purpose, onClose }: {
  item: JobApplication; options: RecruitmentContactOptions; purpose: "INVITE" | "CLARIFY"; onClose(): void;
}) {
  const [interviewAt, setInterviewAt] = useState(item.interviewAt ? interviewIsoToInput(item.interviewAt) : "");
  const [language, setLanguage] = useState<"ru" | "tg" | "">(options.language || "");
  const [address, setAddress] = useState(options.office.address || ""), [mapUrl, setMapUrl] = useState(options.office.mapUrl || "");
  const [preparation, setPreparation] = useState(options.office.preparation || "");
  const [channels, setChannels] = useState<RecruitmentCommunicationChannel[]>(purpose === "CLARIFY" && options.assistantCall.available ? ["ASSISTANT_CALL"] : options.sms.available ? ["SMS"] : options.assistantCall.available ? ["ASSISTANT_CALL"] : []);
  const [preview, setPreview] = useState<RecruitmentContactPreview | null>(null);
  const [result, setResult] = useState<RecruitmentContactConfirmation | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const previewMutation = usePreviewVacancyContact(item.id), confirmMutation = useConfirmVacancyContact(item.id);
  const recent = useVacancyContactOptions(item.id);
  const busy = previewMutation.isPending || confirmMutation.isPending;
  const attempted = !!confirmMutation.submittedAt;
  function changeChannel(channel: RecruitmentCommunicationChannel, selected: boolean) {
    setChannels(current => selected ? [...current.filter(value => value !== channel), channel] : current.filter(value => value !== channel));
  }
  function prepare() {
    setError("");
    const iso = purpose === "INVITE" ? interviewInputToIso(interviewAt) : null;
    if (purpose === "INVITE" && (!iso || new Date(iso).getTime() <= Date.now())) { setError("Выберите будущую дату и время собеседования."); return; }
    if (purpose === "INVITE" && !address.trim()) { setError("Укажите адрес собеседования."); return; }
    const parsed = recruitmentContactPreviewSchema.safeParse({ purpose, channels, language,
      ...(iso ? { interviewAt: iso } : {}), ...(purpose === "INVITE" ? { address: address.trim(), ...(mapUrl.trim() ? { mapUrl: mapUrl.trim() } : {}), preparation: preparation.trim() } : {}) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || "Проверьте заполненные поля."); return; }
    previewMutation.mutate(parsed.data, { onSuccess: value => { setPreview(value); setIdempotencyKey(crypto.randomUUID()); confirmMutation.reset(); } });
  }
  return <Rh2Sheet title={purpose === "INVITE" ? "Приглашение на собеседование" : "Уточнение анкеты"} onClose={onClose} dismissible={!busy} closeOnBackdrop={false} wide className="vacancy-contact-sheet"
    onSubmit={event => { event.preventDefault(); if (!preview) prepare(); }}
    footer={<div className="vacancy-contact-scope vacancy-contact-footer">
      {result ? <button type="button" className="vacancy-button" onClick={onClose}>Закрыть</button> : preview ? <>
        <button type="button" className="vacancy-button secondary" disabled={busy || attempted} onClick={() => { setPreview(null); previewMutation.reset(); }}>Изменить</button>
        <button type="button" className="vacancy-button" disabled={busy || attempted} onClick={() => {
          if (new Date(preview.expiresAt).getTime() <= Date.now()) { setError("Предпросмотр устарел. Вернитесь к форме и проверьте детали ещё раз."); return; }
          setError(""); confirmMutation.mutate({ previewId: preview.previewId, idempotencyKey }, { onSuccess: setResult });
        }}>{confirmMutation.isPending ? "Проверяем отправку…" : recruitmentSendLabel(channels)}</button>
      </> : <><button type="button" className="vacancy-button secondary" disabled={busy} onClick={onClose}>Отмена</button><button type="submit" className="vacancy-button" disabled={busy || channels.length === 0 || !language}>{busy ? "Готовим…" : purpose === "INVITE" ? "Посмотреть приглашение" : "Посмотреть вопросы"}</button></>}
    </div>}>
    <div className="vacancy-contact-scope">
      <p className="vacancy-contact-person">{candidateTitle(item)} · {item.positionTitle || "Должность не указана"}</p>
      <p className="vacancy-muted">Получатель: {item.phone || "телефон не указан"}</p>
      {result ? <div className="vacancy-contact-result" role="status"><h3>{result.interviewSaved ? "Собеседование сохранено" : "Запрос обработан"}</h3>
        <p>{result.interviewSaved ? "Статус каждого способа связи указан отдельно. Назначение встречи не означает подтверждение кандидата." : "Статус каждого способа связи указан отдельно. Ответы после звонка появятся в анкете."}</p>
        <DeliveryList deliveries={result.deliveries} />
        <AssistantFindings deliveries={result.deliveries} />
      </div> : preview ? <>
        <h3>Проверьте перед отправкой</h3>
        {channels.includes("SMS") && <section className="vacancy-preview-card"><h4>SMS</h4><p>{preview.text}</p></section>}
        {channels.includes("ASSISTANT_CALL") && <section className="vacancy-preview-card"><h4>Звонок ассистента</h4><p>{preview.callSummary || preview.text}</p><p className="vacancy-muted">Звонок выполняется по правилам рабочих часов. Результат появится в анкете.</p></section>}
        <p className="vacancy-notice">{channels.length === 2 ? "Будут созданы SMS и звонок ассистента." : channels[0] === "SMS" ? "Будет создана отправка SMS." : "Будет создан один звонок ассистента."} Пока вы не нажали кнопку отправки, кандидат ничего не получит.</p>
      </> : <>
        {purpose === "INVITE" ? <>
          <label className="vacancy-field"><span>Дата и время собеседования</span><input type="datetime-local" value={interviewAt} min={interviewIsoToInput(new Date())} required onChange={event => setInterviewAt(event.target.value)} /><small>Время Душанбе, UTC+5</small></label>
          <label className="vacancy-field"><span>Адрес встречи</span><textarea rows={2} value={address} required maxLength={300} onChange={event => setAddress(event.target.value)} /></label>
          <label className="vacancy-field"><span>Ссылка на точку на карте</span><input type="url" value={mapUrl} maxLength={1000} onChange={event => setMapUrl(event.target.value)} placeholder="https://…" /><small>Google Maps, Яндекс Карты или 2ГИС. Проверьте, что точка указана верно.</small></label>
          <label className="vacancy-field"><span>Что подготовить</span><textarea rows={3} value={preparation} maxLength={1000} onChange={event => setPreparation(event.target.value)} placeholder="По желанию: что посмотреть или подготовить к встрече" /></label>
        </> : <p className="vacancy-notice">Ассистент уточнит недостающие сведения по правилам этой вакансии. Собеседование не назначается; решение остаётся за руководителем.</p>}
        <label className="vacancy-field"><span>Язык общения</span><select value={language} required onChange={event => setLanguage(event.target.value as "ru" | "tg" | "")}><option value="">Выберите язык</option><option value="ru">Русский</option><option value="tg">Тоҷикӣ</option></select></label>
        <fieldset className="vacancy-channel-options"><legend>{purpose === "INVITE" ? "Как пригласить" : "Как уточнить"}</legend>
          <label><input type="checkbox" disabled={!options.sms.available} checked={channels.includes("SMS")} onChange={event => changeChannel("SMS", event.target.checked)} /><span><strong>SMS</strong><small>{options.sms.available ? "Текст с деталями на указанный номер" : options.sms.reason || "SMS недоступны"}</small></span></label>
          <label><input type="checkbox" disabled={!options.assistantCall.available} checked={channels.includes("ASSISTANT_CALL")} onChange={event => changeChannel("ASSISTANT_CALL", event.target.checked)} /><span><strong>Звонок ассистента</strong><small>{options.assistantCall.available ? purpose === "INVITE" ? "Позвонит и пригласит на встречу" : "Позвонит и уточнит недостающие ответы" : options.assistantCall.reason || "Звонок недоступен"}</small></span></label>
        </fieldset>
      </>}
      {error && <p className="vacancy-form-error" role="alert">{error}</p>}
      <MutationError mutation={previewMutation} fallback={purpose === "INVITE" ? "Не удалось подготовить приглашение" : "Не удалось подготовить вопросы"} />
      {confirmMutation.isError && <div className="vacancy-notice" role="alert"><p>Результат отправки нужно проверить. Не создавайте повторную отправку, пока статус неизвестен.</p><p>{confirmMutation.error.message}</p><button type="button" className="vacancy-button secondary" onClick={() => void recent.refetch()}>Проверить статус</button><DeliveryList deliveries={recent.data?.recentDeliveries ?? []} /></div>}
    </div>
  </Rh2Sheet>;
}

export function DeliveryList({ deliveries }: { deliveries: RecruitmentContactConfirmation["deliveries"] }) {
  return <ul className="vacancy-deliveries">{deliveries.map(delivery => <li key={delivery.id}><strong>{delivery.channel === "SMS" ? "SMS" : "Звонок ассистента"}</strong><span>{RECRUITMENT_DELIVERY_LABEL[delivery.status]}</span>{delivery.reason && <small>{delivery.reason}</small>}</li>)}</ul>;
}

export function AssistantFindings({ deliveries }: { deliveries: RecruitmentContactConfirmation["deliveries"] }) {
  const calls = deliveries.filter(delivery => delivery.channel === "ASSISTANT_CALL" && delivery.result);
  if (!calls.length) return null;
  return <section className="vacancy-assistant-findings" aria-label="Что собрал ассистент"><h3>Что собрал ассистент</h3>
    {calls.map(call => call.result && <article className="vacancy-assistant-finding" key={call.id}>
      <h4>{call.result.purpose === "CLARIFY" ? "Уточнение анкеты" : "Ответ на приглашение"}</h4>
      {call.result.candidateSpoke ? <><p>{call.result.summary}</p><p className="vacancy-muted">Сведения из разговора. Проверьте их перед решением — это не подтверждённые руководителем факты.</p></>
        : <><p>Ответов кандидата нет.</p><p className="vacancy-muted">{call.result.summary}</p></>}
      {call.reason && <p className="vacancy-muted">{call.reason}</p>}
      {call.result.transcript.length > 0 && <details><summary>Фрагменты разговора</summary><ul>{call.result.transcript.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
    </article>)}
  </section>;
}
