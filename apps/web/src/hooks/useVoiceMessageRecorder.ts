import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";

/**
 * Запись голосового сообщения для отправки клиенту — MediaRecorder, тот же приём,
 * что и в useSpeechRecognition.ts (webm/opus, HTTPS-проверка, разбор ошибок доступа
 * к микрофону по err.name), но результат другой: там расшифровка ложится текстом
 * в поле ввода, здесь сам файл уходит на сервер как есть — перекодирует и проверит
 * его уже сервер (lib/audioTranscode.ts, ai/voiceComplianceGuard.ts).
 *
 * `send` — функция самой отправки (POST .../reply-voice или .../message-voice,
 * разные у инбокса и карточки клиента), передаётся вызывающим: хук отвечает
 * только за запись, не за то, куда уходит результат.
 */

const MAX_RECORDING_MS = 120_000;

export function useVoiceMessageRecorder(send: (blob: Blob) => Promise<unknown>) {
  const [isRecording, setIsRecording] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(
    () => typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
  );

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  /**
   * ПОКОЛЕНИЕ ЗАПИСИ (аудит 04.10.2026, WEB-07). getUserMedia ждёт разрешения
   * микрофона сколько угодно, а за это время экран могли закрыть, диалог
   * переключить, запись отменить. Любой из этих жестов поднимает номер; start()
   * сверяет его после await и, если он ушёл вперёд, глушит полученный поток и
   * выходит: иначе запись шла бы до 2 минут и по onstop уходила в прежний диалог.
   */
  const genRef = useRef(0);
  /** Номер ожидающего разрешения start(): повторный start на это время не нужен. */
  const pendingGenRef = useRef<number | null>(null);

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
    if (!supported || recorderRef.current) return;
    if (pendingGenRef.current === genRef.current) return; // уже ждём разрешения
    const gen = genRef.current;
    pendingGenRef.current = gen;
    setError(null);
    if (!window.isSecureContext) {
      pendingGenRef.current = null;
      setError("Запись голоса работает только по защищённому соединению (https)");
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
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm",
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        cleanup();
        setIsRecording(false);
        setElapsedMs(0);
        if (blob.size === 0) return;
        setIsSending(true);
        try {
          await send(blob);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "Не удалось отправить голосовое");
        } finally {
          setIsSending(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      startedAtRef.current = Date.now();
      tickTimerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
      // Потолок записи — 2 минуты: дольше в переписке никто не слушает, а забытая
      // нажатой кнопка не должна писать бесконечно.
      stopTimerRef.current = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_RECORDING_MS);
    } catch (err) {
      // Отказ или ошибка устаревшего start(): состояние принадлежит уже другому.
      if (gen !== genRef.current) return;
      pendingGenRef.current = null;
      const name = (err as { name?: string })?.name;
      setError(
        name === "NotAllowedError"
          ? "Доступ к микрофону запрещён. Разрешите его для сайта — значок замка слева в адресной строке"
          : name === "NotFoundError" || name === "DevicesNotFoundError"
            ? "Микрофон не найден. Подключите его и попробуйте снова"
            : name === "NotReadableError"
              ? "Микрофон занят другой программой — закройте её и попробуйте снова"
              : "Не удалось включить микрофон"
      );
      cleanup();
      setIsRecording(false);
    }
  }, [supported, send, cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else {
      genRef.current++; // «стоп» до выдачи разрешения: запись, что начнётся позже, не нужна
      cleanup();
      setIsRecording(false);
      setElapsedMs(0);
    }
  }, [cleanup]);

  /** Передумал — запись отбрасывается без отправки. */
  const cancel = useCallback(() => {
    genRef.current++;
    if (recorderRef.current) {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      if (recorderRef.current.state === "recording") recorderRef.current.stop();
    }
    cleanup();
    setIsRecording(false);
    setElapsedMs(0);
  }, [cleanup]);

  /**
   * УХОД С ЭКРАНА = ОТМЕНА, А НЕ ОТПРАВКА (аудит №4, 27.08).
   *
   * Раньше на размонтировании звался просто cleanup(): он останавливает дорожки
   * микрофона, а это по спецификации ЗАВЕРШАЕТ запись — MediaRecorder вызывает
   * ondataavailable и onstop, и обработчик onstop отправлял обрубленное на
   * полуслове голосовое клиенту в WhatsApp/Instagram. Достаточно было начать
   * наговаривать и нажать «Назад» или переключить диалог (вид пересоздаётся по
   * key). Ведём себя как cancel: сперва снимаем обработчики, потом глушим.
   */
  useEffect(
    () => () => {
      genRef.current++;
      if (recorderRef.current) {
        recorderRef.current.ondataavailable = null;
        recorderRef.current.onstop = null;
        if (recorderRef.current.state === "recording") recorderRef.current.stop();
      }
      cleanup();
    },
    [cleanup]
  );

  return { supported, isRecording, isSending, elapsedMs, error, start, stop, cancel };
}
