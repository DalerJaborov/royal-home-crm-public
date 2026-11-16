/**
 * Общее для всех записей голоса в браузере (диктовка в ассистента и комментарии,
 * голосовые клиенту): выбор формата, имя файла, понятные тексты ошибок микрофона.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ (15.11.2026, жалоба владельца «микрофон не работает»).
 * Оба хука записи (useSpeechRecognition, useVoiceMessageRecorder) намертво просили
 * у MediaRecorder `audio/webm`. Safari и все браузеры на iPhone до 18.4 такого
 * формата не знают вовсе — `new MediaRecorder(stream, { mimeType: "audio/webm" })`
 * бросает NotSupportedError, и человек видел безликое «Не удалось включить
 * микрофон», хотя доступ он дал. Safari пишет `audio/mp4`; сервер его принимает
 * (Gemini читает контейнер MPEG-4, ffmpeg перекодирует для мессенджеров).
 * Формат теперь выбирается по тому, что браузер реально умеет, а правило живёт
 * в одном месте, а не копией в каждом хуке.
 */

/** От лучшего к запасному: opus компактнее, mp4 — то, что пишет Safari. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/aac",
] as const;

/** Запись голоса вообще возможна в этом браузере (без учёта https и разрешения). */
export function isRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

/** Первый формат из списка, который умеет этот браузер; undefined — пусть выберет сам. */
export function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_CANDIDATES.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });
}

/**
 * MediaRecorder с лучшим доступным форматом. Если браузер отверг и подобранный
 * формат (бывает на старых iOS: isTypeSupported врёт), пробуем без пожеланий —
 * лучше запись в формате по умолчанию, чем ошибка.
 */
export function createRecorder(stream: MediaStream): MediaRecorder {
  const preferred = pickRecorderMimeType();
  if (preferred) {
    try {
      return new MediaRecorder(stream, { mimeType: preferred });
    } catch {
      /* пробуем без пожеланий ниже */
    }
  }
  return new MediaRecorder(stream);
}

/** Тип записанного файла без параметров кодека: `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMime(type: string | undefined | null): string {
  return (type ?? "").split(";")[0].trim().toLowerCase();
}

/** Итоговый тип записи: что назвал рекордер, иначе тип первого куска, иначе формат Safari. */
export function recordedMime(recorder: { mimeType?: string }, chunks: Blob[]): string {
  return baseMime(recorder.mimeType) || baseMime(chunks[0]?.type) || "audio/mp4";
}

/** Имя файла по типу: сервер и ffmpeg ориентируются и по расширению. */
export function audioFileNameFor(mime: string, stem = "voice"): string {
  const m = baseMime(mime);
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return `${stem}.m4a`;
  if (m.includes("ogg")) return `${stem}.ogg`;
  return `${stem}.webm`;
}

/** Собрать файл записи из кусков: тип без кодека, чтобы сервер не спотыкался о параметры. */
export function buildRecordingBlob(recorder: { mimeType?: string }, chunks: Blob[]): Blob {
  return new Blob(chunks, { type: recordedMime(recorder, chunks) });
}

/** Меньше этого — случайное касание, а не речь: расшифровывать нечего. */
export const MIN_RECORDING_MS = 600;

/**
 * Что делать человеку — по причине, а не «не получилось». Причина лежит в err.name:
 * запрет доступа, нет микрофона, занят другой программой и «браузер не умеет формат»
 * лечатся совершенно по-разному.
 */
export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Доступ к микрофону запрещён. Разрешите его для сайта: значок замка слева в адресной строке (на iPhone: «Настройки → Safari → Микрофон»)";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "Микрофон не найден. Подключите его и попробуйте снова";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "Микрофон занят другой программой. Закройте её и попробуйте снова";
    case "NotSupportedError":
      return "Этот браузер не умеет записывать звук. Откройте CRM в Chrome или Safari последней версии";
    default:
      return "Не удалось включить микрофон. Попробуйте ещё раз";
  }
}

export const INSECURE_CONTEXT_MESSAGE = "Микрофон работает только на защищённой странице (https). Откройте CRM по https-адресу";
export const UNSUPPORTED_MESSAGE = "В этом браузере нельзя записать голос. Напишите текстом или откройте CRM в Chrome или Safari";
export const TOO_SHORT_MESSAGE = "Слишком коротко. Нажмите на микрофон и говорите, пока идёт запись";

/** Секунды вида «0:07» для таймера записи. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
