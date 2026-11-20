import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AUDIO_SPEEDS, audioClock, audioSpeedLabel, nextAudioSpeed, usableDuration } from "./rhAudio";

/**
 * ОДИН ПЛЕЕР ДЛЯ ВСЕХ ЗАПИСЕЙ (20.11.2026, класс К01 аудита; кадр владельца №17 — серый
 * системный плеер iPhone с «00:27 … 00:00»). Заменяет `<audio controls>`: кнопка ▶/❚❚,
 * полоса перемотки, «0:12 / 0:27»; у голосовых — скорость 1× / 1,5× / 2× (`speeds`).
 *
 *  - Длительность берётся из файла, но Infinity/NaN (у webm из Chrome) не показываем:
 *    лечится известным приёмом — прыжок в конец, и браузер считает настоящую длину.
 *    Пока длины нет, показывается `knownSec` от сервера, а если и его нет — только текущее время.
 *  - Одновременно играет один плеер: запуск второго ставит первый на паузу.
 *  - Файл не открылся — честная строка и ссылка на сам файл, а не вечный «00:00».
 *
 * Сам `<audio>` скрытый и без `controls` — рисуем свои кнопки. Новый `<audio controls>`
 * вне этого файла не пройдёт сторож `ruFieldsGuard.test.ts`.
 */
let current: HTMLAudioElement | null = null;

export function RhAudioPlayer({
  src, autoPlay = false, speeds = false, preload = "metadata", knownSec, className, style, label = "Запись",
}: {
  src: string;
  autoPlay?: boolean;
  /** Кнопка скорости 1×/1,5×/2× — для голосовых и разговоров. */
  speeds?: boolean;
  preload?: "none" | "metadata" | "auto";
  /** Длина записи, если сервер её знает: показывается, пока браузер не дал свою. */
  knownSec?: number | null;
  className?: string;
  style?: CSSProperties;
  /** Подпись для экранного чтеца: «Голосовое», «Запись разговора». */
  label?: string;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number>(AUDIO_SPEEDS[0]);
  const [failed, setFailed] = useState(false);
  const probing = useRef(false);

  // Новый адрес — всё сначала.
  useEffect(() => {
    setPlaying(false); setPos(0); setDur(null); setFailed(false); probing.current = false;
  }, [src]);

  const syncDuration = useCallback((el: HTMLAudioElement) => {
    const d = usableDuration(el.duration);
    if (d) {
      setDur(d);
      if (probing.current) { probing.current = false; try { el.currentTime = 0; } catch { /* перемотка до загрузки */ } setPos(0); }
      return;
    }
    // Infinity: просим конец файла, браузер досчитает длину и пришлёт durationchange.
    if (el.duration === Infinity && !probing.current) {
      probing.current = true;
      try { el.currentTime = 1e101; } catch { probing.current = false; }
    }
  }, []);

  const play = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (current && current !== el) current.pause();
    current = el;
    el.playbackRate = speed;
    void el.play().catch(() => setPlaying(false));
  }, [speed]);

  useEffect(() => {
    const el = ref.current;
    if (autoPlay && el) play();
    return () => { if (current === el) current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- автозапуск один раз на адрес
  }, [src, autoPlay]);

  useEffect(() => { if (ref.current) ref.current.playbackRate = speed; }, [speed]);

  const total = dur ?? usableDuration(knownSec);
  const seekTo = (value: number) => {
    const el = ref.current;
    if (!el) return;
    try { el.currentTime = value; } catch { /* ещё не загружено */ }
    setPos(value);
  };

  if (failed) {
    return (
      <div className={className} style={style} data-testid="rh-audio-failed">
        <span className="text-sm">Запись не открылась. </span>
        <a className="text-sm underline" href={src} target="_blank" rel="noreferrer">Открыть файл</a>
      </div>
    );
  }

  return (
    <div
      className={`rh-audio flex min-w-0 items-center gap-1.5 rounded-2xl bg-[var(--soft,rgba(120,120,128,.12))] p-1 pr-2 ${className ?? ""}`}
      style={style}
      data-testid="rh-audio"
    >
      <audio
        ref={ref}
        src={src}
        preload={preload}
        onLoadedMetadata={(e) => syncDuration(e.currentTarget)}
        onDurationChange={(e) => syncDuration(e.currentTarget)}
        onTimeUpdate={(e) => { if (!probing.current) setPos(e.currentTarget.currentTime); else syncDuration(e.currentTarget); }}
        onPlay={(e) => { if (current && current !== e.currentTarget) current.pause(); current = e.currentTarget; setPlaying(true); }}
        onPause={() => setPlaying(false)}
        onEnded={(e) => { setPlaying(false); setPos(0); e.currentTarget.currentTime = 0; }}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        aria-label={playing ? `${label}: пауза` : `${label}: слушать`}
        aria-pressed={playing}
        onClick={() => (playing ? ref.current?.pause() : play())}
        /* «!» — правило `.rh2 button` (background:none; color:inherit; font:inherit) бьёт слои Tailwind */
        className="grid h-11 w-11 flex-none place-items-center rounded-full bg-blue! text-lg! text-on-accent!"
      >
        <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
      </button>
      <input
        type="range"
        className="block min-w-14 flex-1 accent-[rgb(var(--rgb-accent))]"
        min={0}
        max={total ?? 0}
        step={0.1}
        value={Math.min(pos, total ?? 0)}
        disabled={!total}
        aria-label={`${label}: перемотка`}
        aria-valuetext={`${audioClock(pos)} из ${audioClock(total)}`}
        onChange={(e) => seekTo(Number(e.target.value))}
      />
      <span className="flex-none whitespace-nowrap text-[13px] tabular-nums text-[var(--muted)]" data-testid="rh-audio-clock">
        {total ? `${audioClock(pos)} / ${audioClock(total)}` : audioClock(pos)}
      </span>
      {speeds && (
        <button
          type="button"
          aria-label={`Скорость ${audioSpeedLabel(speed)}, нажмите, чтобы сменить`}
          onClick={() => setSpeed(nextAudioSpeed(speed))}
          className="h-11 min-w-10 flex-none rounded-full px-1! text-[13px]! font-semibold! tabular-nums"
        >
          {audioSpeedLabel(speed)}
        </button>
      )}
    </div>
  );
}
