import { useState } from "react";
import { recruitmentContactPreviewSchema, type RecruitmentContactOptions, type RecruitmentCommunicationChannel, type RecruitmentContactPreview, type RecruitmentContactConfirmation } from "@royal-home/shared";
import type { JobApplication } from "../hooks/useVacancies";
import { usePreviewVacancyContact, useConfirmVacancyContact, useVacancyContactOptions } from "../hooks/useVacancyContact";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { MutationError } from "./MutationError";
import { interviewInputToIso, interviewIsoToInput } from "../lib/vacanciesView";
import { candidateTitle } from "../lib/vacanciesResume";
import { RECRUITMENT_DELIVERY_LABEL, recruitmentSendLabel, contactConfirmBlocked, contactDefaultAddress, smsSegmentsLabel } from "../lib/vacanciesContact";

export function VacancyContactForm({ item, options, purpose, onClose }: {
  item: JobApplication; options: RecruitmentContactOptions; purpose: "INVITE" | "CLARIFY"; onClose(): void;
}) {
  const [interviewAt, setInterviewAt] = useState(item.interviewAt ? interviewIsoToInput(item.interviewAt) : "");
  const [language, setLanguage] = useState<"ru" | "tg" | "">(options.language || "");
  const [address, setAddress] = useState(() => contactDefaultAddress(options.office, options.language || ""));
  const [addressEdited, setAddressEdited] = useState(false);
  const [mapUrl, setMapUrl] = useState(options.office.mapUrl || "");
  const [preparation, setPreparation] = useState(options.office.preparation || "");
  const [channels, setChannels] = useState<RecruitmentCommunicationChannel[]>(purpose === "CLARIFY" && options.assistantCall.available ? ["ASSISTANT_CALL"] : options.sms.available ? ["SMS"] : options.assistantCall.available ? ["ASSISTANT_CALL"] : []);
  const [preview, setPreview] = useState<RecruitmentContactPreview | null>(null);
  const [result, setResult] = useState<RecruitmentContactConfirmation | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const previewMutation = usePreviewVacancyContact(item.id), confirmMutation = useConfirmVacancyContact(item.id);
  const recent = useVacancyContactOptions(item.id);
  const busy = previewMutation.isPending || confirmMutation.isPending;
  // Повтор запрещён только после успеха или неясного исхода (5xx, сеть):
  // понятный отказ 4xx («предпросмотр устарел») можно исправить и отправить снова.
  const attempted = contactConfirmBlocked(confirmMutation.isSuccess, confirmMutation.isError ? confirmMutation.error : null);
  const segments = smsSegmentsLabel(preview);
  function changeLanguage(next: "ru" | "tg" | "") {
    setLanguage(next);
    if (!addressEdited) setAddress(contactDefaultAddress(options.office, next));
  }
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
  return <Rh2Sheet title={purpose === "INVITE" ? "Приглашение на собеседование" : "Уточнение анкеты"} onClose={onClose} dismissible={!busy} closeOnBackdrop={false} wide
    onSubmit={event => { event.preventDefault(); if (!preview) prepare(); }}
    footer={<div className="wrap">
      {result ? <button type="button" className="pill" onClick={onClose}>Закрыть</button> : preview ? <>
        <button type="button" className="pill ghost" disabled={busy || attempted} onClick={() => { setPreview(null); previewMutation.reset(); }}>Изменить</button>
        <button type="button" className="pill" disabled={busy || attempted} onClick={() => {
          if (new Date(preview.expiresAt).getTime() <= Date.now()) { setError("Предпросмотр устарел. Вернитесь к форме и проверьте детали ещё раз."); return; }
          setError(""); confirmMutation.mutate({ previewId: preview.previewId, idempotencyKey }, { onSuccess: setResult });
        }}>{confirmMutation.isPending ? "Проверяем отправку…" : recruitmentSendLabel(channels)}</button>
      </> : <><button type="button" className="pill ghost" disabled={busy} onClick={onClose}>Отмена</button><button type="submit" className="pill" disabled={busy || channels.length === 0 || !language}>{busy ? "Готовим…" : purpose === "INVITE" ? "Посмотреть приглашение" : "Посмотреть вопросы"}</button></>}
    </div>}>
    <div className="grid gap-3">
      <p className="text-[16px] font-semibold text-ink">{candidateTitle(item)} · {item.positionTitle || "Должность не указана"}</p>
      <p className="text-[14px] text-gray-500">Получатель: {item.phone || "телефон не указан"}</p>
      {result ? <div className="grid gap-3" role="status"><h3>{result.interviewSaved ? "Собеседование сохранено" : "Запрос обработан"}</h3>
        <p>{result.interviewSaved ? "Статус каждого способа связи указан отдельно. Назначение встречи не означает подтверждение кандидата." : "Статус каждого способа связи указан отдельно. Ответы после звонка появятся в анкете."}</p>
        <DeliveryList deliveries={result.deliveries} />
        <AssistantFindings deliveries={result.deliveries} />
      </div> : preview ? <>
        <h3>Проверьте перед отправкой</h3>
        {channels.includes("SMS") && <section className="grid gap-2 rounded-[14px] bg-row-alt p-4"><h4>SMS</h4><p>{preview.text}</p>{segments && <p className="text-[14px] text-gray-500">{segments}</p>}</section>}
        {channels.includes("ASSISTANT_CALL") && <section className="grid gap-2 rounded-[14px] bg-row-alt p-4"><h4>Звонок ассистента</h4><p>{preview.callSummary || preview.text}</p><p className="text-[14px] text-gray-500">Звонок выполняется по правилам рабочих часов. Результат появится в анкете.</p></section>}
        <p className="quiet warn">{channels.length === 2 ? "Будут созданы SMS и звонок ассистента." : channels[0] === "SMS" ? "Будет создана отправка SMS." : "Будет создан один звонок ассистента."} Пока вы не нажали кнопку отправки, кандидат ничего не получит.</p>
      </> : <>
        {purpose === "INVITE" ? <>
          <label className="fld"><span className="lab">Дата и время собеседования</span><input type="datetime-local" value={interviewAt} min={interviewIsoToInput(new Date())} required onChange={event => setInterviewAt(event.target.value)} /><span className="msg">Время Душанбе, UTC+5</span></label>
          <label className="fld"><span className="lab">Адрес встречи</span><textarea rows={2} value={address} required maxLength={300} onChange={event => { setAddress(event.target.value); setAddressEdited(true); }} /></label>
          <label className="fld"><span className="lab">Ссылка на точку на карте</span><input type="url" value={mapUrl} maxLength={1000} onChange={event => setMapUrl(event.target.value)} placeholder="https://…" /><span className="msg">Google Maps, Яндекс Карты или 2ГИС. Проверьте, что точка указана верно.</span></label>
          <label className="fld"><span className="lab">Что подготовить</span><textarea rows={3} value={preparation} maxLength={1000} onChange={event => setPreparation(event.target.value)} placeholder="По желанию: что посмотреть или подготовить к встрече" /></label>
        </> : <p className="quiet warn">Ассистент уточнит недостающие сведения по правилам этой вакансии. Собеседование не назначается; решение остаётся за руководителем.</p>}
        <label className="fld"><span className="lab">Язык общения</span><select value={language} required onChange={event => changeLanguage(event.target.value as "ru" | "tg" | "")}><option value="">Выберите язык</option><option value="ru">Русский</option><option value="tg">Тоҷикӣ</option></select></label>
        <fieldset className="grid gap-2"><legend className="text-[14px] text-gray-500">{purpose === "INVITE" ? "Как пригласить" : "Как уточнить"}</legend>
          <label className="chk" style={{ alignItems: "flex-start", gap: 10 }}><input type="checkbox" disabled={!options.sms.available} checked={channels.includes("SMS")} onChange={event => changeChannel("SMS", event.target.checked)} /><span className="grid"><strong>SMS</strong><span className="text-[14px] text-gray-500">{options.sms.available ? "Текст с деталями на указанный номер" : options.sms.reason || "SMS недоступны"}</span></span></label>
          <label className="chk" style={{ alignItems: "flex-start", gap: 10 }}><input type="checkbox" disabled={!options.assistantCall.available} checked={channels.includes("ASSISTANT_CALL")} onChange={event => changeChannel("ASSISTANT_CALL", event.target.checked)} /><span className="grid"><strong>Звонок ассистента</strong><span className="text-[14px] text-gray-500">{options.assistantCall.available ? purpose === "INVITE" ? "Позвонит и пригласит на встречу" : "Позвонит и уточнит недостающие ответы" : options.assistantCall.reason || "Звонок недоступен"}</span></span></label>
        </fieldset>
      </>}
      {error && <p className="quiet crit" role="alert">{error}</p>}
      <MutationError mutation={previewMutation} fallback={purpose === "INVITE" ? "Не удалось подготовить приглашение" : "Не удалось подготовить вопросы"} />
      {confirmMutation.isError && !attempted && <p className="quiet crit" role="alert">Отправка не принята: {confirmMutation.error.message}. Исправьте данные или вернитесь к форме.</p>}
      {confirmMutation.isError && attempted && <div className="quiet warn" role="alert"><p>Результат отправки нужно проверить. Не создавайте повторную отправку, пока статус неизвестен.</p><p>{confirmMutation.error.message}</p><button type="button" className="pill ghost" onClick={() => void recent.refetch()}>Проверить статус</button><DeliveryList deliveries={recent.data?.recentDeliveries ?? []} /></div>}
    </div>
  </Rh2Sheet>;
}

