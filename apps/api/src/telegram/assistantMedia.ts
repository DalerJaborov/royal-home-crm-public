import { open } from "node:fs/promises";
import { IS_LOCAL_BOT_API, resolveTelegramFile, type TelegramIncomingMessage } from "./api.js";
import { understandAssistantMedia } from "../ai/assistant/mediaUnderstanding.js";
import { loadAssistantSettings, loadAssistantGeminiRuntime } from "../ai/assistant/runtime.js";
import { ASSISTANT_TAJIK_MODEL, assistantLanguage } from "../ai/assistant/languageRouting.js";
import { createAssistantMoneyGuard, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { createAssistantAttemptLimit } from "../ai/assistant/attemptLimit.js";
import { reserveAssistantGeminiAttempt } from "../ai/assistant/attemptBudget.js";
import { assistantLimitText } from "../ai/assistant/limitText.js";
import { recognizeShortAssistantVoice } from "./assistantScribe.js";

const TAJIK_LETTERS = /[ғӣқӯҳҷ]/iu;

/** Bounded download even when Telegram's reported file_size is wrong. No arbitrary URL input. */
export async function downloadAssistantMedia(fileId: string, maximum: number): Promise<Buffer> {
  // Свой Bot API-сервер отвечает на getFile, только когда сам докачал файл у
  // Telegram, — ему общий таймаут; облаку хватает десяти секунд.
  const reference = IS_LOCAL_BOT_API ? await resolveTelegramFile(fileId, maximum) : await resolveTelegramFile(fileId, maximum, 10_000);
  if (!reference) throw new Error("media_download_failed");
  if (reference.kind === "path") {
    const handle = await open(reference.path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new Error("media_size_rejected");
      // По фактическому размеру файла (+1 байт, чтобы заметить дописанный хвост), а не по пределу.
      const buffer = Buffer.alloc(Math.min(maximum, stat.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > maximum) throw new Error("media_size_rejected");
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }
  const response = await fetch(reference.url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("media_download_failed");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw new Error("media_size_rejected");
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

/**
 * Один разбор файла моделью (фото, PDF-скан, аудио) с тем же бюджетом и теми же двумя
 * попытками, что у «пересказа файла». Общая дверь: сюда же ходит мастер объекта за
 * текстом со сканов и фото документов (assistantPropertyDocument.ts).
 */
export async function runAssistantMediaUnderstanding(buffer: Buffer, mimeType: string, wallet?: AssistantMoneyWallet) {
  const runtime = { ...await loadAssistantGeminiRuntime(), model: ASSISTANT_TAJIK_MODEL, fallbackModels: [], liteModel: "" };
  if (!runtime.keys[0]) throw new Error("media_provider_unavailable");
  const guard = createAssistantMoneyGuard({ wallet });
  const attemptLimit = createAssistantAttemptLimit(reserveAssistantGeminiAttempt, 2);
  return understandAssistantMedia({ buffer, mimeType, runtime, apiKey: runtime.keys[0], beforeAttempt: async (metadata) => {
    await attemptLimit();
    await guard(metadata);
  } });
}

/** Caller MUST verify the Telegram sender is this active employee before invoking. */
export async function handleAssistantMedia(msg: TelegramIncomingMessage, agentId: string, options: {
  /** Set only AFTER the caller's employee/group access and masking checks. */
  allowGroup?: boolean;
  wallet?: AssistantMoneyWallet;
  /** Язык собеседника для отказа денежной защиты, если подписи нет (голосовое): по истории чата. */
  language?: () => Promise<"ru" | "tg">;
  /** Голосовое в группе, где Шабнам НЕ звали: таджикская речь остаётся на быстрой расшифровке (без расхода сильной модели). */
  fastTajikOk?: boolean;
} = {}): Promise<{ text: string; error?: string; extraction?: Awaited<ReturnType<typeof understandAssistantMedia>>["extraction"] }> {
  if ((msg.chat.type !== "private" && !options.allowGroup) || !agentId) return { text: "Файлы помощник разбирает только в личном чате сотрудника.", error: "media_scope" };
  const isVoice = Boolean(msg.voice || msg.audio);
  let stage: "configuration" | "download" | "recognition" = "configuration";
  try {
    if (!(await loadAssistantSettings()).enabled) return { text: "ИИ-помощник выключен.", error: "assistant_disabled" };
    const photo = msg.photo?.at(-1);
    const voice = msg.voice ?? msg.audio;
    const source = photo ?? voice ?? msg.document;
    const mimeType = photo ? "image/jpeg" : voice ? voice.mime_type ?? "audio/ogg" : msg.document?.mime_type;
    const maximum = mimeType?.startsWith("image/") ? 2_000_000 : mimeType === "application/pdf" ? 4_000_000 : 1_000_000;
    if (!source || !mimeType || !/^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|x-m4a|wav|webm)|application\/(pdf|ogg))$/.test(mimeType)) {
      return { text: isVoice ? "Пришли обычное голосовое или напиши текстом." : "Пришлите одно фото, PDF до 20 страниц или аудио до 2 минут.", error: "media_unsupported" };
    }
    if (source.file_size && source.file_size > maximum) throw new Error("media_size_rejected");
    const duration = msg.voice?.duration;
    const shortNativeGroupVoice = options.allowGroup && msg.chat.type !== "private"
      && typeof duration === "number" && duration > 0 && duration <= 12 && mimeType === "audio/ogg"
      && !msg.forward_origin && !msg.forward_from_message_id;
    stage = "download";
    const buffer = await downloadAssistantMedia(source.file_id, maximum);
    stage = "recognition";
    if (shortNativeGroupVoice && buffer.length <= 128_000) {
      const short = await recognizeShortAssistantVoice(buffer);
      // Таджикскую речь быстрая расшифровка портит («Рут сиех. Голосовая гуш к охи», 24.11.2026): когда Шабнам
      // позвали, как в личке, она идёт на сильную модель ниже (тот же счёт попыток и денег). Быстрый путь — для
      // русского, «спасибо» и всех голосовых, адресованных не ей: на них сильную модель не тратим.
      if (short && (options.fastTajikOk || (short.language !== "tg" && !TAJIK_LETTERS.test(short.transcript)))) return { text: short.transcript, extraction: {
        ...short, readableText: "", visualDescription: "", incomplete: false,
      } };
    }
    const result = await runAssistantMediaUnderstanding(buffer, mimeType, options.wallet);
    const content = [result.extraction.transcript, result.extraction.readableText, result.extraction.visualDescription].filter(Boolean).join("\n\n");
    return { extraction: result.extraction, text: content
      ? `Извлечено из файла; данные требуют проверки:\n\n${content}${result.extraction.incomplete ? "\n\nЧасть файла не удалось разобрать." : ""}`
      : "В файле не удалось уверенно разобрать текст или речь." };
  } catch (error) {
    // Never expose token-bearing Telegram URLs or private file paths to the chat.
    const message = error instanceof Error ? error.message : "";
    // Отказ денежной защиты (дневной предел, учёт недоступен) — правдой, а не «пришлите ещё раз»,
    // и на языке собеседника: по подписи, иначе по истории чата (голосовое подписи не имеет).
    if (assistantLimitText(error)) {
      const caption = (msg.caption ?? msg.text ?? "").trim();
      const spoken = caption ? assistantLanguage([{ role: "user", content: caption }]) : null;
      const lang = spoken === "tg" || spoken === "mixed" ? "tg" : spoken === "ru" ? "ru"
        : await (options.language?.() ?? Promise.resolve("ru" as const)).catch(() => "ru" as const);
      return { text: assistantLimitText(error, lang) ?? "", error: "media_money_limit" };
    }
    if (message === "media_audio_limit" || (isVoice && message === "media_size_rejected")) {
      return { text: "Пришлите голосовое до двух минут и до 1 МБ или напишите текстом.", error: "media_audio_limit" };
    }
    console.warn("[telegram:assistant:media] extraction failed", { kind: isVoice ? "voice" : "file", stage });
    if (!isVoice) return { text: "Не удалось разобрать файл. Попробуйте отправить его повторно.", error: "media_failed" };
    if (stage === "download") {
      return { text: "Не удалось скачать голосовое из Telegram. Отправь его ещё раз.", error: "media_download_failed" };
    }
    if (message === "media_invalid_extraction" || message === "media_invalid_modality") {
      return { text: "Не удалось разобрать речь. Запиши ещё раз или напиши текстом.", error: "media_speech_unclear" };
    }
    return { text: "Распознавание голоса сейчас недоступно. Напиши текстом или попробуй чуть позже.", error: "media_recognition_unavailable" };
  }
}
