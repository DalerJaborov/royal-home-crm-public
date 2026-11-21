import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isAiAssistantEnabled } from "../ai/assistant.js";
import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import { tryRunFfmpeg } from "../lib/ffmpeg.js";
import { maskPhonesInFreeText } from "../lib/clientPhone.js";
import { createAssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { runAssistantMediaUnderstanding } from "./assistantMedia.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { resolveTelegramFileMaterialization, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES } from "./api.js";

/**
 * ЧТО ГОВОРЯТ В РОЛИКЕ (21.11.2026): звук присланного сотрудником ролика → текст, чтобы узнать
 * объект по озвучке (lib/clipPropertyRecognition.ts). Новой расшифровки нет: та же дверь, что
 * у голосовых Шабнам (telegram/assistantMedia.ts::runAssistantMediaUnderstanding — модель,
 * денежный конверт хода и дня, две попытки). Из ролика берём только звук первых
 * CLIP_SPEECH_SECONDS секунд моно 16 кГц: столько разбирает дверь (до двух минут, до 1 МБ).
 *
 * ЦЕНА ОДНОГО РОЛИКА (ОЦЕНКА по тарифу в ai/assistant/moneyPolicy.ts, Gemini 3.1 Pro: вход 2 $,
 * выход 12 $ за миллион): звук 110 с ≈ 3 500 токенов входа (32 токена в секунду) ≈ 0,007 $,
 * расшифровка с размышлением до ~800 токенов ≈ 0,01 $ — около 0,02 $ (≈ 0,2 сомони) за ролик.
 * Потолок — CLIP_SPEECH_DAILY_LIMIT роликов на сотрудника в день.
 */
export const CLIP_SPEECH_SECONDS = 110;
export const CLIP_SPEECH_DAILY_LIMIT = 30;

export type ClipSpeech = { transcript: string } | { skipped: "disabled" | "limit" | "download" | "no_audio" | "failed" };

export async function transcribeClipSpeech(fileId: string, agentId: string): Promise<ClipSpeech> {
  if (!(await isAiAssistantEnabled())) return { skipped: "disabled" };
  const material = await resolveTelegramFileMaterialization(fileId, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES).catch(() => null);
  if (!material) return { skipped: "download" };
  const dir = path.join(os.tmpdir(), `clip-speech-${randomUUID()}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    let input: string;
    if (material.kind === "path") input = material.path;
    else {
      input = path.join(dir, "clip.bin");
      await fs.promises.writeFile(input, material.buffer);
    }
    const audio = path.join(dir, "speech.m4a");
    const extracted = await tryRunFfmpeg({
      label: "звук ролика для распознавания объекта",
      timeoutMs: 90_000,
      args: ["-y", "-i", input, "-t", String(CLIP_SPEECH_SECONDS), "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", "-f", "mp4", audio],
    });
    const stat = extracted ? await fs.promises.stat(audio).catch(() => null) : null;
    if (!stat || stat.size < 1_000) return { skipped: "no_audio" };
    if (stat.size > 1_000_000) return { skipped: "failed" };
    // Платный шаг — после всех бесплатных проверок, со своим дневным потолком.
    const cap = await claimAgentAiAction(agentId, "assistant-clip-speech", CLIP_SPEECH_DAILY_LIMIT);
    if (!cap.allowed) return { skipped: "limit" };
    const result = await runAssistantMediaUnderstanding(await fs.promises.readFile(audio), "audio/mp4", createAssistantMoneyWallet());
    const text = result.extraction.transcript.trim();
    return text ? { transcript: maskPhonesInFreeText(text).slice(0, 4000) } : { skipped: "no_audio" };
  } catch (err) {
    // Без расшифровки распознавание идёт по имени файла и подписи; сбой виден в журнале CRM, а не только в консоли.
    void logSystemError("ai", `Звук ролика для распознавания объекта не расшифрован — ${describeError(err)}`, { dedupKey: "staff-clip-speech" });
    return { skipped: "failed" };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
