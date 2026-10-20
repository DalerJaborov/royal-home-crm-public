import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { AlertCircle, Clock, Film, HardDrive, Loader2, Maximize2, RefreshCw, Trash2, UploadCloud, VolumeX } from "lucide-react";
import {
  SOCIAL_VIDEO_ALLOWED_EXTENSIONS,
  SOCIAL_VIDEO_UPLOAD_MAX_BYTES,
  formatBytesRu,
  formatDurationRu,
} from "@royal-home/shared";
import type { SocialVideoFacts } from "@royal-home/shared";

/**
 * Загрузка ролика: перетащить файл или выбрать, сразу показать превью и параметры.
 *
 * ПАРАМЕТРЫ ЧИТАЕТ БРАУЗЕР, ДО ЗАГРУЗКИ. Через скрытый <video preload="metadata">
 * берём длительность и размеры кадра — этого хватает, чтобы родитель мгновенно
 * проверил ролик на пригодность каждому каналу и не заставлял ждать загрузку
 * 300 МБ ради отказа. Кодек и наличие звука браузер не отдаёт — для них null
 * (это «не проверили», а не «плохо»; точные значения сервер узнает ffprobe).
 *
 * Компонент управляемый: файл, факты и прогресс живут у родителя.
 */
export interface VideoDropzoneProps {
  /** Выбранный, ещё не загруженный файл. */
  file: File | null;
  /** Уже загруженный черновик. */
  existing: { videoPath: string; originalName: string; sizeBytes: number } | null;
  /** Известные факты (из браузера или с сервера). */
  facts: SocialVideoFacts | null;
  /** 0..100, пока идёт загрузка. */
  uploadProgress: number | null;
  /** Все байты ушли, сервер обрабатывает файл (до нескольких минут) — вместо процентов честная подпись. */
  processing?: boolean;
  disabled?: boolean;
  /** Факты уже прочитаны браузером; null — не удалось. */
  onPick(file: File, facts: SocialVideoFacts | null): void;
  onClear(): void;
}

/** Сколько ждём метаданные: HEVC в .mov многие браузеры не декодируют и событий не шлют. */
const METADATA_TIMEOUT_MS = 8000;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** Читает длительность и размеры кадра через временный <video>. Всегда освобождает object URL. */
function readVideoFacts(file: File): Promise<SocialVideoFacts | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (facts: SocialVideoFacts | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(facts);
    };
    const timer = window.setTimeout(() => finish(null), METADATA_TIMEOUT_MS);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      finish({
        durationSec: duration,
        sizeBytes: file.size,
        width: video.videoWidth > 0 ? video.videoWidth : null,
        height: video.videoHeight > 0 ? video.videoHeight : null,
        // Браузер этого не сообщает; точные значения определит сервер.
        videoCodec: null,
        hasAudio: null,
      });
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function orientationLabel(width: number, height: number): string {
  if (width === height) return "квадратное";
  return height > width ? "вертикальное" : "горизонтальное";
}

function FactChip({ icon, children, tone = "neutral" }: { icon: ReactNode; children: ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <span
      className={`inline-flex min-h-[30px] items-center gap-1.5 rounded-[14px] px-2.5 py-1 text-[13px] font-semibold ${
        tone === "warn" ? "bg-amber-bg text-amber" : "bg-ink/5 text-gray-700"
      }`}
    >
      {icon}
      {children}
    </span>
  );
}

