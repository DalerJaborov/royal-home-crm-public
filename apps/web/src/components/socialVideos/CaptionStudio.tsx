import { useId } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, Sparkles } from "lucide-react";
import {
  SOCIAL_VIDEO_CAPTION_LANGUAGES,
  SOCIAL_VIDEO_CAPTION_LANGUAGE_LABELS,
  SOCIAL_VIDEO_CAPTION_TONES,
  SOCIAL_VIDEO_CAPTION_TONE_LABELS,
  SOCIAL_VIDEO_CAPTION_VARIANTS,
  SOCIAL_VIDEO_CHANNEL_LABELS,
  SOCIAL_VIDEO_LIMITS,
} from "@royal-home/shared";
import type { SocialVideoCaptionLanguage, SocialVideoCaptionTone, SocialVideoChannel } from "@royal-home/shared";
import { ChannelIcon } from "../ChannelIcon";

/**
 * Текст ролика: название, «о чём ролик своими словами», ИИ-варианты подписи и
 * итоговая подпись с живыми счётчиками по выбранным сетям.
 *
 * Превышение лимита сети НЕ запрещает текст: подпись в этой сети просто
 * обрежется (так же считает `evaluateVideoForChannel`). Поэтому счётчик красный
 * и подписан словами «обрежется», но поле не блокируется.
 */
export interface CaptionStudioProps {
  title: string;
  onTitleChange(v: string): void;
  brief: string;
  onBriefChange(v: string): void;
  caption: string;
  onCaptionChange(v: string): void;
  tone: SocialVideoCaptionTone;
  onToneChange(v: SocialVideoCaptionTone): void;
  language: SocialVideoCaptionLanguage;
  onLanguageChange(v: SocialVideoCaptionLanguage): void;
  /** Выбранные каналы — для счётчиков. */
  channels: SocialVideoChannel[];
  /** Показанные варианты ИИ (держит родитель). */
  variants: string[];
  generating: boolean;
  generateError: string | null;
  /** «Написать подписи». */
  onGenerate(): void;
  /** «Перегенерировать». */
  onRegenerate(): void;
  onPickVariant(text: string): void;
}

const FIELD =
  "w-full border border-line bg-card-solid px-3 text-[15px] text-gray-800 placeholder:text-gray-400 disabled:opacity-60";

