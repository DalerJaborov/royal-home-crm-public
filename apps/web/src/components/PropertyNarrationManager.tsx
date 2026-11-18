import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chooseNarration, narrationChangesLine, narrationLengthCheck, narrationRemovesOldPosts, pickNarrationVoice,
  type NarrationReleaseChannel, type PropertyNarrationView,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { NarrationComposer, resolveNarrationDraft, type NarrationDraft } from "./NarrationComposer";
import { PropertyNarrationService } from "./PropertyNarrationService";

/**
 * ОЗВУЧКА В КАРТОЧКЕ ОБЪЕКТА (14.11.2026; «поменял, послушал, утвердил» — 18.11.2026, макет владельца).
 *
 * Один адаптивный блок наверху карточки (ПК и телефон — одна разметка, сетка голосов сама в один столбец):
 *   • готовится — «Озвучка под новые данные», что изменилось, полоса хода;
 *   • готова — большая «▶ Послушать», голоса с образцами, текст можно поправить, строка длины
 *     («Укладывается в ролик: ~32 с из 35 с»), главная кнопка «✓ Утвердить и выпустить» (ролик уже вышел)
 *     или «✓ Одобрить» (ролика ещё нет); поменяли текст или голос — «Озвучить заново»;
 *   • текст длиннее ролика — кнопки неактивны, «Сократите текст», кредиты не тратятся (сервер тоже отказывает);
 *   • выпуск — CRM накладывает голос → выйдет в 14:15 / утром в 09:00 → уходит в сети → вышел, по каждой сети:
 *     «новый пост, старый снят», TikTok — «старый удалите сами» со ссылкой;
 *   • всё спокойно — одна строка и «Изменить озвучку» (ошибка в тексте, другой голос без правки данных).
 * Утверждение — одна дверь сервера (POST …/approve → approveNarrationVersion), её же зовёт Шабнам.
 * Техника (модель, ключ, пределы) — в Настройках; сверки и передачи — свёрнутый PropertyNarrationService.
 */

/** Код «кредиты ElevenLabs закончились» (apps/api/src/lib/propertyNarration.ts, NARRATION_QUOTA_EXCEEDED). */
const QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED";
/** Код «текст длиннее ролика, озвучка не заказана» (apps/api/src/lib/narrationAutoFlow.ts, NARRATION_TEXT_TOO_LONG). */
const TEXT_TOO_LONG = "TEXT_LONGER_THAN_CLIP";

const CHANNEL_NAME: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", YOUTUBE: "YouTube", TELEGRAM: "Telegram", TIKTOK: "TikTok", THREADS: "Threads" };

function approvedMessage(delivery: string | undefined): string {
  if (delivery === "CRM_REMIX") return "Утверждено. CRM накладывает новую озвучку, ролик сразу уйдёт в соцсети.";
  if (delivery === "SOUND_REMAKE") return "Утверждено. Ролик уже вышел: монтажёр заменит в нём только звук.";
  if (delivery === "ADD_VOICE") return "Утверждено. Ролик уже смонтирован: монтажёр вклеит в него голос, потом ролик выйдет.";
  if (delivery === "DISABLED") return "Для объекта выбрано «Без озвучки»: монтажёру ничего не уходит.";
  return "Озвучка одобрена. Монтажёр получит её вместе с заданием на ролик.";
}

/** «14:15» сегодня, «завтра в 09:00», иначе «20 ноября в 09:00»; всегда по Душанбе (UTC+5). */
export function narrationReleaseTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => x.toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" });
  const time = d.toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" });
  if (day(d) === day(now)) return `в ${time}`;
  if (day(d) === day(new Date(now.getTime() + 86_400_000))) return `завтра в ${time}`;
  return `${d.toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "long" })} в ${time}`;
}

function channelLine(c: NarrationReleaseChannel): string {
  switch (c.state) {
    case "OLD_REMOVED": return "новый пост, старый снят";
    case "OLD_MANUAL": return "новый пост вышел. Старый удалите сами";
    case "OLD_KEPT": return "новый пост вышел, старый оставлен";
    case "NEW_FAILED": return "новый не вышел, старый пост на месте";
    case "NEW": return "новый пост вышел";
    default: return "выходит";
  }
}

