import { useState } from "react";
import type { PropertyNarrationView } from "@royal-home/shared";
import { api } from "../lib/api";
import { PublicationMetadataReconcile, type MetadataAttemptSummary } from "./PublicationMetadataReconcile";

/**
 * СЛУЖЕБНОЕ ОЗВУЧКИ ОБЪЕКТА — только маркетинг и руководство (14.11.2026).
 *
 * Владелец: «в настройках объекта технического вообще не должно быть». Общие настройки
 * (модель, голоса, шаблоны, пределы) уехали в Настройки CRM; здесь осталось то, что привязано
 * к ОДНОМУ объекту и нужно руководству редко: ручной путь «подтвердить текст → сгенерировать»
 * (когда автоозвучка выключена), передача монтажёру, сверки неизвестного результата, отчёт
 * собственнику и площадки. Агент этот блок не видит вовсе; маркетинг видит его свёрнутым.
 * Перенесено из PropertyNarrationManager без изменения запросов.
 */
const DELIVERY_STATUS: Record<string, string> = { PREVIEW: "Предварительный просмотр · не отправлено", QUEUED: "В очереди", SENDING: "Передаётся", SENT: "Принято сервисом · получение человеком не подтверждено", DELIVERED: "Провайдер подтвердил доставку", NOT_DELIVERED: "Провайдер сообщил: не доставлено", UNKNOWN: "Результат неизвестен · повтор отключён", FAILED: "Отказ или завершённая сверка", CANCELLED: "Остановлено: данные изменились" };

