import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { prisma } from "../../db.js";
import { synthesizeSpeech } from "../../ai/tts.js";
import { ttsQuotaPausedUntil } from "../../ai/tts.js";
import { GEMINI_WHISPER_TTS_MODELS } from "../../ai/geminiTransport.js";
import {
  WHISPER_TTS_MODEL,
  stylePrompt,
  transcodeWhisper,
  whisperDir,
  whisperFilePath,
  WhisperAudioError,
  WhisperQuotaPausedError,
} from "./whisperAudio.js";
import { isSpeakablePiece, type WhisperLanguage } from "./whisperText.js";

/**
 * ПОДСКАЗКА СОБИРАЕТСЯ ИЗ КУСОЧКОВ, А НЕ ОЗВУЧИВАЕТСЯ ЦЕЛИКОМ.
 *
 * ПОЧЕМУ (владелец 20.08.2026, в первый же день упёрлись в потолок). Синтез речи
 * ограничен не деньгами, а суточной квотой: живой ответ Google — метрика
 * `generate_requests_per_model_per_day`, ЛИМИТ 100 запросов в сутки на проект и
 * модель, причём для preview-модели он не зависит от оплаты. Озвучка фразы целиком
 * — это один запрос НА КАЖДОГО клиента, и любая правка карточки его повторяет: сто
 * клиентов в день — и всё, синтез молчит до завтра.
 *
 * Но фраза состоит из конечного словаря («харидор», «фурӯшанда», «манзил дар
 * Сомонӣ») и одного изменчивого куска — имени. Словарь озвучивается ОДИН РАЗ
 * навсегда; имена повторяются между клиентами; готовый файл склеивается из кусочков
 * на нашей стороне — бесплатно, мгновенно и без сети.
 *
 * Что это даёт на практике: первая заливка базы в 500 карточек — примерно 200
 * запросов вместо 500, а переозвучка после правки карточки почти всегда НЕ СТОИТ НИ
 * ОДНОГО запроса: сменился район — слово уже озвучено, файл пересобирается склейкой.
 *
 * ГРАНИЦА КУСКА — СМЫСЛОВАЯ ЧАСТЬ ФРАЗЫ, а не слово: «манзил дар Сомонӣ» режется
 * целиком, потому что интонация внутри куска должна быть естественной. Резать на
 * отдельные слова значило бы получить речь робота из букваря.
 */

/** Пауза между кусками, миллисекунды: без неё склейка звучит как одно слипшееся слово. */
const GAP_MS = 120;

/**
 * Сколько живёт неиспользуемый кусок. Имя клиента, с которым агентство расстались,
 * незачем держать на диске вечно — но и удалять сразу нельзя: тот же «Фаррух»
 * встретится у следующего клиента, и повторный синтез стоил бы запроса из квоты.
 */
const CLIP_TTL_DAYS = 90;

/** Файл кусочка на диске — там же, где готовые подсказки (см. whisperAudio.ts). */
function newClipName(): string {
  return `cl${randomBytes(8).toString("hex")}`;
}

/**
 * КУСОК, КОТОРЫЙ СИНТЕЗ УЖЕ ОТКАЗАЛСЯ ЧИТАТЬ, НЕ ПРОСИМ СНОВА ЧЕРЕЗ ПЯТЬ МИНУТ.
 *
 * ЧТО БЫЛО НЕ ТАК (журнал прода за 48 часов, 22.08.2026). Крон подсказок ходит каждые
 * пять минут по одним и тем же карточкам. Кусок, на котором модель молчит, ронял сборку
 * ЦЕЛИКОМ — подсказка не сохранялась, отпечаток оставался прежним, и следующий проход
 * начинал с того же куска. Один клиент с ником вместо имени = 288 запросов в сутки из
 * квоты в 100, и все впустую. Отсюда и 429 на всё остальное.
 *
 * Отказ помним ШЕСТЬ ЧАСОВ, а не вечно: молчание могло быть и разовой странностью
 * модели, а карточка живёт годами. Память процессная — перезапуск API даёт куску ещё
 * один шанс, и это осознанно: заводить ради отрицательного ответа колонку в базе и
 * миграцию дороже, чем пережить один лишний запрос после выката.
 */
const FAILED_CLIP_RETRY_MS = 6 * 3600 * 1000;
const failedClips = new Map<string, number>();

function clipKey(text: string, language: WhisperLanguage, voice: string): string {
  return `${language}|${voice}|${text}`;
}

function clipOnCooldown(text: string, language: WhisperLanguage, voice: string): boolean {
  const key = clipKey(text, language, voice);
  const until = failedClips.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    failedClips.delete(key);
    return false;
  }
  return true;
}