/** Пока озвучка готовится, карточка сама спрашивает сервер раз в 5 секунд. */
export function narrationIsPending(v: PropertyNarrationView["versions"][number] | undefined): boolean {
  // Зависшая генерация (canReconcile) — уже не «готовится»: опрос раз в 5 с шёл бы бесконечно.
  return !!v && ((v.status === "GENERATING" && !v.canReconcile) || (v.status === "DRAFT" && !!v.generateAfter));
}
/** Выпуск идёт — опрос раз в 10 секунд, пока ролик не вышел. */
export function narrationReleaseMoving(data: PropertyNarrationView | undefined): boolean {
  const stage = data?.release?.stage;
  return stage === "MIXING" || stage === "SCHEDULED" || stage === "PUBLISHING" || (stage === "DONE" && !!data?.release?.channels.some((c) => c.state === "WAITING"));
}

function Progress({ label }: { label: string }) {
  return (
    <div className="mt-4 h-4 overflow-hidden rounded-full bg-[var(--track)]" role="progressbar" aria-label={label}>
      <div className="h-full w-1/2 animate-pulse rounded-full bg-blue" />
    </div>
  );
}

export function PropertyNarrationManager({ propertyId, placement = "media", factsKey }: { propertyId: string; placement?: "top" | "media";
  /** Факты озвучки из карточки (цена, этаж…): поменялись после «Сохранить» — блок сразу спрашивает сервер заново. */
  factsKey?: string }) {
  const client = useQueryClient();
  const ids = useId();
  const key = ["property-narration", propertyId];
  const { data, error, isPending } = useQuery({
    queryKey: key, queryFn: () => api<PropertyNarrationView>(`/properties/${propertyId}/narration`), retry: false,
    refetchInterval: (q) => narrationIsPending(q.state.data?.versions[0]) ? 5000 : narrationReleaseMoving(q.state.data) ? 10_000 : false,
  });
  const [draft, setDraft] = useState<NarrationDraft>({});
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  // Плеер привязан к версии (ревью 14.11): иначе играла бы старая запись, а утверждали бы новую.
  const [audio, setAudio] = useState<{ versionId: string; url: string } | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const latest = data?.versions[0];
  const factsType = data?.facts?.type;
  const freshPick = useMemo(() => data ? chooseNarration(data.config, factsType, { avoid: { templateId: data.lastChoice?.usedTemplateId ?? data.lastChoice?.templateId, endingId: data.lastChoice?.usedEndingId ?? data.lastChoice?.endingId } }) : null, [data, factsType]);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);
  useEffect(() => { setDraft({}); setEditing(false); setAudio(null); setMessage(""); requestKey.current = crypto.randomUUID(); }, [propertyId]);
  const seenFacts = useRef(factsKey);
  useEffect(() => {
    if (factsKey === undefined || seenFacts.current === factsKey) return;
    seenFacts.current = factsKey;
    void client.invalidateQueries({ queryKey: ["property-narration", propertyId] });
  }, [client, factsKey, propertyId]);

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

  if (isPending) return placement === "top" ? null : <section className="card p-4" aria-busy="true">Загружаем озвучку…</section>;
  // Наверху карточки ошибка доступа не нужна: блок просто не показывается.
  if (error || !data) return placement === "top" ? null : <section className="card p-4" role="status">Озвучка недоступна: {error instanceof Error ? error.message : "не удалось загрузить"}</section>;

  const templates = data.config.templates ?? [];
  const endings = data.config.endings ?? [];
  const facts = data.facts;
  const canEdit = data.canDraft !== false;
  const published = data.published === true;
  const pending = narrationIsPending(latest);
  const ready = latest?.status === "READY" && latest.hasAudio;
  const failed = latest?.status === "FAILED";
  const tooLongFailed = failed && latest?.errorCode === TEXT_TOO_LONG;
  const uncertain = !!latest && (latest.status === "UNKNOWN" || (latest.status === "GENERATING" && !!latest.canReconcile));
  // Устаревшая версия несёт прежнюю цену словами (ревью 14.11): её текст в форму не подставляем, только свежий шаблон.
  const currentScript = latest && !latest.stale ? latest.script : null;
  const approved = !!ready && !!latest?.approvedAt && !latest.stale;
  const waitsForApproval = !!ready && !latest?.approvedAt && !latest?.stale && latest?.source !== "MANUAL";
  const last = data.lastChoice ?? {};
  const defaultTemplateId = latest?.templateId ?? freshPick?.templateId ?? null;
  const defaultEndingId = latest ? latest.endingId ?? null : freshPick?.endingId ?? null;
  const defaultVoiceId = pickNarrationVoice(data.config, latest?.voiceId ?? last.voiceId);
  const resolved = facts ? resolveNarrationDraft({ templates, endings, facts, value: draft, defaultTemplateId, defaultEndingId, defaultVoiceId, defaultScript: currentScript }) : null;
  const textOk = (resolved?.text.trim().length ?? 0) >= 10;
  const length = resolved ? narrationLengthCheck(resolved.text, resolved.lang, data.clipSec ?? null, data.charsPerSec) : null;
  const tooLong = !!length && !length.fits;
  // Текст или голос поменяли в блоке готовой озвучки — утверждать старое аудио нельзя, только «Озвучить заново».
  const changedDraft = waitsForApproval && !!resolved && (resolved.text !== latest?.script || (resolved.voiceId ?? null) !== (latest?.voiceId ?? null));
  // Форма: готовая озвучка (по макету — голос и текст рядом с «Послушать»), нажали «Изменить», озвучки нет, не вышла.
  const showComposer = canEdit && !data.off && !!facts && (editing || waitsForApproval || !latest || failed || (latest.status === "DRAFT" && !latest.generateAfter));
  const changesLine = narrationChangesLine(data.changed ?? []);
  const release = data.release ?? null;
  const removesOld = narrationRemovesOldPosts(data.config);

  const submit = (generate: boolean) => void run(async () => {
    if (!resolved) return;
    await api(`/properties/${propertyId}/narration`, { method: "POST", body: {
      expectedRevision: latest?.revision ?? 0, requestKey: requestKey.current, script: resolved.text,
      ...(resolved.templateId ? { templateId: resolved.templateId } : {}), endingId: resolved.endingId, ...(resolved.voiceId ? { voiceId: resolved.voiceId } : {}), ...(generate ? { generate: true } : {}),
    } });
    requestKey.current = crypto.randomUUID(); setDraft({}); setEditing(false);
    setMessage(generate ? "Готовим озвучку. Обычно минута-две, придёт сюда и в Шабнам." : "Текст сохранён. Аудио по нему подготовит маркетинг.");
  });
  const approve = () => void run(async () => {
    if (!latest) return;
    const result = await api<{ delivery?: string; publishAt?: string }>(`/properties/${propertyId}/narration/${latest.id}/approve`, { method: "POST", body: { expectedRevision: latest.revision, confirmed: true } });
    setMessage(`${approvedMessage(result.delivery)}${result.publishAt ? ` Выйдет примерно ${narrationReleaseTime(result.publishAt)}.` : ""}`);
  });
  const setMode = (off: boolean) => void run(async () => {
    const result = await api<{ message: string }>(`/properties/${propertyId}/narration/mode`, { method: "POST", body: { off } });
    setMessage(result.message);
  });
  const player = (versionId: string, primary: boolean) => audio?.versionId === versionId
    ? <audio className="w-full" controls autoPlay src={audio.url} />
    : <button type="button" className={`pill ${primary ? "min-h-14! w-full justify-start bg-blue! text-lg! text-on-accent! sm:flex-1" : "min-h-12!"}`} disabled={busy} onClick={() => void listen(versionId)}>▶ Послушать</button>;

  // Наверху карточки — только когда есть что делать или смотреть; в спокойном состоянии одна строка.
  const quiet = !pending && !waitsForApproval && !failed && !uncertain && !release && !(latest?.stale) && !editing && !!latest;

  const title = release ? (release.stage === "DONE" ? "Ролик вышел" : "Ролик с новой озвучкой")
    : pending ? (published ? "Озвучка под новые данные" : "Готовим озвучку")
    : waitsForApproval ? "Новая озвучка готова"
    : tooLongFailed ? "Текст длиннее ролика"
    : "Озвучка ролика";

  if (data.off) {
    return (
      <section className="card space-y-3 p-4 sm:p-6" aria-label="Озвучка объекта">
        <p className="text-base">Для этого объекта выбрано «Без озвучки»: ничего не готовится, монтажёр знает.</p>
        {canEdit && <button type="button" className="pill min-h-12!" disabled={busy} onClick={() => setMode(false)}>Включить озвучку</button>}
        {message && <p className="text-base" role="status">{message}</p>}
      </section>
    );
  }

  if (quiet && placement === "top") {
    return (
      <section className="card flex flex-wrap items-center gap-3 p-4" aria-label="Озвучка объекта">
        <p className="flex-1 text-base">{approved ? "✓ Озвучка утверждена" : ready && latest?.source === "MANUAL" ? "Аудио готово, его проверяет маркетинг." : "Озвучка ролика"}</p>
        {ready && latest && player(latest.id, false)}
        {canEdit && <button type="button" className="pill min-h-12!" disabled={busy} onClick={() => setEditing(true)}>Изменить озвучку</button>}
        {message && <p className="w-full text-base" role="status">{message}</p>}
      </section>
    );
  }

  return (
    <section className="card space-y-4 p-4 sm:p-7" aria-label="Озвучка объекта">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-xl font-extrabold leading-tight sm:text-2xl">{title}</h3>
          {changesLine && (pending || waitsForApproval) && <p className="text-base text-[var(--muted)]">{changesLine}</p>}
        </div>
        {canEdit && !release && <button type="button" className="pill min-h-12! ghost" disabled={busy} onClick={() => setMode(true)}>Без озвучки</button>}
      </div>

      {!data.configured && <p className="rounded-xl bg-[var(--warn-bg)] p-3 text-base" role="status">Озвучка ещё не настроена руководством. Голос и текст можно выбрать уже сейчас.</p>}

      {release && <ReleaseBlock release={release} />}

      {!release && latest && <div className="space-y-3" role="status">
        {uncertain && <p className="text-base">Результат озвучки уточняет руководство. Как только сверят, можно будет озвучить заново.</p>}
        {pending && <>
          <p className="text-base">{published ? "Данные изменились, CRM готовит новую озвучку. Это займёт около минуты." : "Готовим озвучку. Обычно минута-две, придёт сюда и в Шабнам."}</p>
          <Progress label="Готовим озвучку" />
        </>}
        {waitsForApproval && <>
          <p className="text-base">{published ? "Послушайте и, если всё верно, выпускайте." : "Озвучка готова: послушайте и одобрите."}</p>
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-[var(--soft)] p-3">
            {player(latest.id, true)}
            {length && <span className="px-2 text-lg font-bold">~{length.estSec} с</span>}
          </div>
        </>}
        {approved && <>
          <p className="text-base font-semibold">✓ Озвучка одобрена</p>
          <p className="text-base text-[var(--muted)]">{data.mix?.hasMaster ? "Озвучку на ролик накладывает CRM: поменяются данные, звук обновится после вашего утверждения." : "Монтажёр получает её вместе с заданием на ролик."}</p>
          {data.mix?.problem === "VOICE_LONGER" && <p className="rounded-xl bg-[var(--warn-bg)] p-3 text-base" role="status">Новая озвучка длиннее ролика, обрезать голос CRM не стала. Ролик ушёл монтажёру: он удлинит его под голос. Быстрее: сократить текст и озвучить заново.</p>}
          {data.mix?.note && <p className="text-base" role="status">{data.mix.note}</p>}
          {data.mix?.problem === "FAILED" && <p className="rounded-xl bg-[var(--warn-bg)] p-3 text-base" role="status">Наложить новую озвучку на ролик не получилось, в соцсетях пока прежний ролик. Руководство видит ошибку.</p>}
          <div className="flex flex-wrap items-center gap-2">
            {player(latest.id, false)}
            {canEdit && <button type="button" className="pill min-h-12!" disabled={busy} onClick={() => setEditing(true)}>Изменить озвучку</button>}
          </div>
        </>}
        {latest.stale && !pending && <>
          <p className="text-base">Данные объекта изменились, озвучка устарела.{data.autoGenerate ? " Новая подготовится сама через минуту." : ""}</p>
          {canEdit && <button type="button" className="pill min-h-12!" disabled={busy} onClick={() => setEditing(true)}>Озвучить заново</button>}
        </>}
        {ready && !latest.approvedAt && !latest.stale && latest.source === "MANUAL" && <p className="text-base">Аудио готово, его проверяет маркетинг.</p>}
      </div>}

      {failed && !tooLongFailed && <p className="rounded-xl bg-[var(--warn-bg)] p-3 text-base" role="status">
        {latest?.errorCode === QUOTA_EXCEEDED ? "Озвучка не получилась: закончились кредиты ElevenLabs. Руководство уже видит это." : "Озвучка не получилась. Проверьте голос и текст и нажмите «Озвучить» ещё раз."}
      </p>}
      {tooLongFailed && <p className="text-base">Текст длиннее ролика, поэтому озвучку не заказывали. Сократите текст и нажмите «Озвучить».</p>}

      {showComposer && facts && !release && <>
        <NarrationComposer name={`${ids}-voice`} templates={templates} endings={endings} voices={data.config.voices} samples={data.samples} facts={facts} value={draft} onChange={setDraft}
          defaultTemplateId={defaultTemplateId} defaultEndingId={defaultEndingId} defaultVoiceId={defaultVoiceId} defaultScript={currentScript} lastPickedVoiceId={last.voiceId ?? null} disabled={busy}
          lengthCheck={length} />
        <div className="space-y-2">
          {waitsForApproval && data.canApproveAudio && !changedDraft && (
            <button type="button" className="pill min-h-14! w-full justify-center bg-blue! text-lg! font-bold text-on-accent!" disabled={busy || tooLong} onClick={approve}>
              {tooLong ? "Сократите текст" : published ? "✓ Утвердить и выпустить" : "✓ Одобрить"}
            </button>
          )}
          {waitsForApproval && !data.canApproveAudio && <p className="text-base text-[var(--muted)]">Эту озвучку одобряет владелец.</p>}
          {data.autoGenerate
            ? (!waitsForApproval || changedDraft || editing) && (
              <button type="button" className={`pill min-h-12! w-full justify-center ${changedDraft || !waitsForApproval ? "min-h-14! bg-blue! text-lg! font-bold text-on-accent!" : "ghost"}`}
                disabled={busy || !resolved?.voiceId || !textOk || tooLong} onClick={() => submit(true)}>
                {tooLong ? "Сократите текст" : waitsForApproval || (latest && !failed) ? "Озвучить заново" : "Озвучить"}
              </button>)
            : <button type="button" className="pill min-h-12! w-full justify-center" disabled={busy || !textOk} onClick={() => submit(false)}>Сохранить текст</button>}
          {(editing || changedDraft) && <button type="button" className="pill min-h-12! w-full justify-center ghost" disabled={busy} onClick={() => { setDraft({}); setEditing(false); }}>Отмена</button>}
          <p className="text-center text-[15px] text-[var(--muted)]">{waitsForApproval && published
            ? removesOld ? "Ролик сразу уйдёт в соцсети, где он уже был. Старые посты CRM снимет сама." : "Ролик сразу уйдёт в соцсети. Старые посты останутся рядом: так задано в настройках."
            : data.autoGenerate ? "Озвучка придёт на прослушивание сюда и в Шабнам." : "Автоозвучка выключена: аудио по этому тексту подготовит маркетинг."}</p>
        </div>
      </>}

      {message && <p className="text-base" role="status">{message}</p>}
      {audio && !((waitsForApproval || approved) && audio.versionId === latest?.id) && <audio className="w-full" controls src={audio.url} />}
      {placement === "media" && (data.canApprove || data.canConfigure) && <PropertyNarrationService propertyId={propertyId} data={data} busy={busy} run={run} setMessage={setMessage} onListen={(id) => void listen(id)} />}
    </section>
  );
}