/** Сегментный переключатель: одна кнопка выбрана, остальные доступны одним касанием. */
function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange(v: T): void;
}) {
  const labelId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-gray-600" id={labelId}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = o === value;
          return (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o)}
              className={`min-h-[40px]! rounded-full! border! px-3.5! text-[14px]! font-semibold! transition-colors! ${
                active ? "border-blue! bg-blue/10! text-blue!" : "border-line! bg-card-solid! text-gray-700! hover:bg-hover-tint!"
              }`}
            >
              {labels[o]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CaptionStudio(props: CaptionStudioProps) {
  const {
    title,
    onTitleChange,
    brief,
    onBriefChange,
    caption,
    onCaptionChange,
    tone,
    onToneChange,
    language,
    onLanguageChange,
    channels,
    variants,
    generating,
    generateError,
    onGenerate,
    onRegenerate,
    onPickVariant,
  } = props;
  const uid = useId();
  const briefReady = brief.trim().length >= 3;
  const hasVariants = variants.length > 0;

  // Счётчики только для сетей, у которых есть жёсткий предел подписи.
  const counters = channels
    .map((c) => ({ channel: c, max: SOCIAL_VIDEO_LIMITS[c].maxCaptionChars }))
    .filter((x): x is { channel: SocialVideoChannel; max: number } => x.max !== null);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-title`} className="text-[13px] font-semibold text-gray-600">
          Название ролика <span className="font-normal text-gray-500">(внутреннее, в сетях не показывается)</span>
        </label>
        <input
          id={`${uid}-title`}
          type="text"
          value={title}
          maxLength={120}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Например: Акция на квартиры в Сомони"
          className={`${FIELD} min-h-[44px] rounded-control`}
        />
      </div>

      <section aria-labelledby={`${uid}-ai`} className="flex flex-col gap-4 rounded-card border border-line bg-card-solid p-3.5">
        <div className="flex items-center gap-2">
          <span className="inline-grid h-8 w-8 place-items-center rounded-[10px] bg-blue/10 text-blue">
            <Sparkles size={17} aria-hidden="true" />
          </span>
          <h3 id={`${uid}-ai`} className="m-0 text-[15px] font-semibold text-gray-800">
            Подписи от ИИ
          </h3>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-brief`} className="text-[13px] font-semibold text-gray-600">
            О чём ролик (своими словами)
          </label>
          <textarea
            id={`${uid}-brief`}
            value={brief}
            rows={3}
            maxLength={2000}
            onChange={(e) => onBriefChange(e.target.value)}
            placeholder="Коротко: что в ролике, для кого, в чём выгода. ИИ сам напишет красивый текст."
            className={`${FIELD} resize-y rounded-[18px] py-2.5 leading-relaxed`}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Segmented label="Тон" options={SOCIAL_VIDEO_CAPTION_TONES} labels={SOCIAL_VIDEO_CAPTION_TONE_LABELS} value={tone} onChange={onToneChange} />
          <Segmented
            label="Язык"
            options={SOCIAL_VIDEO_CAPTION_LANGUAGES}
            labels={SOCIAL_VIDEO_CAPTION_LANGUAGE_LABELS}
            value={language}
            onChange={onLanguageChange}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!hasVariants && (
            <button
              type="button"
              onClick={onGenerate}
              disabled={generating || !briefReady}
              className="inline-flex! min-h-[44px]! items-center! gap-2! rounded-full! bg-blue! px-5! text-[15px]! font-semibold! text-on-accent! hover:bg-blue-hover! disabled:cursor-not-allowed! disabled:opacity-55!"
            >
              {generating ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
              {generating ? "Пишем…" : "Написать подписи"}
            </button>
          )}
          {hasVariants && (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={generating || !briefReady}
              className="inline-flex! min-h-[44px]! items-center! gap-2! rounded-full! border! border-line! bg-card-solid! px-5! text-[15px]! font-semibold! text-gray-800! hover:bg-hover-tint! disabled:cursor-not-allowed! disabled:opacity-55!"
            >
              {generating ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
              {generating ? "Пишем новые…" : "Перегенерировать"}
            </button>
          )}
          {!briefReady && !generating && <span className="text-[13px] text-gray-500">Опишите ролик хотя бы парой слов — тогда ИИ сможет писать.</span>}
          {generating && <span className="text-[13px] text-gray-500">Обычно 5–20 секунд.</span>}
        </div>

        <div aria-live="polite">
          {generateError && (
            <p role="alert" className="m-0 flex items-start gap-2 rounded-lg bg-red-bg px-3 py-2.5 text-[14px] font-semibold text-red">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              {generateError}
            </p>
          )}
        </div>

        {generating && !hasVariants && (
          <div className="grid gap-2.5 sm:grid-cols-3" aria-hidden="true">
            {Array.from({ length: SOCIAL_VIDEO_CAPTION_VARIANTS }, (_, i) => (
              <div key={i} className="flex h-[120px] flex-col gap-2 rounded-xl border border-line bg-ink/5 p-3 motion-safe:animate-pulse">
                <span className="h-3 w-3/4 rounded bg-ink/10" />
                <span className="h-3 w-full rounded bg-ink/10" />
                <span className="h-3 w-2/3 rounded bg-ink/10" />
              </div>
            ))}
          </div>
        )}

        {hasVariants && (
          <div className={`flex flex-col gap-2 ${generating ? "opacity-60" : ""}`}>
            <p className="m-0 text-[13px] font-semibold text-gray-600">Варианты — нажмите, чтобы подставить в подпись</p>
            <div className="grid gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="Варианты подписи от ИИ">
              {variants.map((v, i) => {
                const picked = v === caption;
                return (
                  <button
                    key={`${i}-${v.slice(0, 24)}`}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    onClick={() => onPickVariant(v)}
                    className={`flex! min-h-[120px]! flex-col! gap-2! rounded-xl! border! p-3! text-left! transition-colors! ${
                      picked ? "border-blue! bg-blue/10!" : "border-line! bg-card-solid! hover:bg-hover-tint!"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2 text-[13px] font-semibold text-gray-600">
                      <span>Вариант {i + 1}</span>
                      {picked && (
                        <span className="inline-flex items-center gap-1 text-blue">
                          <Check size={14} strokeWidth={2.6} aria-hidden="true" />
                          Выбрано
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-6 whitespace-pre-wrap break-words text-[14px] leading-snug text-gray-800">{v}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${uid}-caption`} className="text-[13px] font-semibold text-gray-600">
          Подпись к ролику
        </label>
        <textarea
          id={`${uid}-caption`}
          value={caption}
          rows={7}
          maxLength={8000}
          onChange={(e) => onCaptionChange(e.target.value)}
          placeholder="Текст, который уйдёт в сети вместе с роликом. Можно написать самому или взять вариант выше."
          aria-describedby={`${uid}-caption-hint`}
          className={`${FIELD} resize-y rounded-[18px] py-2.5 leading-relaxed`}
        />
        <p id={`${uid}-caption-hint`} className="m-0 text-[13px] leading-snug text-gray-500">
          Первая строка станет заголовком на YouTube (до 100 символов).
        </p>
        {counters.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Длина подписи по сетям">
            {counters.map(({ channel, max }) => {
              const over = caption.length > max;
              return (
                <li
                  key={channel}
                  className={`inline-flex min-h-[30px] flex-wrap items-center gap-1.5 rounded-[14px] px-2.5 py-1 text-[13px] font-semibold ${
                    over ? "bg-red-bg text-red" : "bg-ink/5 text-gray-700"
                  }`}
                >
                  <ChannelIcon channel={channel} size={14} tone="ink" title={SOCIAL_VIDEO_CHANNEL_LABELS[channel]} />
                  <span>{SOCIAL_VIDEO_CHANNEL_LABELS[channel]}</span>
                  <span className="font-num">
                    {caption.length}/{max}
                  </span>
                  {over && (
                    <>
                      <AlertTriangle size={14} aria-hidden="true" />
                      <span>обрежется</span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
