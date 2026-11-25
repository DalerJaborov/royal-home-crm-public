import { claimAudio, releaseAudio } from "./look/rhAudio";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chooseNarration, narrationAudioLengthCheck, narrationCurrencyError, narrationPriceProblem, narrationChangesLine, narrationLengthCheck, narrationLengthLine, narrationRemovesOldPosts, pickNarrationVoice,
  type NarrationReleaseChannel, type PropertyNarrationView,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { NarrationComposer, narrationListenFresh, resolveNarrationDraft, type NarrationDraft } from "./NarrationComposer";
import { PropertyNarrationService } from "./PropertyNarrationService";

/**
 * ОЗВУЧКА В КАРТОЧКЕ ОБЪЕКТА (14.11.2026; «поменял, послушал, утвердил» — 18.11.2026; разбор владельца 20.11.2026).
 *
 * 20.11 владелец: «захожу в любой объект, и первым выходит такое, как будто это не часть карточки». Поэтому:
 *   • место — в колонке карточки рядом со строкой «Ролик», ПОСЛЕ фото, цены и «кто ведёт» (PropertyDetail); если
 *     озвучка ждёт одобрения именно этого человека, наверху карточки короткая строка-ссылка к блоку (NarrationApprovalNudge);
 *   • блок — короткая карточка-статус: «Озвучка ролика», заголовок, одна строка, одна главная кнопка;
 *   • «послушать и одобрить» и «переделать» — два разных действия: «✓ Одобрить» стоит сразу под плеером, выбор голоса
 *     и текст открываются только по «Изменить голос или текст», назад — «Назад к прослушиванию»;
 *   • озвучки нет и ролик давно вышел (старые объекты) — в карточке блока нет вовсе, он остаётся во вкладке ролика;
 *   • «готовим» и «накладываем» — без выдуманной полосы на половине: значок хода и минуты от настоящего начала
 *     (ElevenLabs начал / CRM взяла ролик), дольше обычного — честная строка; упавшее наложение — «Попробовать ещё раз»;
 *   • свой плеер: длина известна серверу (audioSec), перемотка, запуск прямо в нажатии (Safari на iPhone иначе молчит).
 * Утверждение — одна дверь сервера (POST …/approve → approveNarrationVersion), её же зовёт Шабнам.
 * Техника (модель, ключ, пределы) — в Настройках; сверки и передачи — свёрнутый PropertyNarrationService.
 */

/** Код «кредиты ElevenLabs закончились» (apps/api/src/lib/propertyNarration.ts, NARRATION_QUOTA_EXCEEDED). */
const QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED";
/** Код «текст длиннее ролика, озвучка не заказана» (apps/api/src/lib/narrationAutoFlow.ts, NARRATION_TEXT_TOO_LONG). */
const TEXT_TOO_LONG = "TEXT_LONGER_THAN_CLIP";
/** Код «в тексте цена в долларах, не озвучено» (apps/api/src/lib/propertyNarration.ts, NARRATION_PRICE_NOT_IN_TJS). */
const PRICE_NOT_IN_TJS = "PRICE_NOT_IN_TJS";
/** После скольких минут «готовим» и «накладываем» честно говорят «дольше обычного». Наложение: метку сведения
 *  старше 15 минут сервер считает брошенной (NARRATION_MIX_CLAIM_STALE_MS) и берёт ролик заново. */
const SLOW_GENERATION_MIN = 5;
const SLOW_MIX_MIN = 15;
/** Наложение дольше этого — «дольше обычного» и кнопка «Проверить» (обычно 2–3 минуты). */
const LONG_MIX_MIN = 6;
/** Якорь блока: ссылка «Озвучка ждёт вашего одобрения» и ссылки из Шабнам (…/properties/<id>#rh-narration). */
export const NARRATION_ANCHOR = "rh-narration";

const CHANNEL_NAME: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", YOUTUBE: "YouTube", TELEGRAM: "Telegram", TIKTOK: "TikTok", THREADS: "Threads" };