export function VideoDropzone({ file, existing, facts, uploadProgress, processing = false, disabled = false, onPick, onClear }: VideoDropzoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Номер последнего чтения: устаревший ответ (выбрали другой файл или ушли с экрана) отбрасывается.
  const readToken = useRef(0);

  // Превью выбранного файла: свой object URL, обязательно освобождаем.
  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);
  useEffect(() => {
    const token = readToken;
    return () => {
      token.current += 1;
    };
  }, []);

  const accept = SOCIAL_VIDEO_ALLOWED_EXTENSIONS.join(",");
  const allowedText = SOCIAL_VIDEO_ALLOWED_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(", ");

  const handleFile = useCallback(
    async (picked: File) => {
      setLocalError(null);
      const ext = extensionOf(picked.name);
      if (!(SOCIAL_VIDEO_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
        setLocalError(`Файл «${picked.name}» не подходит: принимаем только ${allowedText}.`);
        return;
      }
      if (picked.size > SOCIAL_VIDEO_UPLOAD_MAX_BYTES) {
        setLocalError(`Файл ${formatBytesRu(picked.size)} слишком большой: предел — ${formatBytesRu(SOCIAL_VIDEO_UPLOAD_MAX_BYTES)}.`);
        return;
      }
      const token = ++readToken.current;
      setReading(true);
      const read = await readVideoFacts(picked);
      if (token !== readToken.current) return;
      setReading(false);
      onPick(picked, read);
    },
    [allowedText, onPick]
  );

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) void handleFile(dropped);
  }

  function openPicker() {
    if (!disabled) inputRef.current?.click();
  }

  const hidden = (
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      accept={accept}
      className="sr-only"
      tabIndex={-1}
      disabled={disabled}
      onChange={(e) => {
        const picked = e.target.files?.[0];
        // Сброс значения позволяет выбрать тот же файл повторно после «Убрать».
        e.target.value = "";
        if (picked) void handleFile(picked);
      }}
    />
  );

  const hasVideo = file !== null || existing !== null;
  const uploading = uploadProgress !== null;

  const errorBox = localError && (
    <p role="alert" className="m-0 flex items-start gap-2 rounded-lg bg-red-bg px-3 py-2.5 text-[14px] font-semibold text-red">
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      {localError}
    </p>
  );

  if (!hasVideo) {
    return (
      <div className="flex flex-col gap-3">
        {hidden}
        <button
          type="button"
          disabled={disabled || reading}
          onClick={openPicker}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex! min-h-[200px]! w-full! flex-col! items-center! justify-center! gap-3! rounded-card! border-2! border-dashed! px-5! py-8! text-center! transition-colors! disabled:cursor-not-allowed! disabled:opacity-60! ${
            dragging ? "border-blue! bg-blue/10!" : "border-line! bg-card-solid! hover:border-blue! hover:bg-blue/5!"
          }`}
        >
          <span className="inline-grid h-14 w-14 place-items-center rounded-2xl bg-blue/10 text-blue">
            {reading ? (
              <Loader2 size={26} className="motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud size={26} aria-hidden="true" />
            )}
          </span>
          <span className="flex flex-col gap-1">
            <span className="text-[16px] font-semibold text-gray-800">
              {reading ? "Читаем параметры ролика…" : dragging ? "Отпустите, чтобы добавить" : "Перетащите ролик сюда или выберите файл"}
            </span>
            <span className="text-[14px] text-gray-500">
              {allowedText} · до {formatBytesRu(SOCIAL_VIDEO_UPLOAD_MAX_BYTES)} · лучше вертикальный 9:16
            </span>
          </span>
          {!reading && (
            <span className="inline-flex min-h-[40px] items-center gap-2 rounded-full bg-blue px-4 text-[14px] font-semibold text-on-accent">
              <Film size={16} aria-hidden="true" />
              Выбрать файл
            </span>
          )}
        </button>
        {errorBox}
      </div>
    );
  }

  const name = file?.name ?? existing?.originalName ?? "Ролик";
  const size = file?.size ?? existing?.sizeBytes ?? facts?.sizeBytes ?? 0;
  const src = fileUrl ?? existing?.videoPath ?? undefined;
  const vertical = facts?.width != null && facts.height != null ? facts.height >= facts.width : true;

  return (
    <div className="flex flex-col gap-3" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {hidden}
      <div className="grid gap-4 rounded-card border border-line bg-card-solid p-3.5 sm:grid-cols-[minmax(0,200px)_1fr]">
        {/* Плеер: вертикальный ролик ограничен по высоте, чтобы не растягивал шаг. */}
        <div className={`overflow-hidden rounded-xl bg-black ${vertical ? "mx-auto w-full max-w-[200px]" : "w-full"}`}>
          {src ? (
            <video
              key={src}
              src={src}
              controls
              preload="metadata"
              playsInline
              aria-label={`Просмотр ролика ${name}`}
              className="block max-h-[360px] w-full bg-black object-contain"
            />
          ) : (
            <div className="grid aspect-[9/16] place-items-center text-white/70">
              <Film size={28} aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2.5">
            <p className="m-0 break-words text-[15px] font-semibold leading-snug text-gray-800" title={name}>
              {name}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <FactChip icon={<HardDrive size={14} aria-hidden="true" />}>{formatBytesRu(size)}</FactChip>
              {facts?.durationSec != null && <FactChip icon={<Clock size={14} aria-hidden="true" />}>{formatDurationRu(facts.durationSec)}</FactChip>}
              {facts?.width != null && facts.height != null && (
                <FactChip icon={<Maximize2 size={14} aria-hidden="true" />}>
                  {facts.width}×{facts.height} · {orientationLabel(facts.width, facts.height)}
                </FactChip>
              )}
              {facts?.videoCodec && <FactChip icon={<Film size={14} aria-hidden="true" />}>{facts.videoCodec.toUpperCase()}</FactChip>}
              {facts?.hasAudio === false && (
                <FactChip tone="warn" icon={<VolumeX size={14} aria-hidden="true" />}>
                  без звука
                </FactChip>
              )}
            </div>
            {reading && (
              <p className="m-0 flex items-center gap-2 text-[14px] text-gray-500">
                <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />
                Читаем параметры ролика…
              </p>
            )}
            {!reading && file !== null && facts === null && (
              <p className="m-0 flex items-start gap-2 rounded-lg bg-amber-bg px-3 py-2 text-[14px] text-amber">
                <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                Браузер не смог прочитать параметры ролика. Загрузить его можно, а длину и размеры кадра проверит сервер.
              </p>
            )}
          </div>

          {uploading && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[13px] font-semibold text-gray-600">
                <span role="status">{processing ? "Обрабатываем ролик на сервере… это может занять несколько минут" : "Загружаем на сервер…"}</span>
                <span className="font-num">{processing ? "" : `${Math.round(uploadProgress)}%`}</span>
              </div>
              <div
                role="progressbar"
                aria-label="Загрузка ролика"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(uploadProgress)}
                className="h-2 overflow-hidden rounded-full bg-ink/10"
              >
                <div
                  className={`h-full rounded-full bg-blue transition-[width] duration-300 ease-out ${processing ? "motion-safe:animate-pulse" : ""}`}
                  style={{ width: `${processing ? 100 : Math.min(100, Math.max(0, uploadProgress))}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled || uploading || reading}
              onClick={openPicker}
              className="inline-flex! min-h-[40px]! items-center! gap-2! rounded-lg! border! border-line! bg-card-solid! px-3.5! text-[14px]! font-semibold! text-gray-800! hover:bg-hover-tint! disabled:cursor-not-allowed! disabled:opacity-55!"
            >
              <RefreshCw size={15} aria-hidden="true" />
              Заменить файл
            </button>
            <button
              type="button"
              disabled={disabled || uploading}
              onClick={() => {
                setLocalError(null);
                onClear();
              }}
              className="inline-flex! min-h-[40px]! items-center! gap-2! rounded-lg! border! border-line! bg-card-solid! px-3.5! text-[14px]! font-semibold! text-red! hover:bg-red-bg! disabled:cursor-not-allowed! disabled:opacity-55!"
            >
              <Trash2 size={15} aria-hidden="true" />
              Убрать
            </button>
          </div>
        </div>
      </div>
      {errorBox}
    </div>
  );
}
