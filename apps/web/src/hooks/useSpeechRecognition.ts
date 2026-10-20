import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";

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
 * Название файла/экспорта не менял: три вызывающих компонента (AddInteractionModal,
 * AssistantPanel) держат интерфейс { supported, isListening, start, stop } +
 * новое isTranscribing (сетевая фаза после записи — раньше её не было, браузерный
 * API отвечал мгновенно).
 */

const MAX_RECORDING_MS = 60_000;

export function useSpeechRecognition(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(
    () => typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
  );

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (!supported || recorderRef.current) return;
    setError(null);
    // Микрофон браузер отдаёт только на HTTPS (и на localhost). По http:// вызов
    // getUserMedia падает тем же исключением, что и запрет доступа, — и человек
    // ищет разрешение в настройках, которого там нет. Проверяем до вызова.
    if (!window.isSecureContext) {
      setError("Голосовой ввод работает только по защищённому соединению (https)");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Отказ доступа к микрофону/несовместимый браузер бросает здесь, не в
      // onstart — ловим до того, как выставим isListening, иначе кнопка осталась
      // бы «слушаю» навсегда, хотя запись не началась (та же ловушка, что раньше
      // была с recognition.start()).
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
        setIsListening(false);
        if (blob.size === 0) return;
        setIsTranscribing(true);
        try {
          const form = new FormData();
          form.append("audio", blob, "voice.webm");
          const { text } = await api<{ text: string }>("/transcribe", { method: "POST", body: form });
          if (text) onResult(text);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "Не удалось распознать речь");
        } finally {
          setIsTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsListening(true);
      // Потолок длины записи — 60 сек: без него забытая нажатой кнопка пишет
      // бесконечно и раздувает файл сверх лимита на сервере (5 МБ).
      stopTimerRef.current = setTimeout(() => recorder.state === "recording" && recorder.stop(), MAX_RECORDING_MS);
    } catch (err) {
      // Три разные беды выглядели одинаково — «Нет доступа к микрофону», и по
      // такому тексту нельзя понять, что делать. Владелец 06.08.2026 наткнулся
      // ровно на это. Причина лежит в err.name, разводим её на понятные советы.
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
      setIsListening(false);
    }
  }, [supported, onResult, cleanup]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else {
      cleanup();
      setIsListening(false);
    }
  }, [cleanup]);

  // Размонтирование во время записи: окно закрыли, ушли на другой экран, сработал
  // выход по бездействию. Без этого поток микрофона оставался захваченным — у
  // человека продолжал гореть индикатор записи, а браузер считал вкладку
  // «слушающей» до перезагрузки страницы. cleanup останавливает дорожки и таймер.
  useEffect(() => cleanup, [cleanup]);

  return { supported, isListening, isTranscribing, error, start, stop };
}
