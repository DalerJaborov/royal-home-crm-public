import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ASSISTANT_GROUP_GREETING } from "./assistantGroupPhrases.js";

// Only neutral phrases: no names, prices, contacts, cards or generated business claims in shared audio.
const NEUTRAL = new Set(["Здравствуйте!", "Здравствуйте.", "Чем помочь?", "Готово.", "Спасибо!", "Спасибо.",
  "Хорошо.", "Проверю.", "Уточните, пожалуйста.", "Уточните номер карточки.", "Подтвердите действие кнопкой.",
  "Не удалось выполнить. Попробуйте ещё раз.", "Ничего не нашла.", "Выберите нужную карточку.",
  ...Object.values(ASSISTANT_GROUP_GREETING)]);
const TTL_MS = 30 * 24 * 60 * 60_000;
/** Cheap container check, not a decoder: reject JSON/HTML or damaged non-audio cache hits. */
export function isOggOpusAudio(audio: Buffer): boolean {
  return audio.length >= 20 && audio.subarray(0, 4).toString("ascii") === "OggS"
    && audio.subarray(0, 128).includes(Buffer.from("OpusHead", "ascii"));
}
const entrySchema = z.object({ createdAt: z.number().finite(), audio: z.string().min(4).max(3_000_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((audio) => isOggOpusAudio(Buffer.from(audio, "base64"))), fileId: z.string().min(1).max(1024).optional() }).strict();
export type VoiceCacheEntry = z.infer<typeof entrySchema>;
const inFlight = new Map<string, Promise<VoiceCacheEntry | null>>();
export function cacheableAssistantSpeech(text: string): boolean { return NEUTRAL.has(text.trim()); }
export function assistantVoiceCacheKey(text: string, settings: unknown): string {
  // Token is only hashed; Telegram file IDs cannot be reused by a different bot.
  return createHash("sha256").update(JSON.stringify(["assistant-opus-v1", text, settings, process.env.TELEGRAM_BOT_TOKEN ?? "unconfigured"])).digest("hex");
}
function root(): string { return path.resolve(process.env.PRIVATE_UPLOADS_DIR ?? "./uploads-private", "voice", "assistant-opus"); }
function file(key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid voice cache key");
  return path.join(root(), `${key}.json`);
}
export async function readAssistantVoiceCache(key: string): Promise<VoiceCacheEntry | null> {
  try {
    const filePath = file(key);
    if ((await fs.stat(filePath)).size > 3_100_000) return null;
    const parsed = entrySchema.safeParse(JSON.parse(await fs.readFile(filePath, "utf8")));
    if (!parsed.success || Date.now() - parsed.data.createdAt > TTL_MS || parsed.data.createdAt > Date.now()) return null;
    return parsed.data;
  } catch { return null; } // Missing/corrupt cache never prevents a text response.
}
export async function writeAssistantVoiceCache(key: string, entry: VoiceCacheEntry): Promise<void> {
  const target = file(key), temp = `${target}.${randomUUID()}.tmp`;
  try {
    const valid = entrySchema.parse(entry);
    await fs.mkdir(root(), { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, JSON.stringify(valid), { mode: 0o600 });
    await fs.rename(temp, target);
    // Bounded cache; delete only this module's hash-named entries, never unrelated files.
    const names = (await fs.readdir(root())).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length > 128) {
      const entries = await Promise.all(names.map(async (name) => ({ name, time: (await fs.stat(path.join(root(), name))).mtimeMs })));
      for (const old of entries.sort((a, b) => a.time - b.time).slice(0, names.length - 128)) await fs.unlink(path.join(root(), old.name));
    }
  } catch { /* Best effort: a successful voice send must not become a failed turn. */ }
  finally { await fs.unlink(temp).catch(() => undefined); }
}
export async function cachedAssistantAudio(key: string, synthesize: () => Promise<Buffer | null>): Promise<VoiceCacheEntry | null> {
  const cached = await readAssistantVoiceCache(key);
  if (cached) return cached;
  const running = inFlight.get(key);
  if (running) return running;
  const task = (async () => {
    const audio = await synthesize();
    if (!audio || !isOggOpusAudio(audio)) return null;
    const entry: VoiceCacheEntry = { createdAt: Date.now(), audio: audio.toString("base64") };
    await writeAssistantVoiceCache(key, entry);
    return entry;
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}
