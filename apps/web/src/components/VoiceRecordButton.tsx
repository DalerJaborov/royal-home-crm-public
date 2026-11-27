import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronUp, Lock, Mic, Pause, Play, Send, Trash2 } from "lucide-react";
import { useVoiceRecorderSession } from "../hooks/useVoiceRecorderSession";
import { formatElapsed } from "../lib/audioRecording";
import { cancelHintOpacity, downsampleLevels, isVoiceBusy, LOCK_DISTANCE_PX } from "../lib/voiceRecorderMachine";
import "./voiceRecorder.css";

/**
 * Кнопка записи голосового в строке ответа клиенту — Messages.tsx (инбокс), ClientChatPanel.tsx и
 * MobileChatView.tsx. Запись «как в WhatsApp» (27.11.2026): удержание, влево — отмена, вверх — замок,
 * в замке «Удалить / Пауза / Отправить», на паузе — прослушивание. Компьютер: клик — запись в замке.
 *
 * Пока запись идёт, поверх строки ввода рисуется панель (портал в ближайший `<form>`), а сама кнопка
 * остаётся под пальцем: жест не должен прерываться. Куда уходит файл, решает переданный `send`.
 */
const WAVE_BARS = 36;

export function VoiceRecordButton({
  send,
  onError,
  disabled,
  onBusyChange,
}: {
  send: (blob: Blob) => Promise<unknown>;
  /** Показ ошибки отдаёт вызывающему — у форм уже есть своё место под неё. */
  onError: (message: string | null) => void;
  disabled?: boolean;
  /** Идёт запись, прослушивание или отправка (пока true, строка ввода не подменяет эту кнопку на «Отправить»). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const session = useVoiceRecorderSession(send, disabled);
  const { state, elapsedMs, levels, error } = session;
  const busy = isVoiceBusy(state);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    onBusyChange?.(busy);
    // onBusyChange — setState родителя, стабильная ссылка не гарантирована.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  useEffect(() => {
    onError(error);
    // onError сознательно не в зависимостях: формы передают инлайн-функцию (setState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  useLayoutEffect(() => {
    if (!busy) return;
    const form = buttonRef.current?.closest("form") ?? null;
    form?.classList.add("vr-host");
    setHost(form);
    return () => {
      form?.classList.remove("vr-host");
      setHost(null);
    };
  }, [busy]);

  if (!session.supported) return null;

  const { phase } = state;
  const holding = phase === "holding" || phase === "requesting";
  const sending = phase === "sending";
  const lockReady = holding && -state.dy > LOCK_DISTANCE_PX * 0.5;

  const mic = (
    <button
      ref={buttonRef}
      type="button"
      {...session.handlers}
      onContextMenu={(e) => e.preventDefault()}
      disabled={disabled || (busy && !holding)}
      title="Записать голосовое"
      aria-label="Записать голосовое. Удерживайте и говорите, сдвиньте влево для отмены, вверх для замка"
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-line-soft hover:text-gray-600 disabled:opacity-40 vr-mic${holding ? " vr-mic-hot" : ""}`}
      style={busy && !holding ? { visibility: "hidden" } : undefined}
    >
      <Mic className="h-[18px] w-[18px]" strokeWidth={1.8} />
    </button>
  );

  if (!busy || !host) return mic;

  return (
    <>
      {mic}
      {createPortal(
        holding ? (
          <>
            <div className="vr-panel vr-panel-hold" role="status" aria-live="polite">
              <span className="vr-dot" aria-hidden="true" />
              <span className="vr-time">{formatElapsed(elapsedMs)}</span>
              <span className="vr-cancel-hint" style={{ transform: `translateX(${Math.max(state.dx, -90) * 0.6}px)`, opacity: cancelHintOpacity(state.dx) }}>
                <ChevronLeft aria-hidden="true" />
                Влево — отмена
              </span>
            </div>
            <div className={`vr-lock-capsule${lockReady ? " vr-lock-ready" : ""}`} aria-hidden="true">
              <Lock />
              <ChevronUp />
            </div>
          </>
        ) : (
          <LockedPanel
            elapsedMs={elapsedMs}
            levels={levels}
            paused={phase === "paused"}
            finished={state.finished}
            sending={sending}
            onDelete={session.cancel}
            onPause={session.pause}
            onResume={session.resume}
            onSend={session.send}
            previewBlob={session.previewBlob}
          />
        ),
        host,
      )}
    </>
  );
}

function LockedPanel({
  elapsedMs,
  levels,
  paused,
  finished,
  sending,
  onDelete,
  onPause,
  onResume,
  onSend,
  previewBlob,
}: {
  elapsedMs: number;
  levels: number[];
  paused: boolean;
  finished: boolean;
  sending: boolean;
  onDelete: () => void;
  onPause: () => void;
  onResume: () => void;
  onSend: () => void;
  previewBlob: () => Blob | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [playError, setPlayError] = useState(false);

  // Запись продолжили — прежний файл прослушивания устарел.
  useEffect(() => {
    if (!paused) stopPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);
  useEffect(() => () => stopPlayback(), []);

  function stopPlayback() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPlaying(false);
    setPosition(0);
  }

  function togglePlay() {
    if (playing) {
      audioRef.current?.pause();
      return;
    }
    if (!audioRef.current) {
      const blob = previewBlob();
      if (!blob) return;
      urlRef.current = URL.createObjectURL(blob);
      const audio = new Audio(urlRef.current);
      audio.onplay = () => setPlaying(true);
      audio.onpause = () => setPlaying(false);
      audio.onended = () => {
        setPlaying(false);
        setPosition(0);
      };
      audio.ontimeupdate = () => setPosition(audio.currentTime * 1000);
      audioRef.current = audio;
    }
    setPlayError(false);
    audioRef.current.play().catch(() => setPlayError(true));
  }

  const bars = downsampleLevels(levels, WAVE_BARS);
  const progress = elapsedMs > 0 ? Math.min(1, position / elapsedMs) : 0;

  return (
    <div className="vr-panel vr-panel-locked" role="group" aria-label="Запись голосового">
      <div className="vr-row">
        {paused ? (
          <button type="button" className="vr-play" onClick={togglePlay} aria-label={playing ? "Остановить" : "Прослушать"}>
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
        ) : (
          <span className="vr-dot" aria-hidden="true" />
        )}
        <span className="vr-wave" aria-hidden="true">
          {bars.map((b, i) => (
            <i key={i} className={paused && i / WAVE_BARS <= progress && playing ? "vr-bar-played" : ""} style={{ height: `${Math.max(12, Math.round(b * 100))}%` }} />
          ))}
        </span>
        <span className="vr-time" role="timer">
          {formatElapsed(paused && playing ? position : elapsedMs)}
        </span>
      </div>
      {playError && <p className="vr-note">Это превью не воспроизводится в браузере. Запись при этом цела, её можно отправить.</p>}
      <div className="vr-actions">
        <button type="button" className="vr-act vr-act-del" onClick={onDelete} disabled={sending}>
          <span className="vr-act-ico"><Trash2 aria-hidden="true" /></span>
          <span className="vr-act-cap">Удалить</span>
        </button>
        {!finished && (
          <button type="button" className="vr-act vr-act-pause" onClick={paused ? onResume : onPause} disabled={sending}>
            <span className="vr-act-ico">{paused ? <Mic aria-hidden="true" /> : <Pause aria-hidden="true" />}</span>
            <span className="vr-act-cap">{paused ? "Продолжить" : "Пауза"}</span>
          </button>
        )}
        <button type="button" className="vr-act vr-act-send" onClick={onSend} disabled={sending}>
          <span className="vr-act-ico"><Send aria-hidden="true" /></span>
          <span className="vr-act-cap">{sending ? "Отправляем…" : "Отправить"}</span>
        </button>
      </div>
    </div>
  );
}
