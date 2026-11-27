import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ApiError } from "../lib/api";
import {
  buildRecordingBlob,
  createRecorder,
  INSECURE_CONTEXT_MESSAGE,
  isRecordingSupported,
  micErrorMessage,
} from "../lib/audioRecording";
import {
  gestureFromMove,
  HOLD_MIN_MS,
  recordedMs,
  VOICE_INITIAL,
  voiceReducer,
  type VoiceState,
} from "../lib/voiceRecorderMachine";

/**
 * Запись голосового клиенту «как в WhatsApp» (27.11.2026): удержание микрофона, сдвиг влево —
 * отмена, вверх — замок; в замке пауза с прослушиванием и «Отправить». На компьютере клик по
 * микрофону сразу запускает запись в замке. Формат выбирает lib/audioRecording.ts (iPhone —
 * audio/mp4, Chrome — webm/opus); перекодирует и проверяет файл сервер, как и раньше.
 *
 * Правила жеста и переходы — чистые функции в lib/voiceRecorderMachine.ts (покрыты тестом).
 * Здесь только то, что нельзя проверить без браузера: микрофон, MediaRecorder, указатель.
 *
 * `send` — отправка готового файла (reply-voice в инбоксе, message-voice в карточке клиента).
 */

const MAX_RECORDING_MS = 120_000;
const LEVEL_INTERVAL_MS = 100;
export const HOLD_HINT_MESSAGE = "Удерживайте микрофон, пока говорите. Отпустите, чтобы отправить";

function haptic(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* вибрации нет (iOS Safari) — не страшно */
  }
}

