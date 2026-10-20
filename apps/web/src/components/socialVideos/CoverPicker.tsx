import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Ban, Check, ChevronDown, ImagePlus, Loader2, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import {
  SOCIAL_VIDEO_COVER_MAX_BYTES,
  SOCIAL_VIDEO_COVER_MIME_TYPES,
  SOCIAL_VIDEO_COVER_MODE_LABELS,
  SOCIAL_VIDEO_COVER_MODES,
  SOCIAL_VIDEO_COVER_PROVIDERS,
  SOCIAL_VIDEO_COVER_PROVIDER_LABELS,
  formatBytesRu,
} from "@royal-home/shared";
import type { SocialVideoCoverMeta, SocialVideoCoverMode, SocialVideoCoverProvider } from "@royal-home/shared";
import { useRefreshSocialVideoTrends, useSocialVideoAiProviders, useSocialVideoTrends } from "../../hooks/useSocialVideos";
import { exactDateTime } from "../../lib/format";
import { coverMetaText, effectiveProvider } from "../../lib/socialVideoDestinations";

/**
 * Обложка ролика: без обложки, своя картинка или рисует ИИ.
 *
 * Три плитки переключают только то, что видно на экране; сама обложка меняется,
 * когда человек загрузил файл или нажал «Нарисовать». Так щелчок по плитке
 * «Без обложки» не стирает готовую обложку случайно — стереть можно отдельной
 * кнопкой.
 *
 * ОШИБКИ СЕРВЕРА ПОКАЗЫВАЮТСЯ КАК ЕСТЬ (`error`): в том числе «ИИ недоступен»
 * (у провайдера закончились деньги) — это решение владельца, текст не переписываем.
 * В тексте уже есть совет переключить провайдера.
 *
 * ИИ-обложка (12.10.2026): «Кто рисует» — Gemini по умолчанию, ChatGPT переключателем;
 * недоступный провайдер (нет ключа) серый, с причиной. «Взять кадр из ролика» и
 * «Учесть свежие тренды» включены. Список провайдеров и тренды грузятся только когда
 * открыта вкладка «Нарисует ИИ» — остальным режимам они не нужны.
 */
export interface CoverAiOptions {
  prompt: string;
  provider: SocialVideoCoverProvider;
  useFrame: boolean;
  useTrends: boolean;
}

export interface CoverPickerProps {
  mode: SocialVideoCoverMode;
  coverUrl: string | null;
  busy: "upload" | "ai" | "clear" | null;
  error: string | null;
  disabled?: boolean;
  onUpload(file: File): void;
  onGenerateAi(options: CoverAiOptions): void;
  onClear(): void;
  /** Чем нарисована текущая обложка (режим «ИИ»). */
  coverMeta?: SocialVideoCoverMeta | null;
}

const MODE_META: Record<SocialVideoCoverMode, { Icon: typeof Ban; hint: string }> = {
  NONE: { Icon: Ban, hint: "Сети возьмут кадр сами" },
  UPLOAD: { Icon: ImagePlus, hint: "JPEG, PNG или WebP" },
  AI: { Icon: Sparkles, hint: "По описанию, 20–90 секунд" },
};

/** Сколько секунд идёт рисование — чтобы ожидание не выглядело зависанием. */
function useElapsedSeconds(active: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) {
      setSec(0);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => setSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return sec;
}

function CheckRow({ checked, disabled, onChange, children }: { checked: boolean; disabled: boolean; onChange(v: boolean): void; children: ReactNode }) {
  const uid = useId();
  return (
    <label htmlFor={uid} className={`flex items-center gap-2.5 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
      <input id={uid} type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden="true"
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 transition-colors peer-focus-visible:shadow-[0_0_0_2px_rgb(var(--rgb-accent))] ${
          checked ? "border-blue bg-blue text-on-accent" : "border-gray-300 bg-card-solid text-transparent"
        }`}
      >
        <Check size={14} strokeWidth={3} />
      </span>
      <span className="text-[14px] font-semibold text-gray-800">{children}</span>
    </label>
  );
}