function approvedMessage(delivery: string | undefined): string {
  if (delivery === "CRM_REMIX") return "Утверждено. Накладываем новую озвучку, ролик сразу уйдёт в соцсети.";
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
 * карточке нечего (старый объект: озвучки нет, ролик давно вышел). «noAudio» — версия READY, а файла нет;
 * «unknown» — сочетание, которого блок не ждал: нейтральная строка, а не «✓ утверждена» (ревью #334).
 */
export type NarrationCardState = "off" | "hidden" | "none" | "pending" | "uncertain" | "failed" | "tooLong" | "usdPrice" | "awaiting" | "marketingReview"
  | "draftSaved" | "noAudio" | "stale" | "mixing" | "scheduled" | "publishing" | "done" | "mixFailed" | "approved" | "unknown";
export function narrationCardState(data: PropertyNarrationView): NarrationCardState {
  const latest = data.versions[0];
  if (data.off) return "off";
  if (!latest) return data.published ? "hidden" : "none";
  if (narrationIsPending(latest)) return "pending";
  if (latest.status === "UNKNOWN" || (latest.status === "GENERATING" && latest.canReconcile)) return "uncertain";
  if (latest.status === "FAILED") return latest.errorCode === TEXT_TOO_LONG ? "tooLong" : latest.errorCode === PRICE_NOT_IN_TJS ? "usdPrice" : "failed";
  // Голос с ценой в долларах (собран до 21.11.2026): монтажёру не уходит и в ролик не сводится — агенту честная причина.
  if (latest.status === "READY" && narrationCurrencyError(latest.script)) return "usdPrice";
  if (data.release) return data.release.stage === "MIXING" ? "mixing" : data.release.stage === "SCHEDULED" ? "scheduled" : data.release.stage === "PUBLISHING" ? "publishing" : "done";
  if (latest.stale) return "stale";
  if (latest.status === "DRAFT") return "draftSaved";
  if (latest.status !== "READY") return "unknown";
  if (!latest.hasAudio) return "noAudio";
  const awaitsHuman = latest.awaitsHuman ?? (!latest.approvedAt && latest.source !== "MANUAL");
  if (awaitsHuman) return "awaiting";
  if (!latest.approvedAt) return latest.source === "MANUAL" ? "marketingReview" : "unknown";
  return data.mix?.problem ? "mixFailed" : "approved";
}
/** Ждёт ли озвучка одобрения именно этого человека (строка-напоминание наверху карточки). */
export function narrationAwaitsMe(data: PropertyNarrationView | undefined): boolean {
  return !!data && narrationCardState(data) === "awaiting" && data.canApproveAudio === true;
}

/** Ход без процентов: процент CRM не знает, поэтому не рисуем выдуманную половину полосы (было до 20.11). */
function Busy({ label }: { label: string }) {
  return <span className="inline-block h-5 w-5 flex-none animate-spin rounded-full border-[3px] border-blue/25 border-t-blue motion-reduce:animate-none" role="img" aria-label={label} />;
}

/**
 * ПЛЕЕР ОЗВУЧКИ (20.11.2026). Встроенный &lt;audio controls&gt; на телефоне показывал «00:27 / 00:00»: у mp3 без
 * заголовка длины браузер её не знает. Длину знает сервер (audioSec) — она и показывается; есть перемотка.
 *
 * Safari на iPhone пускает звук, только если play() вызван прямо в обработчике нажатия, а не после ожидания
 * (WebKit, «New video policies for iOS»: вызов после асинхронного события «не считается»). Поэтому запись
 * скачивается заранее (prefetch — у ждущей одобрения озвучки) и play() зовётся в нажатии без await перед ним.
 * Не скачана к нажатию — скачиваем и пробуем; браузер не пустил — «нажмите ещё раз» (запись уже есть, второе
 * нажатие сработает). Другая ошибка — понятный текст и штатный &lt;audio controls&gt; запасным вариантом.
 */
export function NarrationPlayer({ load, knownSec, primary, disabled, prefetch, label = "Послушать" }: {
  load: () => Promise<string>; knownSec: number | null | undefined; primary?: boolean; disabled?: boolean; prefetch?: boolean; label?: string;
}) {
  const el = useRef<HTMLAudioElement | null>(null);
  const stops = useRef<(() => void) | null>(null);
  const url = useRef<string | null>(null);
  const loading = useRef<Promise<string> | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "playing" | "paused" | "fallback">("idle");
  const [pos, setPos] = useState(0), [dur, setDur] = useState<number | null>(knownSec ?? null), [hint, setHint] = useState("");
  const loadRef = useRef(load);
  loadRef.current = load;

  function ensureLoaded(): Promise<string> {
    if (url.current) return Promise.resolve(url.current);
    loading.current ??= loadRef.current().then((u) => { url.current = u; return u; }).finally(() => { loading.current = null; });
    return loading.current;
  }
  function audioFor(u: string): HTMLAudioElement {
    if (el.current) return el.current;
    const audio = new Audio(u);
    audio.preload = "metadata";
    audio.ontimeupdate = () => setPos(audio.currentTime);
    // Длина у части записей приходит как Infinity или NaN — такие значения игнорируем, остаётся длина от сервера (audioSec).
    const syncDuration = () => { if (Number.isFinite(audio.duration) && audio.duration > 0) setDur(audio.duration); };
    audio.onloadedmetadata = syncDuration;
    audio.ondurationchange = syncDuration;
    // Один играющий звук на всё приложение (общий реестр с RhAudioPlayer): запуск озвучки гасит запись, и наоборот.
    const stop = () => audio.pause();
    stops.current = stop;
    audio.onplay = () => { claimAudio(stop); setState("playing"); };
    audio.onpause = () => setState((s) => (s === "playing" ? "paused" : s));
    audio.onended = () => { setState("paused"); setPos(0); audio.currentTime = 0; };
    el.current = audio;
    return audio;
  }
  function failed(err: unknown) {
    if (err instanceof DOMException && err.name === "NotAllowedError") { setState("ready"); setHint("Запись готова. Нажмите «Послушать» ещё раз."); return; }
    setState(url.current ? "fallback" : "idle");
    setHint(url.current ? "Встроенный плеер не справился, послушайте здесь:" : "Запись не загрузилась. Проверьте связь и нажмите ещё раз.");
  }
  useEffect(() => {
    if (!prefetch) return;
    ensureLoaded().then(() => setState((s) => (s === "idle" ? "ready" : s))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- скачиваем один раз на версию (key у плеера — id версии)
  }, [prefetch]);
  useEffect(() => () => { el.current?.pause(); if (stops.current) releaseAudio(stops.current); if (url.current) URL.revokeObjectURL(url.current); }, []);

  function toggle() {
    setHint("");
    if (state === "playing") { el.current?.pause(); return; }
    // Запись уже есть — play() прямо в нажатии, без ожидания перед ним (iPhone).
    if (url.current) { audioFor(url.current).play().catch(failed); return; }
    setState("loading");
    ensureLoaded().then((u) => audioFor(u).play()).catch(failed);
  }
  function seek(to: number) {
    const a = el.current;
    if (!a) return;
    a.currentTime = to;
    setPos(to);
  }
  const total = dur ?? knownSec ?? null;
  const playing = state === "playing";
  // Запасной вариант (ревью #338) — штатный <audio controls>: он работает на любом устройстве и в любом браузере, а ссылка на
  // blob в новой вкладке на iPhone не играет. Основной плеер выше — свой; сюда попадаем, только когда он не заиграл.
  if (state === "fallback" && url.current) return (
    <div className="space-y-2">
      <p className="text-base text-[var(--muted)]">{hint}</p>
      <audio className="w-full" controls src={url.current} />
    </div>
  );
  const buttonLabel = state === "loading" ? "Загружаем…" : playing ? "Пауза" : state === "paused" && pos > 0 ? "Дальше" : label;
  const shown = state === "idle" || state === "ready" ? 0 : pos;
  const percent = total ? Math.min(100, Math.max(0, (shown / total) * 100)) : 0;
  return (
    <div className="space-y-2" data-testid="narration-player">
      <div className="flex items-center gap-3 rounded-2xl bg-[var(--soft)] p-2 pr-4">
        <button type="button" aria-label={buttonLabel} disabled={disabled || state === "loading"} onClick={toggle}
          className={`grid h-14 w-14 flex-none place-items-center rounded-full text-xl ${primary ? "bg-blue text-on-accent" : "bg-[var(--card)] shadow-sm"} disabled:opacity-60`}>
          <span aria-hidden>{state === "loading" ? "…" : playing ? <Pause size={22} /> : <Play size={22} />}</span>
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <input type="range" className="block w-full accent-[rgb(var(--rgb-accent))]" min={0} max={total ?? 0} step={0.1} value={Math.min(pos, total ?? 0)}
            style={{ background: "transparent" }} data-percent={percent.toFixed(0)}
            disabled={!el.current || !total} aria-label="Перемотать запись" aria-valuetext={`${narrationClock(pos)} из ${narrationClock(total ?? 0)}`}
            onChange={(e) => seek(Number(e.target.value))} />
          <p className="flex justify-between text-base tabular-nums text-[var(--muted)]"><span>{buttonLabel === label || state === "loading" ? label : buttonLabel}</span>
            <span data-testid="narration-clock">{total ? `${narrationClock(shown)} / ${narrationClock(total)}` : narrationClock(shown)}</span></p>
        </div>
      </div>
      {hint && <p className="text-base text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

/**
 * «СКАЧАТЬ ОЗВУЧКУ» (25.11.2026, объект №231): сотрудник отдал ролик монтажёру мимо CRM, озвучка осталась в CRM, а
 * достать файл было нельзя — только послушать. Файл тот же, что слушает плеер (GET …/narration/<версия>/audio), имя —
 * «ozvuchka-ob231.mp3». Запись берётся тем же запросом через api(), чтобы шла авторизация (простая ссылка её не несёт).
 */
export function NarrationDownloadButton({ load, fileName, disabled }: { load: () => Promise<string>; fileName: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  async function download() {
    setState("loading");
    try {
      const url = await load();
      const a = document.createElement("a");
      a.href = url; a.download = fileName; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState("idle");
    } catch { setState("error"); }
  }
  return (
    <div className="space-y-1">
      <button type="button" className="pill ghost min-h-12! text-base!" disabled={disabled || state === "loading"} onClick={() => void download()}>
        {state === "loading" ? "Скачиваем…" : "Скачать озвучку (mp3)"}
      </button>
      {state === "error" && <p className="text-base text-[var(--muted)]" role="status">Не получилось скачать. Проверьте связь и нажмите ещё раз.</p>}
    </div>
  );
}
/** Имя файла: номер объекта, если сервер его прислал; иначе просто «ozvuchka». */
export function narrationFileName(code: number | undefined | null): string {
  return code ? `ozvuchka-ob${code}.mp3` : "ozvuchka.mp3";
}

/** Общий запрос блока: строка-напоминание наверху и сам блок берут его из одного кэша, второго запроса нет. */
function useNarrationView(propertyId: string, enabled = true) {
  return useQuery({
    queryKey: ["property-narration", propertyId], queryFn: () => api<PropertyNarrationView>(`/properties/${propertyId}/narration`), retry: false, enabled,
    refetchInterval: (q) => narrationIsPending(q.state.data?.versions[0]) ? 5000 : narrationReleaseMoving(q.state.data) ? 10_000 : false,
  });
}

/**
 * НАПОМИНАНИЕ НАВЕРХУ КАРТОЧКИ (ревью #334, 20.11.2026): блок озвучки теперь ниже первого экрана на ПК, и о
 * ждущей одобрения озвучке сверху ничего не говорило. Короткая строка-ссылка к блоку — только когда одобрить
 * должен именно этот человек; остальным и в остальное время её нет.
 */
export function NarrationApprovalNudge({ propertyId, onOpen }: { propertyId: string;
  /** Блок живёт во вкладке «Обзор» («Новый вид»): открыть её перед прокруткой, если человек на другой вкладке. */
  onOpen?: () => void }) {
  const { data } = useNarrationView(propertyId);
  if (!narrationAwaitsMe(data)) return null;
  return (
    <a href={`#${NARRATION_ANCHOR}`} className="card flex min-h-12 items-center gap-3 px-4 py-3 text-base font-semibold no-underline"
      onClick={(e) => { e.preventDefault(); onOpen?.(); window.setTimeout(scrollToNarration, onOpen ? 60 : 0); }}>
      <span className="h-2.5 w-2.5 flex-none rounded-full bg-blue" aria-hidden />
      <span className="flex-1">Озвучка ждёт вашего одобрения</span>
      <span className="text-[var(--muted)]" aria-hidden>↓</span>
    </a>
  );
}
function scrollToNarration() {
  const target = document.getElementById(NARRATION_ANCHOR);
  if (!target) return;
  target.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  if (window.location.hash !== `#${NARRATION_ANCHOR}`) window.history.replaceState(window.history.state, "", `#${NARRATION_ANCHOR}`);
}

export function PropertyNarrationManager({ propertyId, placement = "media", factsKey }: { propertyId: string;
  /** card — короткий блок в колонке карточки объекта (20.11.2026); media — полный, во вкладке ролика, со служебным. */
  placement?: "card" | "media";
  /** Факты озвучки из карточки (цена, этаж…): поменялись после «Сохранить» — блок сразу спрашивает сервер заново. */
  factsKey?: string }) {
  const client = useQueryClient();
  const ids = useId();
  const key = ["property-narration", propertyId];
  const { data, error, isPending } = useNarrationView(propertyId);
  const [draft, setDraft] = useState<NarrationDraft>({});
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [confirmSame, setConfirmSame] = useState(false);
  const [serviceVersion, setServiceVersion] = useState<string | null>(null);
  // Второе нажатие, пока первое ещё в пути (двойной тап на телефоне): состояние React ещё не перерисовалось.
  const inFlight = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  const [now, setNow] = useState(() => Date.now());
  const latest = data?.versions[0];
  const factsType = data?.facts?.type;
  const freshPick = useMemo(() => data ? chooseNarration(data.config, factsType, { avoid: { templateId: data.lastChoice?.usedTemplateId ?? data.lastChoice?.templateId, endingId: data.lastChoice?.usedEndingId ?? data.lastChoice?.endingId } }) : null, [data, factsType]);
  useEffect(() => { setDraft({}); setEditing(false); setConfirmSame(false); setMessage(""); requestKey.current = crypto.randomUUID(); }, [propertyId]);
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
  // Ссылка …/properties/<id>#rh-narration (Шабнам, строка-напоминание): блок появился — прокрутить к нему один раз.
  const scrolled = useRef(false);
  useEffect(() => {
    if (placement !== "card" || !state || scrolled.current || window.location.hash !== `#${NARRATION_ANCHOR}`) return;
    scrolled.current = true;
    scrollToNarration();
  }, [placement, state]);

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
  // Почему цена не звучит в голосе (ревью #348): агент видит причину, а не «цена куда-то пропала».
  const priceProblem = facts && state !== "off" && state !== "usdPrice" ? narrationPriceProblem(facts) : null;
  const pricePlainNote = priceProblem === "NO_RATE" ? "Цена в озвучке не звучит: в Настройках не задан курс доллара, а цену говорим только в сомони."
    : priceProblem === "CURRENCY_SUSPECT" ? "Цена в озвучке не звучит: валюта цены похожа на перепутанную. Проверьте цену и валюту в карточке." : null;
  const canEdit = data.canDraft !== false;
  const published = data.published === true;
  const awaiting = state === "awaiting";
  // Устаревшая версия несёт прежнюю цену словами (ревью 14.11): её текст в форму не подставляем, только свежий шаблон.
  const currentScript = latest && !latest.stale ? latest.script : null;
  const last = data.lastChoice ?? {};
  const defaultTemplateId = latest?.templateId ?? freshPick?.templateId ?? null;
  const defaultEndingId = latest ? latest.endingId ?? null : freshPick?.endingId ?? null;
  const defaultVoiceId = pickNarrationVoice(data.config, latest?.voiceId ?? last.voiceId);
  const resolved = facts ? resolveNarrationDraft({ templates, endings, facts, value: draft, defaultTemplateId, defaultEndingId, defaultVoiceId, defaultScript: currentScript, liveWords: data.config.liveWords === true }) : null;
  const listenedFresh = !!resolved && narrationListenFresh(draft.listened, resolved);
  const textOk = (resolved?.text.trim().length ?? 0) >= 10;
  // Поменяли текст или голос против текущей озвучки — утверждать старое аудио нельзя, только «Озвучить заново».
  const changedDraft = !!latest && !!resolved && (resolved.text !== latest.script || (resolved.voiceId ?? null) !== (latest.voiceId ?? null));
  // Готовая озвучка с файлом и тот же текст тем же голосом — переделка возможна (не понравилась интонация), но это
  // новая платная озвучка: сервер её примет, поэтому спрашиваем явно (ревью #334). Без аудио спрашивать не о чем.
  const sameAsReady = !!latest && latest.status === "READY" && latest.hasAudio && !latest.stale && !changedDraft;
  // Готовое аудио с настоящей длиной (ревью 18.11): «Одобрить» решает замер, а не оценка по тексту; правят текст — снова оценка.
  const measured = awaiting && !(editing && changedDraft) && latest?.audioSec ? narrationAudioLengthCheck(latest.audioSec, data.clipSec ?? null) : null;
  const length = measured ?? (resolved ? narrationLengthCheck(resolved.text, resolved.lang, data.clipSec ?? null, data.charsPerSec) : null);
  // «Одобрить» закрыта, если голос (замер) или, без замера, оценка текста не влезает в ролик (как до 20.11).
  const approveTooLong = awaiting && !editing && !!length && !length.fits;
  const draftTooLong = !!length && !length.fits;
  const changesLine = narrationChangesLine(data.changed ?? []);
  const release = data.release ?? null;
  const removesOld = narrationRemovesOldPosts(data.config);
  const composerOpen = editing && canEdit && !!facts;
  const hasAudioToReturnTo = !!latest?.hasAudio && latest.status === "READY";
  const openEditor = () => { setDraft({}); setEditing(true); setConfirmSame(false); setMessage(""); };
  const closeEditor = () => { setDraft({}); setEditing(false); setConfirmSame(false); };

  const submit = (generate: boolean) => void run(async () => {
    if (!resolved) return;
    await api(`/properties/${propertyId}/narration`, { method: "POST", body: {
      expectedRevision: latest?.revision ?? 0, requestKey: requestKey.current, script: resolved.text,
      ...(resolved.templateId ? { templateId: resolved.templateId } : {}), endingId: resolved.endingId, ...(resolved.voiceId ? { voiceId: resolved.voiceId } : {}), ...(generate ? { generate: true } : {}),
      // Прослушанный здесь же звук (21.11.2026): сервер сверит текст и голос и возьмёт его без второй оплаты.
      ...(generate && listenedFresh && draft.listened ? { listenId: draft.listened.id } : {}),
    } });
    requestKey.current = crypto.randomUUID(); setDraft({}); setEditing(false); setConfirmSame(false);
    // «Озвучить» = одобрить (21.11.2026, владелец: «сверх быстро»): просьбы «прослушайте» потом не будет.
    setMessage(!generate ? "Текст сохранён. Аудио по нему подготовит маркетинг."
      : listenedFresh ? "Озвучка одобрена вами и уходит монтажёру." : "Озвучка одобрена вами: уйдёт монтажёру, как только будет готова (обычно минута-две).");
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
  const retryMix = () => void run(async () => {
    const result = await api<{ message: string }>(`/properties/${propertyId}/narration/remix-retry`, { method: "POST", body: {} });
    setMessage(result.message);
  });

  // «Идёт N мин» — от настоящего начала: ElevenLabs начал озвучивать / CRM взяла ролик. Без начала — «в очереди».
  const generatingMin = state === "pending" && latest?.status === "GENERATING" ? minutesSince(latest.generationStartedAt, now) : null;
  const mixingMin = state === "mixing" ? minutesSince(release?.since, now) : null;

  // Заголовок и строка «что сейчас» — по состоянию; одна главная мысль на блок. Открыта правка — заголовок правки.
  const head: { title: string; line?: string; tone?: "ok" | "warn" } = composerOpen
    ? { title: "Изменить голос или текст", line: "Новая озвучка придёт на прослушивание сюда и в Шабнам. Пока вы её не одобрите, ничего не меняется." }
    : (() => {
    switch (state) {
      case "off": return { title: "Без озвучки", line: "Для этого объекта выбрано «Без озвучки»: ничего не готовится, монтажёр знает." };
      case "hidden":
      case "none": return { title: "Озвучки пока нет", line: "Голос и текст можно выбрать заранее: монтажёр получит озвучку вместе с заданием на ролик." };
      case "pending": return { title: published ? "Готовим новую озвучку" : "Готовим озвучку",
        line: latest?.status !== "GENERATING" ? (data.sendsEnabled === false
            ? "Озвучка в очереди. Отправка озвучки на сервере сейчас выключена: начнётся, когда её включат."
            : "Озвучка в очереди, начнётся через минуту. Придёт сюда и в Шабнам.")
          : generatingMin !== null && generatingMin >= SLOW_GENERATION_MIN ? "Это дольше обычного. Если через несколько минут не придёт, руководство увидит сбой в журнале."
          : "Обычно минута-две. Придёт сюда и в Шабнам." };
      case "uncertain": return { title: "Озвучку проверяют", line: "Результат озвучки уточняет руководство. Как только сверят, можно будет озвучить заново.", tone: "warn" };
      case "failed": return { title: "Озвучка не получилась", tone: "warn",
        line: latest?.errorCode === QUOTA_EXCEEDED ? "Закончились кредиты ElevenLabs. Руководство уже видит это." : "Попробуйте ещё раз: проверьте голос и текст и нажмите «Озвучить»." };
      case "usdPrice": return { title: "В озвучке цена в долларах", tone: "warn",
        line: "Такой голос не одобряем и монтажёру не отправляем: цену говорим только в сомони. Нажмите «Исправить и озвучить»: текст соберётся с ценой в сомони." };
      case "tooLong": return { title: "Текст длиннее ролика", line: "Озвучку не заказывали, кредиты не потрачены. Сократите текст и нажмите «Озвучить».", tone: "warn" };
      // Заголовок зовёт послушать, строка говорит, что будет после одобрения: два раза одно и то же не пишем (владелец 20.11).
      case "awaiting": return { title: "Послушайте новую озвучку", line: published ? "Если всё верно, утвердите: ролик с ней сразу выйдет." : "Если всё верно, одобрите: монтажёр получит её вместе с заданием на ролик." };
      case "marketingReview": return { title: "Аудио готово", line: "Его проверяет маркетинг." };
      case "draftSaved": return data.autoGenerate
        ? { title: "Текст сохранён", line: "Озвучки по нему ещё нет. Откройте и нажмите «Озвучить»." }
        : { title: "Текст сохранён", line: "Автоозвучка выключена: аудио по этому тексту подготовит маркетинг." };
      case "noAudio": return { title: "Файл озвучки не найден", tone: "warn", line: "Запись не сохранилась на сервере. Озвучьте заново." };
      case "stale": return { title: "Озвучка устарела", line: `Данные объекта изменились.${data.autoGenerate ? " Новая подготовится сама через минуту." : " Озвучьте заново, чтобы цифры были верными."}`, tone: "warn" };
      case "mixing": return { title: "Накладываем озвучку на ролик",
        line: release?.since == null ? "Озвучка утверждена. Ролик в очереди на наложение, возьмём его в ближайшие минуты."
          : mixingMin !== null && mixingMin >= SLOW_MIX_MIN ? "Это дольше обычного. Мы попробуем ещё раз сами; не получится — здесь появится кнопка повтора."
          : mixingMin !== null && mixingMin >= LONG_MIX_MIN ? "Дольше обычного, ещё немного. Если не дождётесь, нажмите «Проверить»."
          : "Накладываем озвучку на ролик, обычно 2–3 минуты." };
      case "scheduled": {
        const when = release?.at ? narrationReleaseTime(release.at) : null;
        return { title: when ? `Ролик выйдет ${when.startsWith("в ") ? "сегодня " : ""}${when}` : "Ролик выйдет в ближайшее время", line: release?.reason ?? undefined };
      }
      case "publishing": return { title: "Ролик уходит в соцсети", line: "Старый пост в каждой сети CRM снимет, как только там выйдет новый." };
      case "done": return { title: "✓ Ролик с новой озвучкой вышел", tone: "ok" };
      case "mixFailed": return data.mix?.problem === "VOICE_LONGER"
        ? { title: "Озвучка длиннее ролика", tone: "warn", line: "Обрезать голос мы не стали. Ролик ушёл монтажёру: он удлинит его под голос. Быстрее: сократить текст и озвучить заново." }
        : { title: "Озвучка не легла на ролик", tone: "warn", line: "Наложить новую озвучку не получилось, в соцсетях пока прежний ролик. Руководство видит ошибку." };
      case "approved": return { title: "✓ Озвучка утверждена", tone: "ok",
        line: data.mix?.note ?? (data.mix?.hasMaster ? "Озвучку на ролик накладываем мы: данные поменяются, а звук обновится после вашего утверждения." : published ? undefined : "Монтажёр получит её вместе с заданием на ролик.") };
      default: return { title: "Озвучка ролика", line: "Состояние озвучки уточняется. Обновите карточку через минуту." };
    }
  })();

  const manualOrFailed = !!release?.channels.some((c) => c.state === "OLD_MANUAL" || c.state === "NEW_FAILED");
  const running = state === "pending" || state === "mixing" || state === "publishing";
  // «Изменить» не предлагается, пока идёт работа, при «Без озвучки» и пока результат сверяют.
  const canOpenEditor = !composerOpen && canEdit && !!facts && !running && state !== "uncertain" && state !== "off";
  // «Без озвучки» — только во вкладке ролика (не на главном пути), в том числе пока озвучка готовится, накладывается или
  // её сверяют (ревью #334); когда ролик с ней уже вышел или выходит — уже поздно.
  const canTurnOff = placement === "media" && canEdit && state !== "off" && state !== "scheduled" && state !== "publishing" && state !== "done";
  const editLabel = state === "none" || state === "hidden" ? "Выбрать голос и текст" : state === "failed" || state === "tooLong" || state === "usdPrice" ? "Исправить и озвучить"
    : state === "stale" || state === "noAudio" ? "Озвучить заново" : state === "draftSaved" ? "Открыть текст" : awaiting ? "Изменить голос или текст" : "Изменить озвучку";
  const editIsMain = state === "none" || state === "hidden" || state === "failed" || state === "tooLong" || state === "usdPrice" || state === "noAudio" || state === "draftSaved" || (state === "stale" && !data.autoGenerate);

  return (
    <section className={`card space-y-3 ${placement === "card" ? "p-4" : "p-4 sm:p-6"}`} aria-label="Озвучка ролика" data-narration-state={composerOpen ? "editing" : state}>
      <div className="flex items-start gap-3">
        {running && !composerOpen && <span className="mt-1"><Busy label={state === "pending" ? "Готовим озвучку" : state === "mixing" ? "Накладываем озвучку" : "Публикуем"} /></span>}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[15px] text-[var(--muted)]">Озвучка ролика</p>
          <h3 className={`text-lg font-extrabold leading-snug sm:text-xl ${head.tone === "ok" ? "text-[var(--ok)]" : ""}`}>{head.title}</h3>
          {/* Одна живая строка на блок (ревью #334): что сейчас и ответ на последнее действие. */}
          <div className="space-y-1" role="status">
            {head.line && <p className={`text-base ${head.tone === "warn" ? "rounded-xl bg-[var(--warn-bg)] p-3" : "text-[var(--muted)]"}`}>{head.line}</p>}
            {message && <p className="text-base">{message}</p>}
            {pricePlainNote && <p className="text-[15px] text-[var(--muted)]" data-testid="narration-price-note">{pricePlainNote}</p>}
          </div>
          {changesLine && !composerOpen && (state === "pending" || awaiting) && <p className="text-base text-[var(--muted)]">{changesLine}</p>}
          {!composerOpen && (generatingMin !== null || mixingMin !== null) && <p className="text-[15px] text-[var(--muted)]" data-testid="narration-progress-note">
            {state === "mixing" && release?.since ? `Начали ${narrationReleaseTime(release.since)} · идёт ${Math.max(1, mixingMin ?? 1)} мин` : `Идёт ${Math.max(1, (generatingMin ?? mixingMin) ?? 1)} мин`}</p>}
          {!composerOpen && state === "mixing" && mixingMin !== null && mixingMin >= LONG_MIX_MIN && (
            <button type="button" className="pill min-h-12! text-base!" disabled={busy} onClick={() => void client.invalidateQueries({ queryKey: key })}>Проверить</button>
          )}
        </div>
      </div>

      {composerOpen && hasAudioToReturnTo && (
        <button type="button" className="pill min-h-12! text-base!" disabled={busy} onClick={closeEditor}>← Назад к прослушиванию</button>
      )}

      {/* ПОСЛУШАТЬ И ОДОБРИТЬ — одно действие, кнопка сразу под плеером (20.11.2026). */}
      {awaiting && latest && !composerOpen && <div className="space-y-3">
        <NarrationPlayer key={latest.id} load={loadAudio(latest.id)} knownSec={latest.audioSec} primary={!data.canApproveAudio} disabled={busy} prefetch />
        <NarrationDownloadButton load={loadAudio(latest.id)} fileName={narrationFileName(data.propertyCode)} disabled={busy} />
        {length && <p className={`rounded-xl px-3 py-2 text-base font-semibold ${length.fits ? "bg-[var(--ok-bg)] text-[var(--ok)]" : "bg-[var(--crit-bg)] text-[var(--crit)]"}`}>
          {length.fits ? "✓ " : ""}{narrationLengthLine(length)}</p>}
        {data.canApproveAudio
          ? <button type="button" className="pill min-h-14! w-full justify-center bg-blue! text-lg! font-bold text-on-accent!" disabled={busy || approveTooLong} onClick={approve}>
              {approveTooLong ? "Сократите текст" : busy ? "Сохраняем…" : published ? "✓ Утвердить и выпустить" : "✓ Одобрить"}
            </button>
          : <p className="text-base text-[var(--muted)]">Эту озвучку одобряет владелец.</p>}
        {published && data.canApproveAudio && !approveTooLong && <p className="text-center text-[15px] text-[var(--muted)]">{removesOld
          ? "Ролик сразу уйдёт в соцсети, где он уже был. Старые посты CRM снимет сама."
          : "Ролик сразу уйдёт в соцсети. Старые посты останутся рядом: так задано в настройках."}</p>}
      </div>}

      {/* Утверждённая озвучка — послушать ещё раз второстепенной кнопкой. */}
      {(state === "approved" || state === "mixFailed" || state === "marketingReview" || state === "done" || state === "scheduled") && latest?.hasAudio && !composerOpen && (
        <div className="space-y-2">
          <NarrationPlayer key={latest.id} load={loadAudio(latest.id)} knownSec={latest.audioSec} disabled={busy} />
          <NarrationDownloadButton load={loadAudio(latest.id)} fileName={narrationFileName(data.propertyCode)} disabled={busy} />
        </div>
      )}

      {state === "mixFailed" && data.mix?.canRetry && canEdit && !composerOpen && (
        <button type="button" className="pill min-h-12! text-base!" disabled={busy} onClick={retryMix}>Попробовать ещё раз</button>
      )}

      {release && release.channels.length > 0 && !composerOpen && (state === "done" && !manualOrFailed
        ? <details><summary className="cursor-pointer text-base text-[var(--muted)]">По соцсетям</summary><div className="mt-2"><ChannelList channels={release.channels} /></div></details>
        : <ChannelList channels={release.channels} />)}

      {composerOpen && facts && <div className="space-y-3 border-t border-line pt-3">
        {!data.configured && <p className="rounded-xl bg-[var(--warn-bg)] p-3 text-base">Озвучка ещё не настроена руководством. Голос и текст можно выбрать уже сейчас.</p>}
        <NarrationComposer name={`${ids}-voice`} templates={templates} endings={endings} voices={data.config.voices} samples={data.samples} facts={facts} liveWords={data.config.liveWords === true} value={draft}
          onChange={(next) => { setDraft(next); setConfirmSame(false); }}
          defaultTemplateId={defaultTemplateId} defaultEndingId={defaultEndingId} defaultVoiceId={defaultVoiceId} defaultScript={currentScript} lastPickedVoiceId={last.voiceId ?? null}
          recommendedVoiceId={data.config.defaultVoiceId ?? null} disabled={busy} lengthCheck={length} canListen={!!data.autoGenerate} />
        <div className="space-y-2">
          {data.autoGenerate
            ? confirmSame
              ? <div className="space-y-2 rounded-2xl bg-[var(--warn-bg)] p-3">
                  <p className="text-base font-semibold">Переделать с тем же текстом и голосом? Это новая платная озвучка.</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="pill min-h-12! text-base! bg-blue! text-on-accent!" disabled={busy} onClick={() => submit(true)}>Да, переделать</button>
                    <button type="button" className="pill min-h-12! text-base! ghost" disabled={busy} onClick={() => setConfirmSame(false)}>Нет</button>
                  </div>
                </div>
              : <button type="button" className="pill min-h-14! w-full justify-center bg-blue! text-lg! font-bold text-on-accent!"
                  disabled={busy || !resolved?.voiceId || !textOk || draftTooLong} onClick={() => sameAsReady ? setConfirmSame(true) : submit(true)}>
                  {draftTooLong ? "Сократите текст" : busy ? "Отправляем…" : latest && latest.status !== "FAILED" && latest.status !== "DRAFT" ? "Озвучить заново" : "Озвучить"}
                </button>
            : <button type="button" className="pill min-h-12! text-base! w-full justify-center" disabled={busy || !textOk} onClick={() => submit(false)}>Сохранить текст</button>}
          {!hasAudioToReturnTo && <button type="button" className="pill min-h-12! text-base! w-full justify-center ghost" disabled={busy} onClick={closeEditor}>Отмена</button>}
        </div>
      </div>}

      {(canOpenEditor || canTurnOff) && (
        <div className="flex flex-wrap items-center gap-2">
          {canOpenEditor && <button type="button" className={`pill min-h-12! text-base! ${editIsMain ? "" : "ghost"}`} disabled={busy} onClick={openEditor}>{editLabel}</button>}
          {canTurnOff && !composerOpen && <button type="button" className="pill min-h-12! text-base! ghost" disabled={busy} onClick={() => setMode(true)}>Без озвучки</button>}
        </div>
      )}
      {state === "off" && canEdit && <button type="button" className="pill min-h-12! text-base!" disabled={busy} onClick={() => setMode(false)}>Включить озвучку</button>}

      {placement === "media" && (data.canApprove || data.canConfigure) && <>
        <PropertyNarrationService propertyId={propertyId} data={data} busy={busy} run={run} setMessage={setMessage} onListen={(id) => setServiceVersion(id)} />
        {/* Старые версии — тем же плеером (ревью #334): остановка, длина, перемотка, понятная ошибка. */}
        {serviceVersion && <NarrationPlayer key={serviceVersion} load={loadAudio(serviceVersion)} prefetch label="Послушать версию"
          knownSec={data.versions.find((v) => v.id === serviceVersion)?.audioSec} />}
      </>}
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