/**
 * Сколько кусков фразы ждут конца своей паузы. Зовёт синхронизация (whisperSync.ts):
 * подсказка, собранная без такого куска, помечена как неполная и обязана пересобраться —
 * но не каждые пять минут, а когда куску снова можно дать шанс. А если пауза на ВСЕХ
 * кусках, пересобирать нечего вовсе и жаловаться в журнал не о чем.
 */
export function whisperPiecesOnCooldown(pieces: string[], language: WhisperLanguage, voice: string): number {
  return pieces.filter((piece) => clipOnCooldown(piece, language, voice)).length;
}

/** Только для тестов: забыть отказы синтеза. */
export function resetFailedClips(): void {
  failedClips.clear();
}

/**
 * Озвучить кусок или взять уже озвученный.
 *
 * Ключ переиспользования — текст + язык + голос: сменили голос, и прежние куски не
 * подходят, иначе фраза заговорила бы двумя голосами разом.
 */
async function ensureClip(
  text: string,
  language: WhisperLanguage,
  voice: string
): Promise<{ fileName: string; durationMs: number; synthesized: boolean }> {
  const existing = await prisma.whisperClip.findUnique({
    where: { text_language_voice: { text, language, voice } },
  });
  if (existing && fs.existsSync(whisperFilePath(existing.fileName, "wav"))) {
    // Отметка «пригодился» двигает срок жизни куска, но пишется без ожидания:
    // задерживать из-за неё сборку фразы незачем.
    void prisma.whisperClip.update({ where: { id: existing.id }, data: { usedAt: new Date() } }).catch(() => {});
    return { fileName: existing.fileName, durationMs: existing.durationMs, synthesized: false };
  }

  // Отказ на этом куске ещё свеж — в сеть не идём (см. FAILED_CLIP_RETRY_MS).
  if (clipOnCooldown(text, language, voice)) {
    throw new WhisperAudioError(`Синтез речи уже отказался читать кусок «${text}» — ждём до следующей попытки`);
  }
  // Квота выжжена — молчание синтеза не про этот текст, и запоминать его как отказ
  // куска нельзя: иначе после восстановления квоты полбазы осталось бы немой.
  if (await ttsQuotaPausedUntil(WHISPER_TTS_MODEL)) {
    throw new WhisperQuotaPausedError("Озвучка на паузе: суточная квота синтеза исчерпана");
  }

  const speech = await synthesizeSpeech(stylePrompt(language) + text, { voice, models: GEMINI_WHISPER_TTS_MODELS });
  const pcm = speech ? Buffer.from(speech.audioBase64, "base64") : Buffer.alloc(0);
  if (!speech || pcm.length === 0) {
    // Пауза могла включиться ровно этим вызовом — тогда виновата квота, а не текст.
    if (await ttsQuotaPausedUntil(WHISPER_TTS_MODEL)) {
      throw new WhisperQuotaPausedError("Озвучка на паузе: суточная квота синтеза исчерпана");
    }
    failedClips.set(clipKey(text, language, voice), Date.now() + FAILED_CLIP_RETRY_MS);
    throw new WhisperAudioError(`Синтез речи не вернул звук для куска «${text}»`);
  }

  const fileName = existing?.fileName ?? newClipName();
  await transcodeWhisper(pcm, whisperFilePath(fileName, "wav"), { leadSilenceMs: 0 });
  const durationMs = Math.round((pcm.length / 2 / speech.sampleRateHz) * 1000);

  await prisma.whisperClip.upsert({
    where: { text_language_voice: { text, language, voice } },
    create: { text, language, voice, fileName, durationMs },
    update: { fileName, durationMs, usedAt: new Date() },
  });
  return { fileName, durationMs, synthesized: true };
}

/**
 * Склеить готовые куски в один файл станции.
 *
 * Через `concat` демультиплексор ffmpeg: все куски уже в одном формате (8 кГц моно),
 * поэтому склейка идёт без перекодирования — это копирование байтов, а не обработка
 * звука. Пауза между кусками добавляется отдельным фильтром тишины.
 */
function concatClips(inputs: string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // adelay каждому куску, кроме первого, даёт ровные паузы; concat склеивает.
    const filter =
      inputs
        .map((_, i) => (i === 0 ? `[0:a]anull[a0]` : `[${i}:a]adelay=${GAP_MS}:all=1[a${i}]`))
        .join(";") +
      ";" +
      inputs.map((_, i) => `[a${i}]`).join("") +
      `concat=n=${inputs.length}:v=0:a=1[out]`;

    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      ...inputs.flatMap((file) => ["-i", file]),
      "-filter_complex", filter,
      "-map", "[out]",
      "-ar", "8000", "-ac", "1", "-acodec", "pcm_s16le", "-f", "wav",
      outPath,
    ];

    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const errOut: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      reject(new WhisperAudioError("Склейка не уложилась в 30 секунд"));
    }, 30_000);

    ffmpeg.stderr.on("data", (chunk: Buffer) => errOut.push(chunk));
    ffmpeg.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WhisperAudioError(`ffmpeg недоступен: ${err.message}`));
    });
    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new WhisperAudioError(Buffer.concat(errOut).toString("utf8").trim().slice(0, 300) || `ffmpeg код ${code}`));
    });
  });
}

