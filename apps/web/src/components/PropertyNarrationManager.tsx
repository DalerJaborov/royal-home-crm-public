import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { narrationRotatedTemplateId, pickNarrationTemplate, pickNarrationVoice, type PropertyNarrationView } from "@royal-home/shared";
import { api } from "../lib/api";
import { NarrationComposer, resolveNarrationDraft, type NarrationDraft } from "./NarrationComposer";
import { PropertyNarrationService } from "./PropertyNarrationService";

/**
 * ОЗВУЧКА В КАРТОЧКЕ ОБЪЕКТА — ДЛЯ АГЕНТА (14.11.2026, владелец).
 *
 * «Когда заходишь в объект, там куча настроек, ненужных для озвучки. Всю техническую часть — в
 * настройки CRM; в объекте должно быть только: выбрать голос, текст по шаблону (меняются лишь цифры,
 * несколько вариантов, агент может поправить) и кнопка «сгенерировать».» Поэтому здесь три вещи:
 *   • что сейчас с озвучкой (готовится / послушайте и одобрите / одобрено / не получилось);
 *   • голос и текст (NarrationComposer — тот же блок, что в конце мастера);
 *   • одна главная кнопка «Озвучить».
 * Модель, ключ, голоса, шаблоны, пределы — Настройки → Каналы → «Озвучка роликов»
 * (NarrationSettingsPanel). Сверки, ручная передача монтажёру и отчёт собственнику — свёрнутый
 * блок PropertyNarrationService, его видят только маркетинг и руководство.
 */
function approvedMessage(delivery: string | undefined): string {
  if (delivery === "CRM_REMIX") return "Озвучка одобрена. Ролик уже вышел: CRM сама наложит новую озвучку и заменит его.";
  if (delivery === "SOUND_REMAKE") return "Озвучка одобрена. Ролик уже вышел: монтажёр заменит в нём только звук.";
  if (delivery === "ADD_VOICE") return "Озвучка одобрена. Ролик уже смонтирован: монтажёр вклеит в него голос, потом ролик выйдет.";
  if (delivery === "DISABLED") return "Для объекта выбрано «Без озвучки»: монтажёру ничего не уходит.";
  return "Озвучка одобрена. Монтажёр получит её вместе с заданием на ролик.";
}

/** Код «кредиты ElevenLabs закончились» (apps/api/src/lib/propertyNarration.ts, NARRATION_QUOTA_EXCEEDED). */
const QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED";

/** Пока озвучка готовится, карточка сама спрашивает сервер раз в 5 секунд. */
export function narrationIsPending(v: PropertyNarrationView["versions"][number] | undefined): boolean {
  // Зависшая генерация (canReconcile) — уже не «готовится»: опрос раз в 5 с шёл бы бесконечно.
  return !!v && ((v.status === "GENERATING" && !v.canReconcile) || (v.status === "DRAFT" && !!v.generateAfter));
}

