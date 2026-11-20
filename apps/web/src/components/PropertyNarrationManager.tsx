import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chooseNarration, narrationAudioLengthCheck, narrationChangesLine, narrationLengthCheck, narrationLengthLine, narrationRemovesOldPosts, pickNarrationVoice,
  type NarrationReleaseChannel, type PropertyNarrationView,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { NarrationComposer, resolveNarrationDraft, type NarrationDraft } from "./NarrationComposer";
import { PropertyNarrationService } from "./PropertyNarrationService";

/**
 * ОЗВУЧКА В КАРТОЧКЕ ОБЪЕКТА (14.11.2026; «поменял, послушал, утвердил» — 18.11.2026; разбор владельца 20.11.2026).
 *
 * 20.11 владелец: «захожу в любой объект, и первым выходит такое, как будто это не часть карточки». Поэтому:
 *   • место — в колонке карточки рядом со строкой «Ролик», ПОСЛЕ фото, цены и «кто ведёт» (PropertyDetail);
 *   • блок — короткая карточка-статус: заголовок «Озвучка ролика», одна строка что происходит, одна главная кнопка;
 *   • «послушать и одобрить» и «переделать» — два разных действия: «✓ Одобрить» стоит сразу под плеером, выбор голоса
 *     и текст открываются только по «Изменить голос или текст»;
 *   • озвучки нет и ролик давно вышел (старые объекты) — в карточке блока нет вовсе, он остаётся во вкладке ролика;
 *   • «готовится» и «накладывается» — без выдуманной полосы на половине: значок хода и сколько минут идёт, а дольше
 *     обычного — честная строка; «накладывается» сервер ставит только если CRM правда наложит (narrationRemixPending);
 *   • свой плеер: длина известна серверу (audioSec), «00:27 / 00:00» на телефоне больше не бывает.
 * Утверждение — одна дверь сервера (POST …/approve → approveNarrationVersion), её же зовёт Шабнам.
 * Техника (модель, ключ, пределы) — в Настройках; сверки и передачи — свёрнутый PropertyNarrationService.
 */

/** Код «кредиты ElevenLabs закончились» (apps/api/src/lib/propertyNarration.ts, NARRATION_QUOTA_EXCEEDED). */
const QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED";
/** Код «текст длиннее ролика, озвучка не заказана» (apps/api/src/lib/narrationAutoFlow.ts, NARRATION_TEXT_TOO_LONG). */
const TEXT_TOO_LONG = "TEXT_LONGER_THAN_CLIP";
/** После скольких минут «готовим» и «накладываем» честно говорят «дольше обычного». */
const SLOW_GENERATION_MIN = 5;
const SLOW_MIX_MIN = 30;

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

/** «0:27» — для плеера; секунды целые. */
export function narrationClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Сколько минут прошло с момента (целые, не меньше нуля); нет даты — null. */
function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60_000));
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

/**
 * Состояние блока — одно на ПК и телефон, одно для тестов. «none» — озвучки ещё не было; «hidden» — показывать в
 * карточке нечего (старый объект: озвучки нет, ролик давно вышел; озвучка в нём не нужна, пока её не попросят).
 */
export type NarrationCardState = "off" | "hidden" | "none" | "pending" | "uncertain" | "failed" | "tooLong" | "awaiting" | "marketingReview"
  | "draftSaved" | "stale" | "mixing" | "scheduled" | "publishing" | "done" | "mixFailed" | "approved";
export function narrationCardState(data: PropertyNarrationView): NarrationCardState {
  const latest = data.versions[0];
  if (data.off) return "off";
  if (!latest) return data.published ? "hidden" : "none";
  if (narrationIsPending(latest)) return "pending";
  if (latest.status === "UNKNOWN" || (latest.status === "GENERATING" && latest.canReconcile)) return "uncertain";
  if (latest.status === "FAILED") return latest.errorCode === TEXT_TOO_LONG ? "tooLong" : "failed";
  if (data.release) return data.release.stage === "MIXING" ? "mixing" : data.release.stage === "SCHEDULED" ? "scheduled" : data.release.stage === "PUBLISHING" ? "publishing" : "done";
  if (latest.stale) return "stale";
  const ready = latest.status === "READY" && latest.hasAudio;
  const awaitsHuman = latest.awaitsHuman ?? (!latest.approvedAt && latest.source !== "MANUAL");
  if (ready && awaitsHuman) return "awaiting";
  if (ready && !latest.approvedAt && latest.source === "MANUAL") return "marketingReview";
  if (ready && latest.approvedAt) return data.mix?.problem ? "mixFailed" : "approved";
  if (latest.status === "DRAFT") return "draftSaved";
  return "approved";
}

