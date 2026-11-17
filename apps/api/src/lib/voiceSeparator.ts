import fs from "node:fs";
import http from "node:http";
import https from "node:https";

/**
 * СЕРВИС «УБРАТЬ ГОЛОС» (16.11.2026). Отдельный контейнер `voice-separator` рядом с worker
 * (apps/voice-separator, docker-compose.prod.yml): модель MDX Kim_Vocal_2 отделяет голос от
 * музыки, затем faster-whisper проверяет, не осталось ли в музыке речи. Один запрос за раз —
 * очередь держит сам сервис (однопоточный) и обход по одному объекту (lib/narrationAutoMaster.ts).
 *
 * Адрес — VOICE_SEPARATOR_URL; не задан — возможности нет, объект идёт монтажёру, как раньше.
 * Ничего не бросает: отказ возвращается кодом и текстом, журнал пишет вызывающий.
 *
 * Запрос — node:http, а не fetch (ревью 16.11.2026): fetch (undici) ждёт заголовки ответа не дольше
 * 300 с, а сервис шлёт их только после всей работы — длинный ролик падал бы через 5 минут.
 */

/** Сторож: сколько речи распознавание может «услышать» в музыке, прежде чем мастер бракуется.
 *  Замер 16.11.2026 (журнал docs/journal/2026-11-16-narration-auto-separate.md): чистая музыка —
 *  0 слов (№143, №192), ложные срабатывания распознавания — 1–2 слова, голос не ушёл — 73 слова
 *  и 103 с речи (№197). Брак — 5 слов и больше ИЛИ 3 с речи и больше. */
export const VOICE_SEPARATOR_RESIDUAL_WORDS_MAX = 4;
export const VOICE_SEPARATOR_RESIDUAL_SPEECH_SEC_MAX = 2.9;
/** Предел ожидания: 2-минутный ролик на 6 ядрах — ОЦЕНКА 2–3 мин, с большим запасом на очередь. */
export const VOICE_SEPARATOR_TIMEOUT_MS = 15 * 60_000;

export function voiceSeparatorUrl(): string | null {
  const raw = process.env.VOICE_SEPARATOR_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export type VoiceSeparation =
  | { ok: true; words: number; speechSec: number; separateMs: number; checkMs: number; text: string }
  /** ABSENT — сервиса нет в сети (образ не собран): ждать нечего. TIMEOUT — сервис занят этим роликом
   *  дальше предела: повтор встал бы в ту же очередь. Повторяют только FAILED (перезапуск, 5xx). */
  | { ok: false; code: "OFF" | "ABSENT" | "TIMEOUT" | "FAILED"; error: string };

/** Звук ролика (WAV) → музыка без голоса в outPath (FLAC) + сколько речи распознано в музыке. */
export async function separateVoice(input: { audioPath: string; outPath: string; timeoutMs?: number }): Promise<VoiceSeparation> {
  const base = voiceSeparatorUrl();
  if (!base) return { ok: false, code: "OFF", error: "Сервис отделения голоса не подключён (VOICE_SEPARATOR_URL)." };
  const timeoutMs = input.timeoutMs ?? VOICE_SEPARATOR_TIMEOUT_MS;
  let body: Buffer;
  try { body = await fs.promises.readFile(input.audioPath); } catch (err) {
    return { ok: false, code: "FAILED", error: `Звук ролика не прочитан: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }
  const url = new URL(`${base}/separate`);
  const client = url.protocol === "https:" ? https : http;
  return new Promise<VoiceSeparation>((resolve) => {
    let settled = false;
    const done = (r: VoiceSeparation) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const req = client.request(url, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", (err) => done({ ok: false, code: "FAILED", error: `Ответ сервиса оборвался: ${err.message.slice(0, 200)}` }));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          done({ ok: false, code: "FAILED", error: `Сервис отделения голоса ответил ${res.statusCode}: ${data.toString("utf8").slice(0, 200)}` });
          return;
        }
        // Сторож закрыт при сбое: нет итога распознавания — нет и мастера.
        const words = Number(res.headers["x-speech-words"]), speechSec = Number(res.headers["x-speech-seconds"]);
        if (!Number.isFinite(words) || !Number.isFinite(speechSec) || res.headers["x-speech-words"] === undefined || !data.length) {
          done({ ok: false, code: "FAILED", error: "Сервис не прислал музыку или итог проверки речи." });
          return;
        }
        const num = (v: string | string[] | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        let text = "";
        try { text = decodeURIComponent(String(res.headers["x-speech-text"] ?? "")); } catch { text = ""; }
        fs.promises.writeFile(input.outPath, data).then(
          () => done({ ok: true, words, speechSec, separateMs: num(res.headers["x-separate-ms"]), checkMs: num(res.headers["x-check-ms"]), text }),
          (err: Error) => done({ ok: false, code: "FAILED", error: `Музыка не записана: ${err.message.slice(0, 200)}` }),
        );
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, code: "TIMEOUT", error: `Сервис отделения голоса не ответил за ${Math.round(timeoutMs / 60_000)} мин.` });
    }, timeoutMs);
    req.on("error", (err: NodeJS.ErrnoException) => done({ ok: false, code: err.code === "ENOTFOUND" ? "ABSENT" : "FAILED", error: `Сервис отделения голоса недоступен: ${err.message.slice(0, 200)}` }));
    req.end(body);
  });
}
