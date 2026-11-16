import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  audioFileNameFor,
  buildRecordingBlob,
  createRecorder,
  INSECURE_CONTEXT_MESSAGE,
  isRecordingSupported,
  micErrorMessage,
  MIN_RECORDING_MS,
  TOO_SHORT_MESSAGE,
  UNSUPPORTED_MESSAGE,
} from "../lib/audioRecording";

/**
 * Диктовка голосом — запись через MediaRecorder + расшифровка на сервере (Gemini),
 * а не браузерный Web Speech API.
 *
 * ПОЧЕМУ НЕ Web Speech API. Владелец 05.08.2026: «не понимает таджикский». Дело не
 * в том, что язык был захардкожен на ru-RU (это тоже было) — Web Speech API вообще
 * не знает такого языка ни в одном браузере, это ограничение платформы. Тот же путь,
 * что уже год расшифровывает голосовые клиентов из мессенджеров на таджикском
 * (apps/api/src/ai/transcribe.ts, единственный провайдер, который пишет таджикскую
 * речь таджикской кириллицей, не фарси), теперь доступен и здесь — через новый
 * эндпоинт POST /transcribe.
 *
 * Название файла/экспорта не менял: вызывающие компоненты (AddInteractionModal,
 * CommentWithVoice, AssistantPanel) держат интерфейс { supported, isListening, start,
 * stop } + isTranscribing (сетевая фаза после записи).
 *
 * ПРАВКА 15.11.2026 (владелец: «микрофон не работает вроде»). Что было не так:
 *  1. Формат жёстко `audio/webm` — на Safari/iPhone MediaRecorder его отвергает; теперь
 *     формат выбирается по возможностям браузера (lib/audioRecording.ts).
 *  2. Нет «поколения» записи, как у useVoiceMessageRecorder: закрыли панель, пока
 *     браузер спрашивал разрешение, — микрофон включался уже в закрытом окне;
 *     закрыли во время записи — обрубок уходил на платную расшифровку. Теперь уход
 *     с экрана и `cancel()` отбрасывают запись.
 *  3. Слишком короткая запись и пустая расшифровка молча ничего не делали — теперь
 *     человек получает понятный текст.
 *  4. `onResult` читается из ref: обработчик остановки раньше держал функцию той
 *     отрисовки, в которой началась запись.
 */

const MAX_RECORDING_MS = 60_000;

export function useSpeechRecognition(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [supported] = useState(isRecordingSupported);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  /** Поколение записи: любой «отбой» поднимает номер, устаревший start() выходит молча. */
  const genRef = useRef(0);
  const pendingGenRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (!supported) {
      setError(UNSUPPORTED_MESSAGE);
      return;
    }
    if (pendingGenRef.current === genRef.current) return; // уже ждём разрешения
    const gen = genRef.current;
    pendingGenRef.current = gen;
    setError(null);
    // Микрофон браузер отдаёт только на HTTPS (и на localhost). По http:// вызов
    // getUserMedia падает тем же исключением, что и запрет доступа, — и человек
    // ищет разрешение в настройках, которого там нет. Проверяем до вызова.
    if (!window.isSecureContext) {
      pendingGenRef.current = null;
      setError(INSECURE_CONTEXT_MESSAGE);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (gen !== genRef.current) {
        // Пока ждали разрешения, запись отменили или экран закрыли.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      pendingGenRef.current = null;
      streamRef.current = stream;
      // Отказ доступа/несовместимый формат бросает здесь, не в onstart — ловим до
      // того, как выставим isListening, иначе кнопка осталась бы «слушаю» навсегда.
      const recorder = createRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const duration = Date.now() - startedAtRef.current;
        const blob = buildRecordingBlob(recorder, chunksRef.current);
        cleanup();
        setIsListening(false);
        setElapsedMs(0);
        if (blob.size === 0 || duration < MIN_RECORDING_MS) {
          setError(TOO_SHORT_MESSAGE);
          return;
        }
        setIsTranscribing(true);
        try {
          const form = new FormData();
          form.append("audio", blob, audioFileNameFor(blob.type));
          const { text } = await api<{ text: string }>("/transcribe", { method: "POST", body: form });
          if (unmountedRef.current) return;
          if (text) onResultRef.current(text);
          else setError("Речь не распознана. Скажите ещё раз, чуть громче");
        } catch (err) {
          if (!unmountedRef.current) setError(err instanceof ApiError ? err.message : "Не удалось распознать речь. Проверьте интернет и попробуйте ещё раз");
        } finally {
          if (!unmountedRef.current) setIsTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsListening(true);
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      tickTimerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
      // Потолок длины записи — 60 сек: без него забытая нажатой кнопка пишет
      // бесконечно и раздувает файл сверх лимита на сервере (5 МБ).
      stopTimerRef.current = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_RECORDING_MS);
    } catch (err) {
      // Отказ или ошибка устаревшего start(): состояние принадлежит уже другому.
      if (gen !== genRef.current) return;
      pendingGenRef.current = null;
      // Причина лежит в err.name — разводим её на понятные советы (06.08.2026).
      setError(micErrorMessage(err));
      cleanup();
      setIsListening(false);
    }
  }, [supported, cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else {
      genRef.current++; // «стоп» до выдачи разрешения: запись, что начнётся позже, не нужна
      pendingGenRef.current = null;
      cleanup();
      setIsListening(false);
      setElapsedMs(0);
    }
  }, [cleanup]);

  /** Отбросить запись без расшифровки: обработчики снимаются раньше, чем рекордер глушится. */
  const discard = useCallback(() => {
    genRef.current++;
    pendingGenRef.current = null;
    if (recorderRef.current) {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      if (recorderRef.current.state === "recording") recorderRef.current.stop();
    }
    cleanup();
  }, [cleanup]);

  /** Передумал — запись отбрасывается без расшифровки. */
  const cancel = useCallback(() => {
    discard();
    setIsListening(false);
    setElapsedMs(0);
  }, [discard]);

  const clearError = useCallback(() => setError(null), []);

  // Размонтирование во время записи: окно закрыли, ушли на другой экран, сработал
  // выход по бездействию. Без этого поток микрофона оставался захваченным — у
  // человека продолжал гореть индикатор записи. Запись при этом ОТБРАСЫВАЕТСЯ, а не
  // уходит на платную расшифровку: stop() дорожек завершает запись и вызывает onstop.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      discard();
    };
  }, [discard]);

  return { supported, isListening, isTranscribing, error, elapsedMs, start, stop, cancel, clearError };
}
