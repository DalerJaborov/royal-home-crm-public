import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NARRATION_TAJIK_MODELS, type NarrationConfig, type NarrationTemplate, type PropertyNarrationView } from "@royal-home/shared";
import { api } from "../lib/api";
import { PublicationMetadataReconcile, type MetadataAttemptSummary } from "./PublicationMetadataReconcile";

const STATUS: Record<string, string> = { DRAFT: "Черновик", GENERATING: "Генерируется", READY: "Аудио готово", FAILED: "Ошибка генерации", UNKNOWN: "Результат требует проверки в ElevenLabs" };
const DELIVERY_STATUS: Record<string, string> = { PREVIEW: "Предварительный просмотр · не отправлено", QUEUED: "В очереди", SENDING: "Передаётся", SENT: "Принято сервисом · получение человеком не подтверждено", DELIVERED: "Провайдер подтвердил доставку", NOT_DELIVERED: "Провайдер сообщил: не доставлено", UNKNOWN: "Результат неизвестен · повтор отключён", FAILED: "Отказ или завершённая сверка", CANCELLED: "Остановлено: данные изменились" };

export function PropertyNarrationManager({ propertyId }: { propertyId: string }) {
  const client = useQueryClient();
  const key = ["property-narration", propertyId];
  const { data, error, isPending } = useQuery({ queryKey: key, queryFn: () => api<PropertyNarrationView>(`/properties/${propertyId}/narration`), retry: false });
  const [script, setScript] = useState<string | null>(null), [voiceId, setVoiceId] = useState("");
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [audioReviewed, setAudioReviewed] = useState(false);
  const [handoffMode, setHandoffMode] = useState<"WITH_SOURCES" | "AUDIO_ONLY">("WITH_SOURCES");
  const [monthlyPreview, setMonthlyPreview] = useState<boolean | null>(null);
  const [reconcileNote, setReconcileNote] = useState("");
  const [providerChecked, setProviderChecked] = useState(false);
  const [deliveryChecked, setDeliveryChecked] = useState(false), [deliveryNote, setDeliveryNote] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null), [settingsOpen, setSettingsOpen] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null), [voicesText, setVoicesText] = useState<string | null>(null);
  const [autoGenerate, setAutoGenerate] = useState<boolean | null>(null), [limitsText, setLimitsText] = useState<{ chars?: string; gens?: string; pause?: string }>({});
  const [templatesDraft, setTemplatesDraft] = useState<NarrationTemplate[] | null>(null);
  const [publicationRows, setPublicationRows] = useState<Array<MetadataAttemptSummary & { reason: string }>>([]);
  const draftKey = useRef(crypto.randomUUID());
  const latest = data?.versions[0];
  const shownScript = script ?? latest?.script ?? data?.suggestedScript ?? "";
  const selectedVoice = voiceId || latest?.voiceId || "";
  const edited = shownScript !== latest?.script || selectedVoice !== (latest?.voiceId ?? "");
  useEffect(() => { setAudioReviewed(false); }, [latest?.id]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => { setScript(null); setVoiceId(""); setConfirmed(false); setAudioUrl(null); draftKey.current = crypto.randomUUID(); }, [propertyId]);
  async function loadPublicationRows() {
    const result = await api<{ rows: typeof publicationRows; deliveryRows?: typeof publicationRows }>(
      `/properties/${propertyId}/narration/publication-preview`, { method: "POST", body: {} }
    );
    setPublicationRows([...(result.deliveryRows ?? []), ...result.rows]);
    return result;
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); await client.invalidateQueries({ queryKey: key }); }
    catch (err) { setMessage(err instanceof Error ? err.message : "Действие не выполнено"); }
    finally { setBusy(false); }
  }

  if (isPending) return <section className="card p-4" aria-busy="true">Загружаем озвучку…</section>;
  if (error || !data) return <section className="card p-4" role="status">Озвучка недоступна: {error instanceof Error ? error.message : "не удалось загрузить"}</section>;
  return <section className="card space-y-3 p-4" aria-label="Озвучка объекта">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Озвучка объекта</h3>
      {data.canConfigure && <button type="button" className="pill sm" onClick={() => setSettingsOpen(!settingsOpen)}>Настройки голосов</button>}</div>
    <p className="text-sm text-slate-600">Проверьте факты, сохраните текст и передайте его на подтверждение маркетингу. Цена остаётся в описании под видео.</p>
    {!data.configured && <p className="rounded-lg bg-amber-50 p-3 text-sm" role="status">Генерация пока недоступна. Руководству нужно настроить ключ ElevenLabs, модель и список голосов. Черновик можно сохранить сейчас.</p>}
    {data.canConfigure && settingsOpen && <fieldset className="space-y-2 rounded-lg border p-3"><legend>ElevenLabs · сохраняет директор или администратор</legend>
      {data.readiness && <p className="text-sm">Ключ: {data.readiness.apiKeyConfigured ? "настроен" : "не настроен"} · модель: {data.readiness.modelConfigured ? "выбрана" : "не выбрана"} · голосов: {data.readiness.voiceCount}</p>}
      <label className="block text-sm">Модель озвучки<select className="mt-1 w-full rounded border p-2" value={modelId ?? data.config.modelId} onChange={(e) => setModelId(e.target.value)}>
        {!(modelId ?? data.config.modelId) && <option value="">Выберите модель</option>}
        {NARRATION_TAJIK_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        {(modelId ?? data.config.modelId) && !NARRATION_TAJIK_MODELS.some((m) => m.id === (modelId ?? data.config.modelId)) && <option value={modelId ?? data.config.modelId}>{modelId ?? data.config.modelId} (без таджикского)</option>}
      </select></label>
      <label className="block text-sm">Голоса: одна строка «ID | название | м или ж»<textarea className="mt-1 min-h-24 w-full rounded border p-2" value={voicesText ?? voiceLines(data.config)} onChange={(e) => setVoicesText(e.target.value)} /></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={autoGenerate ?? !!data.config.autoGenerate} onChange={(e) => setAutoGenerate(e.target.checked)} />Автоозвучка: готовить аудио сразу после создания объекта и после правки его данных, агент одобряет сам</label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-sm">Символов в сутки<input inputMode="numeric" className="mt-1 w-full rounded border p-2" value={limitsText.chars ?? String(data.config.dailyCharLimit ?? 20000)} onChange={(e) => setLimitsText({ ...limitsText, chars: e.target.value })} /></label>
        <label className="block text-sm">Озвучек в сутки<input inputMode="numeric" className="mt-1 w-full rounded border p-2" value={limitsText.gens ?? String(data.config.dailyGenerationLimit ?? 40)} onChange={(e) => setLimitsText({ ...limitsText, gens: e.target.value })} /></label>
        <label className="block text-sm">Пауза после правки, мин<input inputMode="numeric" className="mt-1 w-full rounded border p-2" value={limitsText.pause ?? String(data.config.debounceMinutes ?? 3)} onChange={(e) => setLimitsText({ ...limitsText, pause: e.target.value })} /></label>
      </div>
      {data.budget && <p className="text-sm">Сегодня потрачено: {data.budget.usedChars} из {data.budget.dailyChars} символов, {data.budget.usedGenerations} из {data.budget.dailyGenerations} озвучек.</p>}
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Шаблоны текста</legend>
        <p className="text-sm text-slate-600">Слова в фигурных скобках подставляются из объекта: {"{вид} {комнаты} {площадь} {этаж} {этаж_пор} {этажей} {район}"}. Квадратные скобки означают «если есть».</p>
        {(templatesDraft ?? data.config.templates ?? []).map((t, i, all) => <div key={t.id} className="space-y-1 rounded border p-2">
          <div className="flex flex-wrap gap-2"><input aria-label="Название шаблона" className="flex-1 rounded border p-2 text-sm" value={t.name} onChange={(e) => setTemplatesDraft(all.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <select aria-label="Язык шаблона" className="rounded border p-2 text-sm" value={t.lang} onChange={(e) => setTemplatesDraft(all.map((x, j) => j === i ? { ...x, lang: e.target.value as "tg" | "ru" } : x))}><option value="tg">по-таджикски</option><option value="ru">по-русски</option></select>
            <button type="button" className="pill sm" onClick={() => setTemplatesDraft(all.filter((_, j) => j !== i))}>Убрать</button></div>
          <textarea aria-label="Текст шаблона" rows={4} className="w-full rounded border p-2 text-sm" value={t.text} onChange={(e) => setTemplatesDraft(all.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} />
        </div>)}
        <button type="button" className="pill sm" onClick={() => { const all = templatesDraft ?? data.config.templates ?? []; setTemplatesDraft([...all, { id: `t-${Date.now().toString(36)}`, name: "Новый шаблон", lang: "tg", text: "{вид} барои фурӯш. Масоҳаташ {площадь} метри мураббаъ." }]); }}>Добавить шаблон</button>
      </fieldset>
      <p className="text-xs text-slate-600">Ключ ElevenLabs хранится в общих настройках CRM. Число голосов не ограничено двумя.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={monthlyPreview ?? !!data.config.ownerReportPreviewEnabled} onChange={(e) => setMonthlyPreview(e.target.checked)} />Готовить черновик каждого месяца для уже согласованных отчётов. SMS не отправлять.</label>
      <button className="pill" type="button" disabled={busy || data.canDraft === false} onClick={() => void run(async () => {
        const voices = parseVoiceLines(voicesText ?? voiceLines(data.config));
        const number = (text: string | undefined, fallback: number | undefined) => text === undefined ? fallback : Math.max(0, Math.round(Number(text) || 0));
        const config: Partial<NarrationConfig> = { modelId: modelId ?? data.config.modelId, voices, ownerReportPreviewEnabled: monthlyPreview ?? !!data.config.ownerReportPreviewEnabled,
          autoGenerate: autoGenerate ?? !!data.config.autoGenerate, dailyCharLimit: number(limitsText.chars, data.config.dailyCharLimit), dailyGenerationLimit: number(limitsText.gens, data.config.dailyGenerationLimit),
          debounceMinutes: number(limitsText.pause, data.config.debounceMinutes), ...(templatesDraft ? { templates: templatesDraft } : {}) };
        await api("/properties/narration-settings", { method: "PUT", body: config }); setMessage("Настройки сохранены. Провайдер не вызывался.");
      })}>Сохранить настройки</button></fieldset>}
    <label className="block text-sm">Текст диктора<textarea readOnly={data.canDraft === false} maxLength={5000} rows={7} className="mt-1 w-full rounded-lg border p-3" value={shownScript} onChange={(e) => { setScript(e.target.value); setConfirmed(false); }} /></label>
    <div className="flex flex-wrap items-center gap-3"><label className="text-sm">Голос <select disabled={data.canDraft === false} className="rounded border p-2" value={selectedVoice} onChange={(e) => { setVoiceId(e.target.value); setConfirmed(false); }}><option value="">Выберите голос</option>{data.config.voices.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label><span className="text-xs text-slate-500">{shownScript.length}/5000</span></div>
    {data.canApproveAudio && latest && latest.source && latest.source !== "MANUAL" && <div className="space-y-2 rounded-lg border border-blue-200 p-3">
      {latest.status === "DRAFT" && latest.generateAfter && <p className="text-sm" role="status">Озвучка готовится. Придёт вам на прослушивание здесь и в Шабнам.</p>}
      {latest.status === "READY" && !latest.approvedAt && !latest.stale && <><p className="text-sm font-medium">Озвучка ждёт вашего одобрения</p>
        <div className="flex flex-wrap gap-2"><button className="pill" type="button" disabled={busy} onClick={() => void run(async () => { const blob = await api<Blob>(`/properties/${propertyId}/narration/${latest.id}/audio`, { responseType: "blob" }); setAudioUrl(URL.createObjectURL(blob)); })}>Прослушать</button>
          <button className="pill" type="button" disabled={busy || edited} onClick={() => void run(async () => { await api(`/properties/${propertyId}/narration/${latest.id}/approve`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true } }); setMessage("Озвучка одобрена. Монтажёр получит её вместе с заданием на ролик."); })}>Одобрить</button></div>
        <p className="text-sm text-slate-600">Не нравится текст или голос: поправьте ниже и нажмите «Озвучить заново».</p></>}
      {latest.status === "READY" && latest.approvedAt && <p className="text-sm">Одобрено. Монтажёр получает аудио вместе с заданием на ролик.</p>}
      {data.autoGenerate && data.canDraft !== false && <button className="pill" type="button" disabled={busy || !edited} onClick={() => void run(async () => {
        await api(`/properties/${propertyId}/narration`, { method: "POST", body: { expectedRevision: latest.revision, requestKey: draftKey.current, script: shownScript, generate: true, ...(selectedVoice ? { voiceId: selectedVoice } : {}) } });
        draftKey.current = crypto.randomUUID(); setScript(null); setVoiceId(""); setMessage("Готовлю новую озвучку. Придёт на прослушивание через минуту-две.");
      })}>Озвучить заново</button>}
    </div>}
    {latest && <p className="text-sm">Версия {latest.revision} · {STATUS[latest.status] ?? latest.status}{latest.approvedAt ? " · текст подтверждён" : ""}{latest.stale ? " · факты объекта изменились, подготовьте новую версию" : ""}</p>}
    {data.canConfigure && data.versions.some(v => v.canReconcile) && <fieldset className="space-y-2 rounded-lg border border-amber-200 p-3"><legend>Проверка неизвестного результата</legend>
      <p className="text-sm">Проверьте историю ElevenLabs. Если пригодного аудио нет, зафиксируйте это здесь. Возможное списание сохраняется; автоматического повтора не будет. Для новой попытки понадобятся новая версия и отдельный платный запрос.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={providerChecked} onChange={e => setProviderChecked(e.target.checked)} />История провайдера проверена, пригодного аудио нет</label>
      <label className="block text-sm">Результат проверки<textarea className="mt-1 w-full rounded border p-2" minLength={20} maxLength={2000} value={reconcileNote} onChange={e => setReconcileNote(e.target.value)} /></label>
      {data.versions.filter(v => v.canReconcile).map(v => <button key={v.id} type="button" className="pill sm" disabled={busy || !providerChecked || reconcileNote.trim().length < 20} onClick={() => void run(async () => {
        await api(`/properties/${propertyId}/narration/${v.id}/reconcile`, { method: "POST", body: { expectedRevision: v.revision, checkedProviderHistory: true, note: reconcileNote } });
        setProviderChecked(false); setReconcileNote(""); setMessage("Проверка сохранена. Новый платный запрос не отправлялся.");
      })}>Зафиксировать проверку версии {v.revision}</button>)}</fieldset>}
    <div className="flex flex-wrap gap-2">
      <button className="pill" type="button" disabled={busy || data.canDraft === false} onClick={() => void run(async () => {
        await api(`/properties/${propertyId}/narration`, { method: "POST", body: { expectedRevision: latest?.revision ?? 0, requestKey: draftKey.current, script: shownScript, ...(selectedVoice ? { voiceId: selectedVoice } : {}) } });
        draftKey.current = crypto.randomUUID(); setScript(null); setVoiceId(""); setConfirmed(false); setMessage("Новая версия сохранена.");
      })}>Сохранить новую версию</button>
      <button className="pill" type="button" disabled={busy || data.canDraft === false} onClick={() => { setScript(data.suggestedScript); setConfirmed(false); }}>Текст по текущим фактам</button>
    </div>
    {data.canApprove && latest && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />Я проверил факты и текст. Цена не произносится.</label>
      <div className="flex flex-wrap gap-2"><button className="pill" type="button" disabled={busy || edited || !confirmed || latest.stale || latest.status !== "DRAFT"} onClick={() => void run(async () => { await api(`/properties/${propertyId}/narration/${latest.id}/approve`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true } }); setMessage("Текст подтверждён."); })}>Подтвердить текст</button>
      <button className="pill" type="button" disabled={busy || edited || !confirmed || !latest.approvedAt || latest.stale || latest.status !== "DRAFT" || !data.configured} onClick={() => void run(async () => { const result = await api<{ propertyTrashed?: boolean; message?: string }>(`/properties/${propertyId}/narration/${latest.id}/generate`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true }, timeoutMs: 75_000 }); setMessage(result.propertyTrashed ? result.message ?? "Объект в Корзине. Аудио сохранено в истории." : "Аудио готово. Прослушайте перед передачей."); })}>Сгенерировать в ElevenLabs</button></div></>}
    {data.versions.filter((v) => v.hasAudio).map((v) => <div key={v.id} className="flex flex-wrap items-center gap-2 text-sm"><span>Аудио · версия {v.revision}{v.stale ? " · старые факты" : ""}</span><button className="pill sm" disabled={busy} type="button" onClick={() => void run(async () => { const blob = await api<Blob>(`/properties/${propertyId}/narration/${v.id}/audio`, { responseType: "blob" }); setAudioUrl(URL.createObjectURL(blob)); })}>Прослушать</button></div>)}
    {audioUrl && <audio className="w-full" controls src={audioUrl} />}
    {data.canApprove && latest?.hasAudio && !latest.stale && <><label className="flex gap-2 text-sm"><input type="checkbox" checked={audioReviewed} onChange={(e) => setAudioReviewed(e.target.checked)} />Я прослушал текущую версию аудио и проверил произношение</label>
    <label className="block text-sm">Передать монтажёру <select className="rounded border p-2" value={handoffMode} onChange={(e) => setHandoffMode(e.target.value as "WITH_SOURCES" | "AUDIO_ONLY")}><option value="WITH_SOURCES">Исходники и озвучку</option><option value="AUDIO_ONLY">Только новую озвучку</option></select></label><button className="pill" type="button" disabled={busy || edited || !audioReviewed} onClick={() => void run(async () => {
      await api(`/properties/${propertyId}/narration/${latest.id}/handoff-preview`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true, audioReviewed: true, requestKey: crypto.randomUUID(), mode: handoffMode } }); setMessage("Предварительное задание для монтажёра сохранено. Отправка отключена.");
    })}>Подготовить передачу монтажёру</button></>}
    {!!data.deliveries?.length && <div className="space-y-2"><h4 className="text-sm font-medium">Передачи монтажёру</h4>{data.deliveries.map(d => <div key={d.id} className="rounded border p-2 text-sm"><p>{d.mode === "AUDIO_ONLY" ? "Озвучка и текст" : "Озвучка, текст и исходники"} · {DELIVERY_STATUS[d.status] ?? d.status}</p>{d.lastError && <p>{d.lastError}</p>}
      {data.canApprove && data.sendsEnabled && d.status === "PREVIEW" && d.planHash && <button className="pill sm" disabled={busy} onClick={() => void run(async () => { await api(`/properties/${propertyId}/narration/deliveries/${d.id}/queue`, { method: "POST", body: { confirmed: true, planHash: d.planHash } }); setMessage("Передача поставлена в очередь. Квитанции появятся после выполнения."); })}>Подтвердить отправку этого плана</button>}
    </div>)}</div>}
    {data.canApprove && <details><summary className="cursor-pointer text-sm">Публикации и ежемесячный отчёт · предварительный просмотр</summary><div className="mt-2 flex flex-wrap gap-2">
      <button className="pill sm" disabled={busy} type="button" onClick={() => void run(async () => { const result = await loadPublicationRows(); setMessage(result.deliveryRows?.length ? "Показаны результаты доставки и предварительный план." : result.rows.length ? "Предварительный план готов." : "У объекта пока нет опубликованных площадок."); })}>Проверить обновление площадок</button>
      <button className="pill sm" disabled={busy} type="button" onClick={() => void run(async () => { const result = await api<{ message: string }>(`/properties/${propertyId}/narration/owner-report-preview`, { method: "POST", body: { ownerRequested: true } }); setMessage(result.message); })}>{data.ownerReportsEnabled ? "Собственник согласовал ежемесячную SMS-доставку — включить для объекта" : "Собственник согласовал ежемесячный отчёт — подготовить"}</button>
      {data.ownerReport?.active && <button className="pill sm" disabled={busy} type="button" onClick={() => void run(async () => { await api(`/properties/${propertyId}/narration/owner-report-revoke`, { method: "POST", body: { confirmed: true } }); setMessage("Согласие отозвано. Следующие отправки остановлены."); })}>Отозвать согласие на отчёты</button>}</div>
      {data.ownerReport && <div className="mt-2 text-sm"><p>Ежемесячные отчёты: {data.ownerReport.active ? "согласованы" : "нет действующего согласия"} · {data.ownerReport.executionMode === "LIVE" ? "доставка разрешена сервером" : "только предварительный просмотр"}</p>{data.ownerReport.deliveries.map(d => <p key={d.id}>{d.period}: {DELIVERY_STATUS[d.status] ?? d.status}{d.lastError ? ` · ${d.lastError}` : ""}</p>)}</div>}
      {publicationRows.map((row) => <p className="mt-2 text-sm" key={row.id ?? `${row.channel}-${row.operation}`}>
        {row.channel === "*" ? "Все площадки" : row.channel} · {row.executionMode === "PRICE_CHANGE" ? "цена в описании" : row.operation === "COVER" ? "обложка" : "описание"}: {row.reason}
        {row.postUrl && <> · <a className="underline" href={row.postUrl} target="_blank" rel="noreferrer">Открыть пост</a></>}
      </p>)}
      <PublicationMetadataReconcile propertyId={propertyId} rows={publicationRows} onChanged={() => void run(async () => { await loadPublicationRows(); })} /></details>}
    {data.canConfigure && [...(data.deliveries ?? []).map(d => ({ ...d, kind: "NARRATION" })), ...(data.ownerReport?.deliveries ?? []).map(d => ({ ...d, kind: "OWNER_REPORT" }))].some(d => ["UNKNOWN", "SENDING"].includes(d.status)) && <fieldset className="space-y-2 rounded border p-3"><legend>Сверка неопределённой доставки</legend><p className="text-sm">Проверьте историю Telegram или SMS. Сверка сохраняет квитанции и не отменяет возможное списание. Используйте её только если пригодный результат не подтверждён.</p><label className="flex gap-2 text-sm"><input type="checkbox" checked={deliveryChecked} onChange={e => setDeliveryChecked(e.target.checked)} />Я проверил историю у провайдера</label><textarea className="w-full rounded border p-2" aria-label="Результат сверки доставки" value={deliveryNote} onChange={e => setDeliveryNote(e.target.value)} minLength={20} maxLength={2000} placeholder="Что проверено и что обнаружено (от 20 символов)" />
      {[...(data.deliveries ?? []).map(d => ({ ...d, kind: "NARRATION" })), ...(data.ownerReport?.deliveries ?? []).map(d => ({ ...d, kind: "OWNER_REPORT" }))].filter(d => ["UNKNOWN", "SENDING"].includes(d.status)).map(d => <button key={d.id} className="pill sm" disabled={busy || !deliveryChecked || deliveryNote.trim().length < 20} onClick={() => void run(async () => { const result = await api<{ message: string }>(`/properties/${propertyId}/narration/delivery-reconcile`, { method: "POST", body: { kind: d.kind, deliveryId: d.id, checkedProviderHistory: true, note: deliveryNote } }); setMessage(result.message); })}>Сохранить сверку {d.kind === "NARRATION" ? "передачи монтажёру" : "SMS"} · {d.id.slice(0, 8)}</button>)}
    </fieldset>}
    <p className="text-xs text-slate-500">Предварительные планы сами не отправляются при включении сервера. {data.autoGenerate ? "Автоозвучка включена: аудио готовится само в пределах дневного лимита." : "Генерация аудио — отдельный платный запрос только по кнопке."} Принятие сервисом не означает, что человек просмотрел материал.</p>
    {message && <p className="text-sm" role="status">{message}</p>}
  </section>;
}

function voiceLines(config: NarrationConfig): string {
  return config.voices.map((v) => [v.id, v.name, v.gender === "male" ? "м" : v.gender === "female" ? "ж" : ""].filter(Boolean).join(" | ")).join("\n");
}
/** «ID | название | м/ж» в голоса настроек. Пол необязателен. */
export function parseVoiceLines(text: string): NarrationConfig["voices"] {
  return text.split("\n").filter((line) => line.trim()).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    const last = parts.length > 2 ? parts[parts.length - 1].toLowerCase() : "";
    const gender = last === "м" || last === "муж" ? "male" as const : last === "ж" || last === "жен" ? "female" as const : undefined;
    const name = (gender ? parts.slice(1, -1) : parts.slice(1)).join(" | ");
    return { id: parts[0], name, ...(gender ? { gender } : {}) };
  });
}