/** Ход без процентов: процент CRM не знает, поэтому не рисуем выдуманную половину полосы (было до 20.11). */
function Busy({ label }: { label: string }) {
  return <span className="inline-block h-5 w-5 flex-none animate-spin rounded-full border-[3px] border-blue/25 border-t-blue motion-reduce:animate-none" role="img" aria-label={label} />;
}

/**
 * Плеер озвучки (20.11.2026). Встроенный &lt;audio controls&gt; на телефоне показывал «00:27 / 00:00»: у mp3 без
 * заголовка длины браузер её не знает. Длину знает сервер (audioSec) — она и показывается; запись грузится
 * по первому нажатию, повтор — с начала.
 */
function NarrationPlayer({ load, knownSec, primary, disabled }: { load: () => Promise<string>; knownSec: number | null | undefined; primary?: boolean; disabled?: boolean }) {
  const el = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [pos, setPos] = useState(0), [dur, setDur] = useState<number | null>(knownSec ?? null), [error, setError] = useState("");
  useEffect(() => () => { el.current?.pause(); if (url.current) URL.revokeObjectURL(url.current); }, []);
  async function toggle() {
    setError("");
    if (state === "playing") { el.current?.pause(); return; }
    try {
      if (!el.current) {
        setState("loading");
        url.current = await load();
        const audio = new Audio(url.current);
        audio.ontimeupdate = () => setPos(audio.currentTime);
        audio.onloadedmetadata = () => { if (Number.isFinite(audio.duration) && audio.duration > 0) setDur(audio.duration); };
        audio.onplay = () => setState("playing");
        audio.onpause = () => setState("paused");
        audio.onended = () => { setState("paused"); setPos(0); audio.currentTime = 0; };
        el.current = audio;
      }
      await el.current.play();
    } catch {
      setState(el.current ? "paused" : "idle");
      setError("Запись не воспроизвелась. Попробуйте ещё раз.");
    }
  }
  const total = dur ?? knownSec ?? null;
  const playing = state === "playing";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button type="button" className={`pill min-h-12! flex-none justify-center text-base! ${primary ? "bg-blue! text-on-accent! font-bold" : "ghost"}`} disabled={disabled || state === "loading"}
          aria-pressed={playing} onClick={() => void toggle()}>
          {state === "loading" ? "Загружаем…" : playing ? "❚❚ Пауза" : state === "paused" && pos > 0 ? "▶ Дальше" : "▶ Послушать"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="h-2 overflow-hidden rounded-full bg-[var(--track)]" aria-hidden>
            <div className="h-full rounded-full bg-blue" style={{ width: total ? `${Math.min(100, (pos / total) * 100)}%` : "0%" }} />
          </div>
        </div>
        {total ? <span className="flex-none text-base tabular-nums text-[var(--muted)]">{state === "idle" ? narrationClock(total) : `${narrationClock(pos)} из ${narrationClock(total)}`}</span> : null}
      </div>
      {error && <p className="text-base text-[var(--crit)]" role="status">{error}</p>}
    </div>
  );
}