export function PropertyNarrationService({ propertyId, data, busy, run, setMessage, onListen }: {
  propertyId: string;
  data: PropertyNarrationView;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  setMessage: (text: string) => void;
  onListen: (versionId: string) => void;
}) {
  const latest = data.versions[0];
  const [confirmed, setConfirmed] = useState(false), [audioReviewed, setAudioReviewed] = useState(false);
  const [handoffMode, setHandoffMode] = useState<"WITH_SOURCES" | "AUDIO_ONLY">("WITH_SOURCES");
  const [reconcileNote, setReconcileNote] = useState(""), [providerChecked, setProviderChecked] = useState(false);
  const [deliveryChecked, setDeliveryChecked] = useState(false), [deliveryNote, setDeliveryNote] = useState("");
  const [publicationRows, setPublicationRows] = useState<Array<MetadataAttemptSummary & { reason: string }>>([]);
  async function loadPublicationRows() {
    const result = await api<{ rows: typeof publicationRows; deliveryRows?: typeof publicationRows }>(`/properties/${propertyId}/narration/publication-preview`, { method: "POST", body: {} });
    setPublicationRows([...(result.deliveryRows ?? []), ...result.rows]);
    return result;
  }
  const uncertain = [...(data.deliveries ?? []).map((d) => ({ ...d, kind: "NARRATION" })), ...(data.ownerReport?.deliveries ?? []).map((d) => ({ ...d, kind: "OWNER_REPORT" }))].filter((d) => ["UNKNOWN", "SENDING"].includes(d.status));

  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">Служебное: маркетинг и руководство</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-slate-600">Голоса, шаблоны, модель и пределы расхода: Настройки → Каналы → «Озвучка роликов».</p>
        {!data.configured && <p className="rounded-lg bg-amber-50 p-3 text-sm" role="status">Генерация пока недоступна: в настройках нет ключа ElevenLabs, модели или голосов.</p>}
        {data.quotaExceeded && <p className="rounded-lg bg-amber-50 p-3 text-sm" role="status">Кредиты ElevenLabs закончились. Озвучки ждут пополнения, проверка раз в час.</p>}
        {data.mix?.error && <p className="rounded-lg bg-amber-50 p-3 text-sm" role="status">Новую озвучку на ролик наложить не получилось: {data.mix.error}</p>}

        {data.canApprove && latest && latest.status === "DRAFT" && !latest.generateAfter && <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="text-sm">Ручной путь: подтвердить текст и сгенерировать</legend>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />Я проверил факты, цену и текст версии {latest.revision}.</label>
          <div className="flex flex-wrap gap-2">
            <button className="pill sm" type="button" disabled={busy || !confirmed || latest.stale || !!latest.approvedAt} onClick={() => void run(async () => { await api(`/properties/${propertyId}/narration/${latest.id}/approve`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true } }); setMessage("Текст подтверждён."); })}>Подтвердить текст</button>
            <button className="pill sm" type="button" disabled={busy || !confirmed || !latest.approvedAt || latest.stale || !data.configured} onClick={() => void run(async () => { const result = await api<{ propertyTrashed?: boolean; message?: string }>(`/properties/${propertyId}/narration/${latest.id}/generate`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true }, timeoutMs: 75_000 }); setMessage(result.propertyTrashed ? result.message ?? "Объект в Корзине. Аудио сохранено в истории." : "Аудио готово. Прослушайте перед передачей."); })}>Сгенерировать в ElevenLabs</button>
          </div>
        </fieldset>}

        {data.versions.some((v) => v.hasAudio) && <div className="space-y-1">
          <p className="text-sm font-medium">История аудио</p>
          {data.versions.filter((v) => v.hasAudio).map((v) => <div key={v.id} className="flex flex-wrap items-center gap-2 text-sm"><span>Версия {v.revision}{v.stale ? " · старые факты" : ""}{v.approvedAt ? " · одобрена" : ""}</span><button className="pill sm" disabled={busy} type="button" onClick={() => onListen(v.id)}>Прослушать</button></div>)}
        </div>}

        {data.canApprove && latest?.hasAudio && !latest.stale && <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="text-sm">Передача монтажёру вручную</legend>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={audioReviewed} onChange={(e) => setAudioReviewed(e.target.checked)} />Я прослушал текущую версию аудио и проверил произношение</label>
          <label className="block text-sm">Передать монтажёру <select className="rounded border p-2" value={handoffMode} onChange={(e) => setHandoffMode(e.target.value as "WITH_SOURCES" | "AUDIO_ONLY")}><option value="WITH_SOURCES">Исходники и озвучку</option><option value="AUDIO_ONLY">Только новую озвучку</option></select></label>
          <button className="pill sm" type="button" disabled={busy || !audioReviewed} onClick={() => void run(async () => {
            await api(`/properties/${propertyId}/narration/${latest.id}/handoff-preview`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true, audioReviewed: true, requestKey: crypto.randomUUID(), mode: handoffMode } });
            setMessage("Предварительное задание для монтажёра сохранено. Отправка отключена.");
          })}>Подготовить передачу монтажёру</button>
        </fieldset>}

        {!!data.deliveries?.length && <div className="space-y-2"><p className="text-sm font-medium">Передачи монтажёру</p>{data.deliveries.map((d) => <div key={d.id} className="rounded border p-2 text-sm"><p>{d.mode === "AUDIO_ONLY" ? "Озвучка и текст" : "Озвучка, текст и исходники"} · {DELIVERY_STATUS[d.status] ?? d.status}</p>{d.lastError && <p>{d.lastError}</p>}
          {data.canApprove && data.sendsEnabled && d.status === "PREVIEW" && d.planHash && <button className="pill sm" disabled={busy} onClick={() => void run(async () => { await api(`/properties/${propertyId}/narration/deliveries/${d.id}/queue`, { method: "POST", body: { confirmed: true, planHash: d.planHash } }); setMessage("Передача поставлена в очередь. Квитанции появятся после выполнения."); })}>Подтвердить отправку этого плана</button>}
        </div>)}</div>}

        {data.canApprove && <div className="space-y-2">
          <p className="text-sm font-medium">Площадки и ежемесячный отчёт собственнику</p>
          <div className="flex flex-wrap gap-2">
            <button className="pill sm" disabled={busy} type="button" onClick={() => void run(async () => { const result = await loadPublicationRows(); setMessage(result.deliveryRows?.length ? "Показаны результаты доставки и предварительный план." : result.rows.length ? "Предварительный план готов." : "У объекта пока нет опубликованных площадок."); })}>Проверить обновление площадок</button>
            <button className="pill sm" disabled={busy} type="button" onClick={() => void run(async () => { const result = await api<{ message: string }>(`/properties/${propertyId}/narration/owner-report-preview`, { method: "POST", body: { ownerRequested: true } }); setMessage(result.message); })}>{data.ownerReportsEnabled ? "Собственник согласовал ежемесячную SMS-доставку — включить для объекта" : "Собственник согласовал ежемесячный отчёт — подготовить"}</button>
            {data.ownerReport?.active && <button className="pill sm" disabled={busy} type="button" onClick={() => void run(async () => { await api(`/properties/${propertyId}/narration/owner-report-revoke`, { method: "POST", body: { confirmed: true } }); setMessage("Согласие отозвано. Следующие отправки остановлены."); })}>Отозвать согласие на отчёты</button>}
          </div>
          {data.ownerReport && <div className="text-sm"><p>Ежемесячные отчёты: {data.ownerReport.active ? "согласованы" : "нет действующего согласия"} · {data.ownerReport.executionMode === "LIVE" ? "доставка разрешена сервером" : "только предварительный просмотр"}</p>{data.ownerReport.deliveries.map((d) => <p key={d.id}>{d.period}: {DELIVERY_STATUS[d.status] ?? d.status}{d.lastError ? ` · ${d.lastError}` : ""}</p>)}</div>}
          {publicationRows.map((row) => <p className="text-sm" key={row.id ?? `${row.channel}-${row.operation}`}>
            {row.channel === "*" ? "Все площадки" : row.channel} · {row.executionMode === "PRICE_CHANGE" ? "цена в описании" : row.operation === "COVER" ? "обложка" : "описание"}: {row.reason}
            {row.postUrl && <> · <a className="underline" href={row.postUrl} target="_blank" rel="noreferrer">Открыть пост</a></>}
          </p>)}
          <PublicationMetadataReconcile propertyId={propertyId} rows={publicationRows} onChanged={() => void run(async () => { await loadPublicationRows(); })} />
        </div>}

        {data.canConfigure && data.versions.some((v) => v.canReconcile) && <fieldset className="space-y-2 rounded-lg border border-amber-200 p-3"><legend className="text-sm">Проверка неизвестного результата</legend>
          <p className="text-sm">Проверьте историю ElevenLabs. Если пригодного аудио нет, зафиксируйте это здесь. Возможное списание сохраняется; автоматического повтора не будет.</p>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={providerChecked} onChange={(e) => setProviderChecked(e.target.checked)} />История провайдера проверена, пригодного аудио нет</label>
          <label className="block text-sm">Результат проверки<textarea className="mt-1 w-full rounded border p-2" minLength={20} maxLength={2000} value={reconcileNote} onChange={(e) => setReconcileNote(e.target.value)} /></label>
          {data.versions.filter((v) => v.canReconcile).map((v) => <button key={v.id} type="button" className="pill sm" disabled={busy || !providerChecked || reconcileNote.trim().length < 20} onClick={() => void run(async () => {
            await api(`/properties/${propertyId}/narration/${v.id}/reconcile`, { method: "POST", body: { expectedRevision: v.revision, checkedProviderHistory: true, note: reconcileNote } });
            setProviderChecked(false); setReconcileNote(""); setMessage("Проверка сохранена. Новый платный запрос не отправлялся.");
          })}>Зафиксировать проверку версии {v.revision}</button>)}
        </fieldset>}

        {data.canConfigure && uncertain.length > 0 && <fieldset className="space-y-2 rounded border p-3"><legend className="text-sm">Сверка неопределённой доставки</legend>
          <p className="text-sm">Проверьте историю Telegram или SMS. Сверка сохраняет квитанции и не отменяет возможное списание.</p>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={deliveryChecked} onChange={(e) => setDeliveryChecked(e.target.checked)} />Я проверил историю у провайдера</label>
          <textarea className="w-full rounded border p-2" aria-label="Результат сверки доставки" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} minLength={20} maxLength={2000} placeholder="Что проверено и что обнаружено (от 20 символов)" />
          {uncertain.map((d) => <button key={d.id} className="pill sm" disabled={busy || !deliveryChecked || deliveryNote.trim().length < 20} onClick={() => void run(async () => { const result = await api<{ message: string }>(`/properties/${propertyId}/narration/delivery-reconcile`, { method: "POST", body: { kind: d.kind, deliveryId: d.id, checkedProviderHistory: true, note: deliveryNote } }); setMessage(result.message); })}>Сохранить сверку {d.kind === "NARRATION" ? "передачи монтажёру" : "SMS"} · {d.id.slice(0, 8)}</button>)}
        </fieldset>}
        <p className="text-sm text-slate-600">Предварительные планы сами не отправляются при включении сервера. Принятие сервисом не означает, что человек просмотрел материал.</p>
      </div>
    </details>
  );
}