/** Сворачиваемая плашка «Какие тренды учтём»: свежая сводка, откуда она и кнопка обновления. */
function TrendsPanel({ disabled }: { disabled: boolean }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const trends = useSocialVideoTrends(true);
  const refresh = useRefreshSocialVideoTrends();
  const data = trends.data;
  const sameDay = data ? new Date(data.updatedAt).toDateString() === new Date().toDateString() : false;
  const sourceText = !data
    ? ""
    : data.source === "LIVE"
      ? sameDay
        ? "найдено в интернете сегодня"
        : "найдено в интернете"
      : "общие правила, поиск недоступен";
  const failed = refresh.isError ? refresh.error : trends.isError ? trends.error : null;

  return (
    <div className="rounded-lg bg-ink/5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${uid}-trends`}
        onClick={() => setOpen((v) => !v)}
        className="flex! min-h-[44px]! w-full! items-center! justify-between! gap-2! rounded-lg! px-3! text-left! text-[14px]! font-semibold! text-gray-800! hover:bg-hover-tint!"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles size={15} className="shrink-0 text-blue" aria-hidden="true" />
          Какие тренды учтём
          {trends.isLoading && <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />}
        </span>
        <ChevronDown size={16} className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={`${uid}-trends`} className="flex flex-col gap-2 px-3 pb-3">
          {trends.isLoading && <p className="m-0 text-[13px] text-gray-600">Ищем свежие тренды…</p>}
          {data && (
            <>
              <p className="m-0 text-[13px] text-gray-600">
                {sourceText} · {exactDateTime(data.updatedAt)}
              </p>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-[14px] leading-snug text-gray-800">
                {data.digest.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          {failed && (
            <p role="alert" className="m-0 text-[13px] font-semibold leading-snug text-red">
              {failed instanceof Error && failed.message ? failed.message : "Не удалось получить тренды. Обложку всё равно можно нарисовать."}
            </p>
          )}
          <div>
            <button
              type="button"
              disabled={disabled || refresh.isPending}
              onClick={() => refresh.mutate()}
              className="inline-flex! min-h-[40px]! items-center! gap-2! rounded-lg! border! border-line! bg-card-solid! px-3.5! text-[14px]! font-semibold! text-gray-800! hover:bg-hover-tint! disabled:cursor-not-allowed! disabled:opacity-55!"
            >
              {refresh.isPending ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
              {refresh.isPending ? "Ищем в интернете…" : "Обновить тренды"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CoverPicker({ mode, coverUrl, busy, error, disabled = false, onUpload, onGenerateAi, onClear, coverMeta = null }: CoverPickerProps) {
  const uid = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<SocialVideoCoverMode>(mode);
  const [prompt, setPrompt] = useState("");
  const [providerChoice, setProviderChoice] = useState<SocialVideoCoverProvider | null>(null);
  const [useFrame, setUseFrame] = useState(true);
  const [useTrends, setUseTrends] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const elapsed = useElapsedSeconds(busy === "ai");
  const providersQuery = useSocialVideoAiProviders(view === "AI");
  const providers = providersQuery.data;
  const provider = effectiveProvider(providers, providerChoice);

  // Сервер сменил режим (загрузилась обложка, нарисовалась, убрали) — вкладка идёт следом.
  useEffect(() => {
    setView(mode);
  }, [mode]);

  // Мгновенный предпросмотр выбранного файла, пока он едет на сервер.
  const localUrl = useMemo(() => (localFile ? URL.createObjectURL(localFile) : null), [localFile]);
  useEffect(() => {
    return () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [localUrl]);
  useEffect(() => {
    if (busy !== "upload") setLocalFile(null);
  }, [busy]);

  const busyAny = busy !== null;
  const locked = disabled || busyAny;
  const shownUrl = busy === "upload" && localUrl ? localUrl : coverUrl;
  const shownError = localError ?? error;
  const mimeList = SOCIAL_VIDEO_COVER_MIME_TYPES as readonly string[];

  function pickFile(file: File | undefined) {
    if (!file) return;
    setLocalError(null);
    if (!mimeList.includes(file.type)) {
      setLocalError("Подходят только картинки JPEG, PNG или WebP.");
      return;
    }
    if (file.size > SOCIAL_VIDEO_COVER_MAX_BYTES) {
      setLocalError(`Картинка ${formatBytesRu(file.size)} слишком большая: предел — ${formatBytesRu(SOCIAL_VIDEO_COVER_MAX_BYTES)}.`);
      return;
    }
    setLocalFile(file);
    onUpload(file);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,168px)_1fr]">
      {/* Превью вертикали 9:16 — как обложка выглядит в Reels и Shorts. */}
      <div className="mx-auto w-full max-w-[168px]">
        <div className="relative aspect-[9/16] overflow-hidden rounded-xl border border-line bg-ink/5">
          {shownUrl ? (
            <img src={shownUrl} alt="Обложка ролика" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full place-items-center px-3 text-center text-gray-500">
              <span className="flex flex-col items-center gap-2 text-[13px]">
                <ImagePlus size={26} aria-hidden="true" />
                Обложки нет
              </span>
            </div>
          )}
          {busyAny && (
            <div className="absolute inset-0 grid place-items-center bg-black/45" aria-hidden="true">
              <Loader2 size={30} className="text-white motion-safe:animate-spin" />
            </div>
          )}
        </div>
        {mode === "AI" && coverMeta && shownUrl && <p className="m-0 mt-2 text-center text-[13px] leading-snug text-gray-600">{coverMetaText(coverMeta)}</p>}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div role="radiogroup" aria-label="Откуда взять обложку" className="grid gap-2 sm:grid-cols-3">
          {SOCIAL_VIDEO_COVER_MODES.map((m) => {
            const { Icon, hint } = MODE_META[m];
            const active = view === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={locked}
                onClick={() => {
                  setLocalError(null);
                  setView(m);
                }}
                className={`flex! min-h-[64px]! items-center! gap-2.5! rounded-xl! border! px-3! py-2.5! text-left! transition-colors! disabled:cursor-not-allowed! disabled:opacity-60! sm:flex-col! sm:items-start! ${
                  active ? "border-blue! bg-blue/10!" : "border-line! bg-card-solid! hover:bg-hover-tint!"
                }`}
              >
                <span className={`inline-grid h-8 w-8 shrink-0 place-items-center rounded-[10px] ${active ? "bg-blue text-on-accent" : "bg-ink/5 text-gray-600"}`}>
                  <Icon size={17} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[14px] font-semibold text-gray-800">
                    {SOCIAL_VIDEO_COVER_MODE_LABELS[m]}
                    {mode === m && <span className="rounded-full bg-green-bg px-1.5 text-[13px] font-semibold text-green">выбрано</span>}
                  </span>
                  <span className="block text-[13px] leading-snug text-gray-500">{hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        {view === "NONE" && (
          <p className="m-0 text-[14px] leading-relaxed text-gray-600">
            Ролик уйдёт без своей обложки: площадки возьмут кадр из самого видео.
            {mode !== "NONE" && " Сейчас обложка выбрана — её можно убрать кнопкой ниже."}
          </p>
        )}

        {view === "UPLOAD" && (
          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              id={`${uid}-file`}
              type="file"
              accept={SOCIAL_VIDEO_COVER_MIME_TYPES.join(",")}
              className="sr-only"
              tabIndex={-1}
              disabled={locked}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                pickFile(f);
              }}
            />
            <button
              type="button"
              disabled={locked}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!locked) pickFile(e.dataTransfer.files?.[0]);
              }}
              className="flex! min-h-[88px]! w-full! flex-col! items-center! justify-center! gap-1.5! rounded-xl! border-2! border-dashed! border-line! bg-card-solid! px-4! py-4! text-center! transition-colors! hover:border-blue! hover:bg-blue/5! disabled:cursor-not-allowed! disabled:opacity-60!"
            >
              {busy === "upload" ? <Loader2 size={20} className="text-blue motion-safe:animate-spin" aria-hidden="true" /> : <Upload size={20} className="text-blue" aria-hidden="true" />}
              <span className="text-[14px] font-semibold text-gray-800">{busy === "upload" ? "Загружаем обложку…" : coverUrl && mode === "UPLOAD" ? "Заменить картинку" : "Выбрать или перетащить картинку"}</span>
              <span className="text-[13px] text-gray-500">JPEG, PNG, WebP · до {formatBytesRu(SOCIAL_VIDEO_COVER_MAX_BYTES)} · лучше вертикальная 9:16</span>
            </button>
          </div>
        )}

        {view === "AI" && (
          <div className="flex flex-col gap-2.5">
            <label htmlFor={`${uid}-prompt`} className="text-[13px] font-semibold text-gray-600">
              Что нарисовать <span className="font-normal text-gray-500">(необязательно)</span>
            </label>
            <textarea
              id={`${uid}-prompt`}
              value={prompt}
              rows={3}
              maxLength={1000}
              disabled={locked}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Пусто — ИИ возьмёт описание и название ролика. Например: светлая гостиная с видом на горы."
              className="w-full resize-y rounded-[18px] border border-line bg-card-solid px-3 py-2.5 text-[15px] leading-relaxed text-gray-800 placeholder:text-gray-400 disabled:opacity-60"
            />
            <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1.5 p-0 text-[13px] font-semibold text-gray-600">Кто рисует</legend>
              <div role="radiogroup" aria-label="Кто рисует обложку" className="grid gap-2 sm:grid-cols-2">
                {SOCIAL_VIDEO_COVER_PROVIDERS.map((p) => {
                  const info = providers?.providers.find((x) => x.provider === p);
                  const unavailable = info ? !info.available : false;
                  const active = provider === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={locked || unavailable}
                      onClick={() => setProviderChoice(p)}
                      className={`flex! min-h-[56px]! flex-col! items-start! justify-center! gap-0.5! rounded-xl! border! px-3! py-2! text-left! transition-colors! disabled:cursor-not-allowed! ${
                        unavailable ? "border-line! bg-ink/5! opacity-60!" : active ? "border-blue! bg-blue/10!" : "border-line! bg-card-solid! hover:bg-hover-tint!"
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-[14px] font-semibold text-gray-800">
                        {SOCIAL_VIDEO_COVER_PROVIDER_LABELS[p]}
                        {providers?.defaultProvider === p && <span className="rounded-full bg-ink/5 px-1.5 text-[13px] font-semibold text-gray-600">по умолчанию</span>}
                      </span>
                      {unavailable && <span className="text-[13px] leading-snug text-gray-600">{info?.problem ?? "Недоступно"}</span>}
                    </button>
                  );
                })}
              </div>
              {providersQuery.isError && (
                <p className="m-0 text-[13px] text-gray-500">Не удалось проверить, какие ИИ подключены, — рисовать будет {SOCIAL_VIDEO_COVER_PROVIDER_LABELS[provider]}.</p>
              )}
            </fieldset>

            <div className="flex flex-col gap-2">
              <CheckRow checked={useFrame} disabled={locked} onChange={setUseFrame}>
                Взять кадр из ролика как основу
              </CheckRow>
              <CheckRow checked={useTrends} disabled={locked} onChange={setUseTrends}>
                Учесть свежие тренды
              </CheckRow>
            </div>
            {useTrends && <TrendsPanel disabled={locked} />}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={locked}
                onClick={() => onGenerateAi({ prompt: prompt.trim(), provider, useFrame, useTrends })}
                className="inline-flex! min-h-[44px]! items-center! gap-2! rounded-full! bg-blue! px-5! text-[15px]! font-semibold! text-on-accent! hover:bg-blue-hover! disabled:cursor-not-allowed! disabled:opacity-55!"
              >
                {busy === "ai" ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
                {busy === "ai" ? "Рисуем…" : mode === "AI" && coverUrl ? "Нарисовать заново" : "Нарисовать"}
              </button>
            </div>
            {busy === "ai" && (
              <div role="status" className="flex flex-col gap-1.5 rounded-lg bg-blue/10 px-3 py-2.5">
                <p className="m-0 text-[14px] font-semibold text-blue">
                  Рисуем обложку… обычно 20–90 секунд <span className="font-num font-normal">(прошло {elapsed} с)</span>
                </p>
                <div className="h-1.5 overflow-hidden rounded-full bg-blue/20">
                  <div className="h-full w-1/3 rounded-full bg-blue motion-safe:animate-pulse" />
                </div>
                <p className="m-0 text-[13px] text-gray-600">Не закрывайте экран: картинка появится слева.</p>
              </div>
            )}
          </div>
        )}

        {shownError && (
          <p role="alert" className="m-0 flex items-start gap-2 rounded-lg bg-red-bg px-3 py-2.5 text-[14px] font-semibold text-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {shownError}
          </p>
        )}

        {coverUrl && mode !== "NONE" && (
          <div>
            <button
              type="button"
              disabled={locked}
              onClick={onClear}
              className="inline-flex! min-h-[40px]! items-center! gap-2! rounded-lg! border! border-line! bg-card-solid! px-3.5! text-[14px]! font-semibold! text-red! hover:bg-red-bg! disabled:cursor-not-allowed! disabled:opacity-55!"
            >
              {busy === "clear" ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
              Убрать обложку
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