export function useVoiceRecorderSession(send: (blob: Blob) => Promise<unknown>, disabled?: boolean) {
  const [state, dispatch] = useReducer(voiceReducer, VOICE_INITIAL);
  const stateRef = useRef<VoiceState>(state);
  stateRef.current = state;
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(isRecordingSupported);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const finishedBlobRef = useRef<Blob | null>(null);
  const levelsRef = useRef<number[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const baseMsRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const pointerTypeRef = useRef("");
  /** Поколение: отмена/уход с экрана во время ожидания разрешения глушит запоздавший старт. */
  const genRef = useRef(0);
  const sendIntentRef = useRef(false);

  const stopTick = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const releaseMic = useCallback(() => {
    stopTick();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    analyserRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  }, [stopTick]);

  const reset = useCallback(() => {
    releaseMic();
    chunksRef.current = [];
    finishedBlobRef.current = null;
    levelsRef.current = [];
    baseMsRef.current = 0;
    segmentStartRef.current = null;
    sendIntentRef.current = false;
    setElapsedMs(0);
    setLevels([]);
  }, [releaseMic]);

  /** Выбросить запись без отправки. */
  const cancel = useCallback(() => {
    genRef.current++;
    const rec = recorderRef.current;
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* уже остановлен */
        }
      }
    }
    reset();
    dispatch({ type: "cancel" });
  }, [reset]);

  const deliver = useCallback(
    async (blob: Blob) => {
      finishedBlobRef.current = blob;
      try {
        await send(blob);
        reset();
        dispatch({ type: "sent" });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Не удалось отправить голосовое");
        dispatch({ type: "failed" });
      }
    },
    [send, reset],
  );

  const startTick = useCallback(() => {
    stopTick();
    tickRef.current = setInterval(() => {
      const now = Date.now();
      const total = recordedMs(baseMsRef.current, segmentStartRef.current, now);
      setElapsedMs(total);
      const analyser = analyserRef.current;
      if (analyser && segmentStartRef.current !== null) {
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        levelsRef.current.push(Math.min(1, peak / 90));
        setLevels(levelsRef.current.slice());
      }
      const rec = recorderRef.current;
      if (total >= MAX_RECORDING_MS && rec && rec.state !== "inactive") finishRef.current();
    }, LEVEL_INTERVAL_MS);
  }, [stopTick]);

  /** Остановить запись и отправить (удержание отпущено, «Отправить» в замке). */
  const finish = useCallback(() => {
    const rec = recorderRef.current;
    // Запись уже остановлена, отправка не удалась: шлём сохранённый файл ещё раз.
    if (!rec) {
      const saved = finishedBlobRef.current;
      if (saved) {
        setError(null);
        dispatch({ type: "send" });
        void deliver(saved);
      }
      return;
    }
    sendIntentRef.current = true;
    dispatch({ type: "send" });
    segmentStartRef.current = null;
    stopTick();
    if (rec.state !== "inactive") rec.stop();
  }, [deliver, stopTick]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const start = useCallback(
    async (locked: boolean) => {
      if (disabled || !supported || stateRef.current.phase !== "idle") return;
      const gen = ++genRef.current;
      setError(null);
      dispatch({ type: "press" });
      if (!window.isSecureContext) {
        dispatch({ type: "denied" });
        setError(INSECURE_CONTEXT_MESSAGE);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (gen !== genRef.current) {
          // Пока ждали разрешения, палец отпустили или экран закрыли.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const recorder = createRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = buildRecordingBlob(recorder, chunksRef.current);
          const shouldSend = sendIntentRef.current;
          releaseMic();
          if (!shouldSend) return;
          if (blob.size === 0) {
            // Пустая запись: отправлять нечего, выходим из «отправки» молча.
            reset();
            dispatch({ type: "cancel" });
            return;
          }
          void deliver(blob);
        };
        try {
          const AC: typeof AudioContext | undefined =
            window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (AC) {
            const ctx = new AC();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            ctx.createMediaStreamSource(stream).connect(analyser);
            audioCtxRef.current = ctx;
            analyserRef.current = analyser;
          }
        } catch {
          /* волна — украшение: без неё запись работает */
        }
        recorderRef.current = recorder;
        baseMsRef.current = 0;
        levelsRef.current = [];
        sendIntentRef.current = false;
        recorder.start();
        segmentStartRef.current = Date.now();
        setElapsedMs(0);
        dispatch({ type: "granted", locked });
        haptic(12);
        startTick();
      } catch (err) {
        if (gen !== genRef.current) return;
        releaseMic();
        dispatch({ type: "denied" });
        setError(micErrorMessage(err));
      }
    },
    [disabled, supported, releaseMic, reset, deliver, startTick],
  );

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    baseMsRef.current = recordedMs(baseMsRef.current, segmentStartRef.current, Date.now());
    segmentStartRef.current = null;
    setElapsedMs(baseMsRef.current);
    try {
      rec.pause();
      rec.requestData(); // свежие куски нужны для прослушивания
    } catch {
      /* старый браузер без pause: запись просто продолжится */
    }
    dispatch({ type: "pause" });
    haptic(8);
  }, []);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    try {
      rec.resume();
    } catch {
      return;
    }
    segmentStartRef.current = Date.now();
    dispatch({ type: "resume" });
    haptic(8);
  }, []);

  /** Файл для прослушивания: записанное к этому моменту (на паузе) или готовый (после сбоя отправки). */
  const previewBlob = useCallback((): Blob | null => {
    if (finishedBlobRef.current) return finishedBlobRef.current;
    const rec = recorderRef.current;
    if (!rec || chunksRef.current.length === 0) return null;
    return buildRecordingBlob(rec, chunksRef.current);
  }, []);

  // ── жесты ──
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    pointerTypeRef.current = e.pointerType;
    if (e.pointerType === "mouse" || e.button > 0 || disabled) return; // мышь — по клику, см. onClick
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* без захвата жест работает, пока палец над кнопкой */
    }
    originRef.current = { x: e.clientX, y: e.clientY };
    void start(false);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (stateRef.current.phase !== "holding" || e.pointerType === "mouse") return;
    const dx = e.clientX - originRef.current.x;
    const dy = e.clientY - originRef.current.y;
    const gesture = gestureFromMove(dx, dy);
    if (gesture === "cancel") {
      haptic(20);
      cancel();
    } else if (gesture === "lock") {
      haptic(15);
      dispatch({ type: "lock" });
    } else {
      dispatch({ type: "move", dx, dy });
    }
  };

  const endTouch = (cancelled: boolean) => {
    const phase = stateRef.current.phase;
    if (phase === "requesting") {
      cancel(); // отпустили, пока браузер спрашивал разрешение: запись не нужна
    } else if (phase === "holding") {
      const total = recordedMs(baseMsRef.current, segmentStartRef.current, Date.now());
      if (cancelled || total < HOLD_MIN_MS) {
        cancel();
        if (!cancelled) setError(HOLD_HINT_MESSAGE);
      } else {
        finish();
      }
    }
    // Синтетический click после касания не должен запускать запись второй раз.
    setTimeout(() => {
      pointerTypeRef.current = "";
    }, 400);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse") return;
    endTouch(false);
  };
  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse") return;
    endTouch(true);
  };

  /** Мышь и клавиатура: один клик — запись сразу в замке (удерживать мышь неудобно). */
  const onClick = () => {
    if (pointerTypeRef.current === "touch" || pointerTypeRef.current === "pen") return;
    pointerTypeRef.current = "";
    void start(true);
  };

  // Уход с экрана или смена диалога — отмена, а не отправка обрубка. НО если палец уже отпущен («Отправить»), запись
  // доотправляется: обработчик остановки сам отдаст файл и освободит микрофон (ревью 27.11.2026: уход с экрана сразу
  // после отпускания терял голосовое молча).
  useEffect(
    () => () => {
      genRef.current++;
      const rec = recorderRef.current;
      if (rec && sendIntentRef.current) return;
      if (rec) {
        rec.ondataavailable = null;
        rec.onstop = null;
        if (rec.state !== "inactive") {
          try {
            rec.stop();
          } catch {
            /* уже остановлен */
          }
        }
      }
      releaseMic();
    },
    [releaseMic],
  );

  return {
    supported,
    state,
    elapsedMs,
    levels,
    error,
    clearError: () => setError(null),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick },
    pause,
    resume,
    send: finish,
    cancel,
    previewBlob,
  };
}