export function PropertyNarrationManager({ propertyId, placement = "media", factsKey }: { propertyId: string;
  /** card — короткий блок в колонке карточки объекта (20.11.2026); media — полный, во вкладке ролика, со служебным. */
  placement?: "card" | "media";
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
  // Второе нажатие, пока первое ещё в пути (двойной тап на телефоне): состояние React ещё не перерисовалось.
  const inFlight = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  const [now, setNow] = useState(() => Date.now());
  const latest = data?.versions[0];
  const factsType = data?.facts?.type;
  const freshPick = useMemo(() => data ? chooseNarration(data.config, factsType, { avoid: { templateId: data.lastChoice?.usedTemplateId ?? data.lastChoice?.templateId, endingId: data.lastChoice?.usedEndingId ?? data.lastChoice?.endingId } }) : null, [data, factsType]);
  useEffect(() => { setDraft({}); setEditing(false); setMessage(""); requestKey.current = crypto.randomUUID(); }, [propertyId]);
  const seenFacts = useRef(factsKey);
  useEffect(() => {
    if (factsKey === undefined || seenFacts.current === factsKey) return;
    seenFacts.current = factsKey;
    void client.invalidateQueries({ queryKey: ["property-narration", propertyId] });
  }, [client, factsKey, propertyId]);
  const state = data ? narrationCardState(data) : null;
  // Часы для «идёт N мин»: тикают только пока что-то идёт.
  useEffect(() => {
    if (state !== "pending" && state !== "mixing") return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [state]);

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage("");
    try { await action(); await client.invalidateQueries({ queryKey: key }); }
    catch (err) { setMessage(err instanceof Error ? err.message : "Действие не выполнено"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const loadAudio = (versionId: string) => async () => URL.createObjectURL(await api<Blob>(`/properties/${propertyId}/narration/${versionId}/audio`, { responseType: "blob" }));

  if (isPending) return placement === "card" ? null : <section className="card p-4" aria-busy="true">Загружаем озвучку…</section>;
  // В карточке ошибка доступа не нужна: блок просто не показывается. Сбой ПОВТОРНОГО опроса (связь моргнула,
  // пока готовится озвучка) блок не прячет: TanStack Query держит прежние данные, показываем их (18.11.2026).
  if (!data || !state) return placement === "card" ? null : <section className="card p-4" role="status">Озвучка недоступна: {error instanceof Error ? error.message : "не удалось загрузить"}</section>;
  if (placement === "card" && state === "hidden" && !editing) return null;

  const templates = data.config.templates ?? [];
  const endings = data.config.endings ?? [];
  const facts = data.facts;
  const canEdit = data.canDraft !== false;
  const published = data.published === true;
  const awaiting = state === "awaiting";
  // Устаревшая версия несёт прежнюю цену словами (ревью 14.11): её текст в форму не подставляем, только свежий шаблон.
  const currentScript = latest && !latest.stale ? latest.script : null;
  const last = data.lastChoice ?? {};
  const defaultTemplateId = latest?.templateId ?? freshPick?.templateId ?? null;
  const defaultEndingId = latest ? latest.endingId ?? null : freshPick?.endingId ?? null;
  const defaultVoiceId = pickNarrationVoice(data.config, latest?.voiceId ?? last.voiceId);
  const resolved = facts ? resolveNarrationDraft({ templates, endings, facts, value: draft, defaultTemplateId, defaultEndingId, defaultVoiceId, defaultScript: currentScript }) : null;
  const textOk = (resolved?.text.trim().length ?? 0) >= 10;
  // Поменяли текст или голос против текущей озвучки — утверждать старое аудио нельзя, только «Озвучить заново».
  const changedDraft = !!latest && !!resolved && (resolved.text !== latest.script || (resolved.voiceId ?? null) !== (latest.voiceId ?? null));
  // Перезаказ того же текста тем же голосом сервер отклоняет (UNCHANGED): кнопка ждёт правки, если озвучка цела.
  const needsChange = !!latest && !latest.stale && latest.status !== "FAILED" && !narrationIsPending(latest);
  // Готовое аудио с настоящей длиной (ревью 18.11): «Одобрить» решает замер, а не оценка по тексту; правят текст — снова оценка.
  const measured = awaiting && !(editing && changedDraft) && latest?.audioSec ? narrationAudioLengthCheck(latest.audioSec, data.clipSec ?? null) : null;
  const length = measured ?? (resolved ? narrationLengthCheck(resolved.text, resolved.lang, data.clipSec ?? null, data.charsPerSec) : null);
  // «Одобрить» закрыта, если голос (замер) или, без замера, оценка текста не влезает в ролик (как до 20.11).
  const audioTooLong = awaiting && !editing && !!length && !length.fits;
  const draftTooLong = !!length && !length.fits;
  const changesLine = narrationChangesLine(data.changed ?? []);
  const release = data.release ?? null;
  const removesOld = narrationRemovesOldPosts(data.config);
  const composerOpen = editing && canEdit && !!facts;
  const openEditor = () => { setDraft({}); setEditing(true); setMessage(""); };
  const closeEditor = () => { setDraft({}); setEditing(false); };

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

  const generatingMin = state === "pending" ? minutesSince(latest?.createdAt, now) : null;
  const mixingMin = state === "mixing" ? minutesSince(latest?.approvedAt, now) : null;

  // Заголовок и строка «что сейчас» — по состоянию; одна главная мысль на блок.
  const head: { title: string; line?: string; tone?: "ok" | "warn" } = (() => {
    switch (state) {
      case "off": return { title: "Без озвучки", line: "Для этого объекта выбрано «Без озвучки»: ничего не готовится, монтажёр знает." };
      case "hidden":
      case "none": return { title: "Озвучки пока нет", line: "Голос и текст можно выбрать заранее: монтажёр получит озвучку вместе с заданием на ролик." };
      case "pending": return { title: published ? "Готовим новую озвучку" : "Готовим озвучку",
        line: generatingMin !== null && generatingMin >= SLOW_GENERATION_MIN ? "Это дольше обычного. Если через несколько минут не придёт, руководство увидит сбой в журнале." : "Обычно минута-две. Придёт сюда и в Шабнам." };
      case "uncertain": return { title: "Озвучку проверяют", line: "Результат озвучки уточняет руководство. Как только сверят, можно будет озвучить заново.", tone: "warn" };
      case "failed": return { title: "Озвучка не получилась", tone: "warn",
        line: latest?.errorCode === QUOTA_EXCEEDED ? "Закончились кредиты ElevenLabs. Руководство уже видит это." : "Попробуйте ещё раз: проверьте голос и текст и нажмите «Озвучить»." };
      case "tooLong": return { title: "Текст длиннее ролика", line: "Озвучку не заказывали, кредиты не потрачены. Сократите текст и нажмите «Озвучить».", tone: "warn" };
      case "awaiting": return { title: "Новая озвучка готова", line: published ? "Послушайте. Если всё верно, утвердите: ролик с ней сразу выйдет." : "Послушайте и одобрите. Монтажёр получит её вместе с заданием на ролик." };
      case "marketingReview": return { title: "Аудио готово", line: "Его проверяет маркетинг." };
      case "draftSaved": return { title: "Текст сохранён", line: "Автоозвучка выключена: аудио по этому тексту подготовит маркетинг." };
      case "stale": return { title: "Озвучка устарела", line: `Данные объекта изменились.${data.autoGenerate ? " Новая подготовится сама через минуту." : " Озвучьте заново, чтобы цифры были верными."}`, tone: "warn" };
      case "mixing": return { title: "Накладываем озвучку на ролик",
        line: mixingMin !== null && mixingMin >= SLOW_MIX_MIN ? "Это дольше обычного. Если ролик не обновится в течение часа, сообщите руководству." : "Озвучка утверждена, CRM накладывает её на ролик. Обычно пара минут." };
      case "scheduled": {
        const when = release?.at ? narrationReleaseTime(release.at) : null;
        return { title: when ? `Ролик выйдет ${when.startsWith("в ") ? "сегодня " : ""}${when}` : "Ролик выйдет в ближайшее время", line: release?.reason ?? undefined };
      }
      case "publishing": return { title: "Ролик уходит в соцсети", line: "Старый пост в каждой сети CRM снимет, как только там выйдет новый." };
      case "done": return { title: "✓ Ролик с новой озвучкой вышел", tone: "ok" };
      case "mixFailed": return data.mix?.problem === "VOICE_LONGER"
        ? { title: "Озвучка длиннее ролика", tone: "warn", line: "Обрезать голос CRM не стала. Ролик ушёл монтажёру: он удлинит его под голос. Быстрее: сократить текст и озвучить заново." }
        : { title: "Озвучка не легла на ролик", tone: "warn", line: "Наложить новую озвучку не получилось, в соцсетях пока прежний ролик. Руководство видит ошибку." };
      default: return { title: "✓ Озвучка утверждена", tone: "ok",
        line: data.mix?.note ?? (data.mix?.hasMaster ? "Озвучку на ролик накладывает CRM: поменяются данные, звук обновится после вашего утверждения." : published ? undefined : "Монтажёр получит её вместе с заданием на ролик.") };
    }
  })();
  const line = head.line;

  const manualOrFailed = !!release?.channels.some((c) => c.state === "OLD_MANUAL" || c.state === "NEW_FAILED");
  const showComposerFor = !composerOpen && canEdit && !!facts;

  return (
    <section className={`card space-y-3 ${placement === "card" ? "p-4" : "p-4 sm:p-6"}`} aria-label="Озвучка ролика" data-narration-state={state}>
      <div className="flex items-start gap-3">
        {(state === "pending" || state === "mixing" || state === "publishing") && <span className="mt-1"><Busy label={state === "pending" ? "Готовим озвучку" : state === "mixing" ? "Накладываем озвучку" : "Публикуем"} /></span>}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[15px] text-[var(--muted)]">Озвучка ролика</p>
          <h3 className={`text-lg font-extrabold leading-snug sm:text-xl ${head.tone === "ok" ? "text-[var(--ok)]" : ""}`}>{head.title}</h3>
          {line && <p className={`text-base ${head.tone === "warn" ? "rounded-xl bg-[var(--warn-bg)] p-3" : "text-[var(--muted)]"}`} role="status">{line}</p>}
          {changesLine && (state === "pending" || awaiting) && <p className="text-base text-[var(--muted)]">{changesLine}</p>}
          {/* Сколько идёт — только у озвучки: начало известно точно. У наложения начала нет (ждёт выхода ролика). */}
          {state === "pending" && generatingMin !== null && <p className="text-[15px] text-[var(--muted)]">Идёт {Math.max(1, generatingMin)} мин</p>}
        </div>
      </div>

      {/* ПОСЛУШАТЬ И ОДОБРИТЬ — одно действие, кнопка сразу под плеером (20.11.2026). */}
      {awaiting && latest && !composerOpen && <div className="space-y-3">
        <NarrationPlayer key={latest.id} load={loadAudio(latest.id)} knownSec={latest.audioSec} primary={!data.canApproveAudio} disabled={busy} />
        {length && <p className={`rounded-xl px-3 py-2 text-base font-semibold ${length.fits ? "bg-[var(--ok-bg)] text-[var(--ok)]" : "bg-[var(--crit-bg)] text-[var(--crit)]"}`} role="status">
          {length.fits ? "✓ " : ""}{narrationLengthLine(length)}</p>}
        {data.canApproveAudio
          ? <button type="button" className="pill min-h-14! w-full justify-center bg-blue! text-lg! font-bold text-on-accent!" disabled={busy || audioTooLong} onClick={approve}>
              {audioTooLong ? "Сократите текст" : busy ? "Сохраняем…" : published ? "✓ Утвердить и выпустить" : "✓ Одобрить"}
            </button>
          : <p className="text-base text-[var(--muted)]">Эту озвучку одобряет владелец.</p>}
        {published && data.canApproveAudio && !audioTooLong && <p className="text-center text-[15px] text-[var(--muted)]">{removesOld
          ? "Ролик сразу уйдёт в соцсети, где он уже был. Старые посты CRM снимет сама."
          : "Ролик сразу уйдёт в соцсети. Старые посты останутся рядом: так задано в настройках."}</p>}
      </div>}

      {/* Утверждённая озвучка — послушать ещё раз маленькой кнопкой. */}
      {(state === "approved" || state === "mixFailed" || state === "marketingReview" || state === "done" || state === "scheduled") && latest?.hasAudio && !composerOpen && (
        <NarrationPlayer key={latest.id} load={loadAudio(latest.id)} knownSec={latest.audioSec} disabled={busy} />
      )}

      {release && release.channels.length > 0 && (state === "done" && !manualOrFailed
        ? <details><summary className="cursor-pointer text-base text-[var(--muted)]">По соцсетям</summary><div className="mt-2"><ChannelList channels={release.channels} /></div></details>
        : <ChannelList channels={release.channels} />)}

      {composerOpen && facts && <div className="space-y-3 border-t border-line pt-3">
        {!data.configured && <p className="rounded-xl bg-[var(--warn-bg)] p-3 text-base" role="status">Озвучка ещё не настроена руководством. Голос и текст можно выбрать уже сейчас.</p>}
        <NarrationComposer name={`${ids}-voice`} templates={templates} endings={endings} voices={data.config.voices} samples={data.samples} facts={facts} value={draft} onChange={setDraft}
          defaultTemplateId={defaultTemplateId} defaultEndingId={defaultEndingId} defaultVoiceId={defaultVoiceId} defaultScript={currentScript} lastPickedVoiceId={last.voiceId ?? null}
          recommendedVoiceId={data.config.defaultVoiceId ?? null} disabled={busy} lengthCheck={length} />
        <div className="space-y-2">
          {data.autoGenerate
            ? <button type="button" className="pill min-h-14! w-full justify-center bg-blue! text-lg! font-bold text-on-accent!"
                disabled={busy || !resolved?.voiceId || !textOk || draftTooLong || (needsChange && !changedDraft)} onClick={() => submit(true)}>
                {draftTooLong ? "Сократите текст" : busy ? "Отправляем…" : latest && latest.status !== "FAILED" ? "Озвучить заново" : "Озвучить"}
              </button>
            : <button type="button" className="pill min-h-12! text-base! w-full justify-center" disabled={busy || !textOk} onClick={() => submit(false)}>Сохранить текст</button>}
          {data.autoGenerate && needsChange && !changedDraft && <p className="text-center text-[15px] text-[var(--muted)]">Поменяйте голос или текст, чтобы озвучить заново.</p>}
          <button type="button" className="pill min-h-12! text-base! w-full justify-center ghost" disabled={busy} onClick={closeEditor}>Отмена</button>
          {data.autoGenerate && <p className="text-center text-[15px] text-[var(--muted)]">Новая озвучка придёт на прослушивание сюда и в Шабнам. Пока вы её не одобрите, ничего не меняется.</p>}
        </div>
      </div>}

      {/* Второе действие — переделать. Отдельной кнопкой, не вперемешку с «Одобрить». */}
      {showComposerFor && state !== "pending" && state !== "uncertain" && state !== "mixing" && state !== "publishing" && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`pill min-h-12! text-base! ${state === "none" || state === "hidden" || state === "failed" || state === "tooLong" || (state === "stale" && !data.autoGenerate) ? "" : "ghost"}`}
            disabled={busy} onClick={openEditor}>
            {state === "none" || state === "hidden" ? "Выбрать голос и текст" : state === "failed" || state === "tooLong" ? "Исправить и озвучить" : state === "stale" ? "Озвучить заново" : awaiting ? "Изменить голос или текст" : "Изменить озвучку"}
          </button>
          {placement === "media" && state !== "off" && !release && <button type="button" className="pill min-h-12! text-base! ghost" disabled={busy} onClick={() => setMode(true)}>Без озвучки</button>}
        </div>
      )}
      {state === "off" && canEdit && <button type="button" className="pill min-h-12! text-base!" disabled={busy} onClick={() => setMode(false)}>Включить озвучку</button>}

      {message && <p className="text-base" role="status">{message}</p>}
      {placement === "media" && (data.canApprove || data.canConfigure) && <PropertyNarrationService propertyId={propertyId} data={data} busy={busy} run={run} setMessage={setMessage}
        onListen={(id) => void run(async () => { const url = await loadAudio(id)(); void new Audio(url).play(); })} />}
    </section>
  );
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
                ? <a className="pill min-h-12! text-base! inline-flex items-center" href={c.url} target="_blank" rel="noreferrer">Открыть старый пост в {CHANNEL_NAME[c.channel] ?? c.channel}</a>
                : <p className="text-[15px] text-[var(--muted)]">Найдите старый ролик в приложении.</p>)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