/** Ход выпуска: накладываем → выйдет в 14:15 → уходит → вышел, по каждой сети. */
function ReleaseBlock({ release }: { release: NonNullable<PropertyNarrationView["release"]> }) {
  if (release.stage === "MIXING") return <><p className="text-base">Озвучка утверждена. CRM накладывает её на ролик, обычно пару минут.</p><Progress label="Накладываем озвучку" /></>;
  if (release.stage === "SCHEDULED") {
    const when = release.at ? narrationReleaseTime(release.at) : null;
    return <div className="space-y-1">
      <p className="text-lg font-bold">{when ? `Выйдет ${when.startsWith("в ") ? "сегодня " : ""}${when}` : "Выйдет в ближайшее время"}</p>
      {release.reason && <p className="text-base text-[var(--muted)]">{release.reason}</p>}
    </div>;
  }
  if (release.stage === "PUBLISHING") return <><p className="text-base">Ролик уходит в соцсети. Старый пост в каждой сети CRM снимет, как только там выйдет новый.</p><Progress label="Публикуем" />
    {release.channels.length > 0 && <ChannelList channels={release.channels} />}</>;
  return <><p className="text-base">Новая озвучка опубликована.</p>{release.channels.length > 0 && <ChannelList channels={release.channels} />}</>;
}

function ChannelList({ channels }: { channels: NarrationReleaseChannel[] }) {
  return (
    <ul className="grid gap-2">
      {channels.map((c) => {
        const manual = c.state === "OLD_MANUAL";
        const bad = c.state === "NEW_FAILED";
        const ok = c.state === "OLD_REMOVED" || c.state === "NEW" || c.state === "OLD_KEPT";
        return (
          <li key={c.channel} className={`flex items-start gap-3 rounded-2xl p-3 text-base ${manual || bad ? "bg-[var(--warn-bg)]" : "bg-[var(--soft)]"}`}>
            <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-white font-extrabold" aria-hidden>{ok || manual ? "✓" : bad ? "!" : "…"}</span>
            <div className="min-w-0 space-y-2">
              <p><b>{CHANNEL_NAME[c.channel] ?? c.channel}</b><br />{channelLine(c)}</p>
              {manual && (c.url
                ? <a className="pill min-h-12! inline-flex items-center" href={c.url} target="_blank" rel="noreferrer">Открыть старый пост в {CHANNEL_NAME[c.channel] ?? c.channel}</a>
                : <p className="text-[15px] text-[var(--muted)]">Найдите старый ролик в приложении.</p>)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