export function PropertyNarrationManager({ propertyId }: { propertyId: string }) {
  const client = useQueryClient();
  const ids = useId();
  const key = ["property-narration", propertyId];
  const { data, error, isPending } = useQuery({
    queryKey: key, queryFn: () => api<PropertyNarrationView>(`/properties/${propertyId}/narration`), retry: false,
    refetchInterval: (q) => narrationIsPending(q.state.data?.versions[0]) ? 5000 : false,
  });
  const [draft, setDraft] = useState<NarrationDraft>({});
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  // Плеер привязан к версии (ревью 14.11): иначе после «Истории аудио» блок «послушайте и одобрите»
  // играл бы старую запись, и одобряли бы новую версию, не услышав её.
  const [audio, setAudio] = useState<{ versionId: string; url: string } | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const latest = data?.versions[0];
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);
  useEffect(() => { setDraft({}); setEditing(false); setAudio(null); setMessage(""); requestKey.current = crypto.randomUUID(); }, [propertyId]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); await client.invalidateQueries({ queryKey: key }); }
    catch (err) { setMessage(err instanceof Error ? err.message : "Действие не выполнено"); }
    finally { setBusy(false); }
  }
  async function listen(versionId: string) {
    await run(async () => {
      const blob = await api<Blob>(`/properties/${propertyId}/narration/${versionId}/audio`, { responseType: "blob" });
      setAudio({ versionId, url: URL.createObjectURL(blob) });
    });
  }

  if (isPending) return <section className="card p-4" aria-busy="true">Загружаем озвучку…</section>;
  if (error || !data) return <section className="card p-4" role="status">Озвучка недоступна: {error instanceof Error ? error.message : "не удалось загрузить"}</section>;

  const templates = data.config.templates ?? [];
  const facts = data.facts;
  const canEdit = data.canDraft !== false;
  const pending = narrationIsPending(latest);
  const ready = latest?.status === "READY" && latest.hasAudio;
  const failed = latest?.status === "FAILED";
  // Результат у ElevenLabs неизвестен (или генерация зависла): новую озвучку сервер не примет (409),
  // пока руководство не сверит итог в «Служебном». Агенту — понятный статус, без формы.
  const uncertain = !!latest && (latest.status === "UNKNOWN" || (latest.status === "GENERATING" && !!latest.canReconcile));
  // Устаревшая версия несёт прежнюю цену словами (ревью 14.11): её текст в форму не подставляем, только свежий шаблон.
  const currentScript = latest && !latest.stale ? latest.script : null;
  const approved = !!ready && !!latest?.approvedAt && !latest.stale;
  const waitsForApproval = !!ready && !latest?.approvedAt && !latest?.stale && latest?.source !== "MANUAL";
  const showComposer = canEdit && !data.off && !!facts && (editing || !latest || failed || (latest.status === "DRAFT" && !latest.generateAfter));
  const last = data.lastChoice ?? {};
  // Есть версия — её шаблон и текст; нет — следующий вариант после прошлого выбора, как в мастере.
  const defaultTemplateId = latest?.templateId ?? narrationRotatedTemplateId(templates, last.templateId) ?? pickNarrationTemplate(data.config)?.id ?? null;
  const defaultVoiceId = pickNarrationVoice(data.config, latest?.voiceId ?? last.voiceId);
  const resolved = facts ? resolveNarrationDraft({ templates, facts, value: draft, defaultTemplateId, defaultVoiceId, defaultScript: currentScript }) : null;
  const textOk = (resolved?.text.trim().length ?? 0) >= 10;

  const submit = (generate: boolean) => void run(async () => {
    if (!resolved) return;
    await api(`/properties/${propertyId}/narration`, { method: "POST", body: {
      expectedRevision: latest?.revision ?? 0, requestKey: requestKey.current, script: resolved.text,
      ...(resolved.templateId ? { templateId: resolved.templateId } : {}), ...(resolved.voiceId ? { voiceId: resolved.voiceId } : {}), ...(generate ? { generate: true } : {}),
    } });
    requestKey.current = crypto.randomUUID(); setDraft({}); setEditing(false);
    setMessage(generate ? "Готовим озвучку. Обычно минута-две, придёт сюда и в Шабнам." : "Текст сохранён. Аудио по нему подготовит маркетинг.");
  });
  const setMode = (off: boolean) => void run(async () => {
    const result = await api<{ message: string }>(`/properties/${propertyId}/narration/mode`, { method: "POST", body: { off } });
    setMessage(result.message);
  });
  const player = (versionId: string, primary: boolean) => audio?.versionId === versionId
    ? <audio className="w-full" controls autoPlay src={audio.url} />
    : <button type="button" className={primary ? "pill" : "pill sm"} disabled={busy} onClick={() => void listen(versionId)}>▶ Прослушать</button>;

  return (
    <section className="card space-y-4 p-4" aria-label="Озвучка объекта">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Озвучка ролика</h3>
        {canEdit && !data.off && <button type="button" className="pill sm ghost" disabled={busy} onClick={() => setMode(true)}>Без озвучки</button>}
      </div>

      {data.off ? (
        <div className="space-y-2 rounded-xl border p-3">
          <p className="text-sm">Для этого объекта выбрано «Без озвучки»: ничего не готовится, монтажёр знает.</p>
          {canEdit && <button type="button" className="pill" disabled={busy} onClick={() => setMode(false)}>Включить озвучку</button>}
        </div>
      ) : <>
        {!data.configured && <p className="rounded-lg bg-[var(--warn-bg)] p-3 text-sm" role="status">Озвучка ещё не настроена руководством. Голос и текст можно выбрать уже сейчас.</p>}

        {latest && !showComposer && <div className="space-y-3 rounded-xl border p-3" role="status">
          {uncertain && <p className="text-sm">Результат озвучки уточняет руководство. Как только сверят, можно будет озвучить заново.</p>}
          {pending && <p className="flex items-center gap-2 text-sm"><span className="inline-block h-3 w-3 animate-pulse rounded-full bg-blue" aria-hidden />Готовим озвучку. Обычно минута-две, придёт сюда и в Шабнам.</p>}
          {waitsForApproval && <>
            <p className="font-medium">Озвучка готова: послушайте и одобрите</p>
            {player(latest.id, true)}
            {data.canApproveAudio
              ? <div className="flex flex-wrap gap-2">
                  <button type="button" className="pill bg-blue! text-on-accent!" disabled={busy} onClick={() => void run(async () => {
                    const result = await api<{ delivery?: string }>(`/properties/${propertyId}/narration/${latest.id}/approve`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true } });
                    setMessage(approvedMessage(result.delivery));
                  })}>✓ Одобрить</button>
                  {canEdit && <button type="button" className="pill" disabled={busy} onClick={() => setEditing(true)}>Изменить голос или текст</button>}
                </div>
              : <p className="text-sm text-[var(--muted)]">Эту озвучку одобряет владелец.</p>}
          </>}
          {approved && <>
            <p className="font-medium">✓ Озвучка одобрена</p>
            <p className="text-sm text-[var(--muted)]">{data.mix?.hasMaster ? "Озвучку на ролик накладывает CRM: поменяется цена, звук обновится сам." : "Монтажёр получает её вместе с заданием на ролик."}</p>
            {data.mix?.problem === "VOICE_LONGER" && <p className="rounded-lg bg-[var(--warn-bg)] p-3 text-sm" role="status">Новая озвучка длиннее ролика, обрезать голос CRM не стала. Ролик ушёл монтажёру: он удлинит его под голос. Быстрее — сократить текст и озвучить заново.</p>}
            {data.mix?.problem === "FAILED" && <p className="rounded-lg bg-[var(--warn-bg)] p-3 text-sm" role="status">Наложить новую озвучку на ролик не получилось, в соцсетях пока прежний ролик. Руководство видит ошибку.</p>}
            <div className="flex flex-wrap items-center gap-2">
              {player(latest.id, false)}
              {canEdit && <button type="button" className="pill sm" disabled={busy} onClick={() => setEditing(true)}>Изменить</button>}
            </div>
          </>}
          {latest.stale && !pending && <>
            <p className="text-sm">Данные объекта изменились, озвучка устарела.{data.autoGenerate ? " Новая подготовится сама через несколько минут." : ""}</p>
            {canEdit && <button type="button" className="pill sm" disabled={busy} onClick={() => setEditing(true)}>Озвучить заново</button>}
          </>}
          {ready && !latest.approvedAt && !latest.stale && latest.source === "MANUAL" && <p className="text-sm">Аудио готово, его проверяет маркетинг.</p>}
        </div>}

        {failed && <p className="rounded-lg bg-[var(--warn-bg)] p-3 text-sm" role="status">
          {latest?.errorCode === QUOTA_EXCEEDED ? "Озвучка не получилась: закончились кредиты ElevenLabs. Руководство уже видит это." : "Озвучка не получилась. Проверьте голос и текст и нажмите «Озвучить» ещё раз."}
        </p>}

        {showComposer && facts && <>
          <NarrationComposer name={`${ids}-voice`} templates={templates} voices={data.config.voices} samples={data.samples} facts={facts} value={draft} onChange={setDraft}
            defaultTemplateId={defaultTemplateId} defaultVoiceId={defaultVoiceId} defaultScript={currentScript} lastPickedVoiceId={last.voiceId ?? null} disabled={busy} />
          <div className="flex flex-wrap items-center gap-2">
            {data.autoGenerate
              ? <button type="button" className="pill bg-blue! text-on-accent!" disabled={busy || !resolved?.voiceId || !textOk} onClick={() => submit(true)}>Озвучить</button>
              : <button type="button" className="pill" disabled={busy || !textOk} onClick={() => submit(false)}>Сохранить текст</button>}
            {editing && <button type="button" className="pill" disabled={busy} onClick={() => { setDraft({}); setEditing(false); }}>Отмена</button>}
          </div>
          <p className="text-sm text-[var(--muted)]">{data.autoGenerate
            ? "Озвучка придёт на прослушивание сюда и в Шабнам. Поменяется цена — обновится сама и снова придёт на одобрение."
            : "Автоозвучка выключена: аудио по этому тексту подготовит маркетинг."}</p>
        </>}
      </>}

      {message && <p className="text-sm" role="status">{message}</p>}
      {audio && !((waitsForApproval || approved) && audio.versionId === latest?.id) && <audio className="w-full" controls src={audio.url} />}
      {(data.canApprove || data.canConfigure) && <PropertyNarrationService propertyId={propertyId} data={data} busy={busy} run={run} setMessage={setMessage} onListen={(id) => void listen(id)} />}
    </section>
  );
}
