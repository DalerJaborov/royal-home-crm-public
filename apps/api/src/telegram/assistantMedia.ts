import { open } from "node:fs/promises";
import { resolveTelegramFile, type TelegramIncomingMessage } from "./api.js";
import { understandAssistantMedia } from "../ai/assistant/mediaUnderstanding.js";
import { loadAssistantSettings, loadAssistantGeminiRuntime } from "../ai/assistant/runtime.js";
import { ASSISTANT_TAJIK_MODEL } from "../ai/assistant/languageRouting.js";
import { createAssistantMoneyGuard, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { createAssistantAttemptLimit } from "../ai/assistant/attemptLimit.js";
import { reserveAssistantGeminiAttempt } from "../ai/assistant/attemptBudget.js";

/** Bounded download even when Telegram's reported file_size is wrong. No arbitrary URL input. */
export async function downloadAssistantMedia(fileId: string, maximum: number): Promise<Buffer> {
  const reference = await resolveTelegramFile(fileId, maximum, 10_000);
  if (!reference) throw new Error("media_download_failed");
  if (reference.kind === "path") {
    const handle = await open(reference.path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new Error("media_size_rejected");
      const buffer = Buffer.alloc(maximum + 1);
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

/** Caller MUST verify the Telegram sender is this active employee before invoking. */
export async function handleAssistantMedia(msg: TelegramIncomingMessage, agentId: string, options: {
  /** Set only AFTER the caller's employee/group access and masking checks. */
  allowGroup?: boolean;
  wallet?: AssistantMoneyWallet;
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
    const runtime = { ...await loadAssistantGeminiRuntime(), model: ASSISTANT_TAJIK_MODEL, fallbackModels: [], liteModel: "" };
    if (!runtime.keys[0]) throw new Error("media_provider_unavailable");
    stage = "download";
    const buffer = await downloadAssistantMedia(source.file_id, maximum);
    stage = "recognition";
    const guard = createAssistantMoneyGuard({ wallet: options.wallet });
    const attemptLimit = createAssistantAttemptLimit(reserveAssistantGeminiAttempt, 2);
    const result = await understandAssistantMedia({ buffer, mimeType, runtime, apiKey: runtime.keys[0], beforeAttempt: async (metadata) => {
      await attemptLimit();
      await guard(metadata);
    } });
    const content = [result.extraction.transcript, result.extraction.readableText, result.extraction.visualDescription].filter(Boolean).join("\n\n");
    return { extraction: result.extraction, text: content
      ? `Извлечено из файла; данные требуют проверки:\n\n${content}${result.extraction.incomplete ? "\n\nЧасть файла не удалось разобрать." : ""}`
      : "В файле не удалось уверенно разобрать текст или речь." };
  } catch (error) {
    // Never expose token-bearing Telegram URLs or private file paths to the chat.
    const message = error instanceof Error ? error.message : "";
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