export interface AssembledWhisper {
  durationMs: number;
  /** Сколько кусков пришлось синтезировать заново — видно, во что обошлась сборка. */
  synthesized: number;
  /**
   * Сколько кусков пришлось выбросить из фразы: синтез на них молчит. Подсказка
   * собрана из остальных и уже годится к работе, но она НЕПОЛНАЯ — вызывающий по
   * этому счётчику решает, пробовать ли собрать её заново позже.
   */
  skipped: number;
}

/**
 * Собрать файл подсказки из частей фразы.
 *
 * `parts` — уже готовые смысловые куски («Фаррух», «харидор», «манзил дар Сомонӣ»).
 * Каждый озвучивается один раз на язык и голос, дальше только склейка.
 */
export async function assembleWhisper(
  parts: string[],
  options: { language: WhisperLanguage; voice: string; fileName: string }
): Promise<AssembledWhisper> {
  // Неозвучиваемое (ник, логин, одни значки) отсекаем ДО сети — см. isSpeakablePiece.
  // Фраза приходит уже отфильтрованной из buildWhisperText, но кусками пользуются и
  // другие вызывающие, а лишний запрос из суточной квоты стоит дороже одной проверки.
  const pieces = parts.map((part) => part.trim()).filter((part) => part && isSpeakablePiece(part));
  if (pieces.length === 0) throw new WhisperAudioError("Нечего склеивать: пустой список кусков");

  await fs.promises.mkdir(whisperDir, { recursive: true });

  let synthesized = 0;
  let skipped = 0;
  const clips: { fileName: string; durationMs: number }[] = [];
  for (const piece of pieces) {
    try {
      const clip = await ensureClip(piece, options.language, options.voice);
      if (clip.synthesized) synthesized++;
      clips.push(clip);
    } catch (err) {
      /**
       * ОТКАЗ ОДНОГО КУСКА НЕ ТЕРЯЕТ ПОДСКАЗКУ ЦЕЛИКОМ (22.08.2026). До этого любой
       * молчаливый кусок ронял сборку, и агент не слышал НИЧЕГО — ни имени, ни роли,
       * хотя они были озвучены и лежали на диске. Лучше «харидор. манзил дар Сомонӣ»
       * без имени, чем тишина: агент хотя бы знает, с чем к нему идут.
       *
       * Пауза по квоте — исключение: это не про кусок, а про всю озвучку, и собирать
       * из огрызков всю базу подряд нельзя. Такой отказ уходит наверх целиком.
       */
      if (err instanceof WhisperQuotaPausedError) throw err;
      if (!(err instanceof WhisperAudioError)) throw err;
      skipped++;
    }
  }
  if (clips.length === 0) {
    throw new WhisperAudioError(`Синтез речи не вернул звук ни для одного куска фразы (${pieces.length} шт.)`);
  }

  const target = whisperFilePath(options.fileName, "wav");
  if (clips.length === 1) {
    // Один кусок — склеивать нечего, но копия всё равно нужна: файл подсказки живёт
    // своей жизнью и удаляется вместе с клиентом, а кусок переиспользуется другими.
    await fs.promises.copyFile(whisperFilePath(clips[0]!.fileName, "wav"), target);
  } else {
    await concatClips(
      clips.map((clip) => whisperFilePath(clip.fileName, "wav")),
      target
    );
  }

  const durationMs = clips.reduce((sum, clip) => sum + clip.durationMs, 0) + GAP_MS * (clips.length - 1);
  return { durationMs, synthesized, skipped };
}

/**
 * Убрать куски, которые давно никому не пригодились. Файлы подсказок это не трогает —
 * у них своя уборка (whisperSync.ts), а кусок может пережить клиента и достаться
 * следующему с тем же именем.
 */
export async function pruneWhisperClips(now: Date = new Date()): Promise<number> {
  const deadline = new Date(now.getTime() - CLIP_TTL_DAYS * 24 * 3600 * 1000);
  const stale = await prisma.whisperClip.findMany({
    where: { usedAt: { lt: deadline } },
    select: { id: true, fileName: true },
    take: 200,
  });
  if (stale.length === 0) return 0;

  await Promise.all(
    stale.map((clip) => fs.promises.rm(whisperFilePath(clip.fileName, "wav"), { force: true }))
  );
  await prisma.whisperClip.deleteMany({ where: { id: { in: stale.map((clip) => clip.id) } } });
  return stale.length;
}