export function DeliveryList({ deliveries }: { deliveries: RecruitmentContactConfirmation["deliveries"] }) {
  return <ul className="grid gap-2">{deliveries.map(delivery => <li key={delivery.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[14px] bg-row-alt px-4 py-3 text-[15px]"><strong>{delivery.channel === "SMS" ? "SMS" : "Звонок ассистента"}</strong><span className="text-gray-700">{RECRUITMENT_DELIVERY_LABEL[delivery.status]}</span>{delivery.reason && <span className="basis-full text-[14px] text-gray-500">{delivery.reason}</span>}</li>)}</ul>;
}

export function AssistantFindings({ deliveries }: { deliveries: RecruitmentContactConfirmation["deliveries"] }) {
  const calls = deliveries.filter(delivery => delivery.channel === "ASSISTANT_CALL" && delivery.result);
  if (!calls.length) return null;
  return <section className="grid gap-3" aria-label="Что собрал ассистент"><h3>Что собрал ассистент</h3>
    {calls.map(call => call.result && <article className="grid gap-2 rounded-[14px] bg-row-alt p-4" key={call.id}>
      <h4>{call.result.purpose === "CLARIFY" ? "Уточнение анкеты" : "Ответ на приглашение"}</h4>
      {call.result.candidateSpoke ? <><p>{call.result.summary}</p><p className="text-[14px] text-gray-500">Сведения из разговора. Проверьте их перед решением — это не подтверждённые руководителем факты.</p></>
        : <><p>Ответов кандидата нет.</p><p className="text-[14px] text-gray-500">{call.result.summary}</p></>}
      {call.reason && <p className="text-[14px] text-gray-500">{call.reason}</p>}
      {call.result.transcript.length > 0 && <details><summary>Фрагменты разговора</summary><ul>{call.result.transcript.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
    </article>)}
  </section>;
}
