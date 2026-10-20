import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { synthesizeSpeech } from "../../ai/tts.js";
import { GEMINI_WHISPER_TTS_MODELS } from "../../ai/geminiTransport.js";
import type { WhisperLanguage } from "./whisperText.js";

/**
 * ОЗВУЧКА ПОДСКАЗКИ И ФАЙЛЫ НА ДИСКЕ.
 *
 * ГДЕ ЛЕЖАТ ФАЙЛЫ И ПОЧЕМУ НЕ В uploads. Музыка ожидания и приветствие автоответчика
 * живут в `uploads/telephony/` и раздаются `express.static("/uploads")` — то есть любым
 * человеком в интернете без всякого входа. Для мелодии это безобидно, а здесь звучат
 * ИМЕНА КЛИЕНТОВ агентства. Поэтому подсказки лежат в отдельном каталоге вне статики,
 * и станция забирает их по секрету (routes/telephonyWhisper.ts).
 *
 * ОДИН ФОРМАТ — 8 кГц. Широкую полосу (G.722, 16 кГц) умеет только SIP-трубка в офисе, а
 * у агентства их нет и не планируется (владелец 20.08.2026): звонок агенту всегда уходит
 * на мобильный через транк, то есть в обычный телефонный канал 8 кГц. Класть вторую,
 * широкополосную версию файла означало бы занимать место на диске АТС ради формата,
 * который на этом маршруте не выберется никогда.
 *
 * ГРОМКОСТЬ ВЫРАВНИВАЕТСЯ (замечание владельца 20.08.2026 по живым образцам: студийный
 * файл звучит заметно громче телефонного). Сжатие до 8 кГц срезает верх и субъективно
 * «отнимает» громкость; `loudnorm` возвращает уровень, иначе подсказку приходилось бы
 * вслушивать — а вслушиваться агенту некогда, он в этот момент здоровается.
 *
 * ПОЛСЕКУНДЫ ТИШИНЫ В НАЧАЛЕ. На мобильном плече станция узнаёт об ответе от оператора
 * связи, и «снял трубку» приходит раньше, чем человек реально поднёс телефон к уху.
 * Без паузы срезается первое слово — то есть ровно имя клиента, самая важная часть
 * фразы. Дешевле дать полсекунды тишины, чем потерять имя.
 */

/**
 * Модель синтеза для подсказки. ОТДЕЛЬНАЯ ОТ ОБЩЕЙ НАМЕРЕННО: проверено живыми
 * запросами 20.08.2026 — `gemini-2.5-flash-preview-tts` (модель озвучки ассистента)
 * на таджикский текст отвечает `finishReason: OTHER` и не отдаёт ни байта звука.
 * Русский читает нормально, поэтому поломка молчаливая и заметна только на таджикском.
 *
 * ИМЯ НЕ ВЫДУМЫВАТЬ — сверять на ai.google.dev/gemini-api/docs/models. Модель в статусе
 * preview: если Google её закроет, УЖЕ ОЗВУЧЕННЫЕ файлы продолжат работать (они лежат
 * на станции), перестанут появляться только новые.
 *
 * С 11.09.2026 (пачка 7) закрытие модели больше не молчаливое: имя и резервная
 * цепочка живут в ai/geminiTransport.ts (GEMINI_WHISPER_TTS_MODELS), а synthesizeSpeech
 * (ai/tts.ts) на 404 сама переключается на следующую модель цепочки и пишет в журнал
 * ошибок не чаще раза в час. WHISPER_TTS_MODEL здесь — первая (основная) модель
 * цепочки, для проверки паузы по квоте ДО вызова (whisperClips.ts, whisperSync.ts).
 */
export const WHISPER_TTS_MODEL = GEMINI_WHISPER_TTS_MODELS[0];

/**
 * Указание модели, на каком языке и каким тоном читать. Владелец выбрал этот вариант
 * из пяти живых образцов 20.08.2026: с прямым указанием языка таджикское произношение
 * заметно чище, чем когда модель угадывает язык по кириллице сама.
 */
const STYLE_PROMPT: Record<WhisperLanguage, string> = {
  tg: "Прочитай быстро, спокойно и деловито, как диктор, на таджикском языке: ",
  ru: "Прочитай быстро, спокойно и деловито, как диктор: ",
};

/** Каталог с озвученными подсказками — вне `uploads`, см. шапку файла. */
export const whisperDir = path.resolve(process.env.WHISPER_AUDIO_DIR ?? "./data/whisper");

/** Единственный формат станции: 8 кГц моно WAV — см. шапку файла. */
export const WHISPER_FORMATS = ["wav"] as const;

/** Тишина перед первым словом, миллисекунды. См. шапку файла. */
const LEAD_SILENCE_MS = 500;

export class WhisperAudioError extends Error {}

/**
 * Синтез молчит не из-за текста, а потому что квота выжжена и озвучка на паузе
 * (см. ttsQuotaPausedUntil в ai/tts.ts).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ТИП. До 22.08.2026 оба случая приходили одной ошибкой «Синтез речи
 * не вернул звук для куска «Абдулло»», и журнал прода за двое суток набрал сотни таких
 * записей на нормальных таджикских именах: пауза включалась в середине прохода крона, а
 * оставшиеся девятнадцать карточек продолжали «озвучиваться» и падать. Владелец читал
 * это как «модель не умеет читать имя Абдулло», хотя дело было в квоте. Теперь пауза —
 * это отдельный исход: проход тихо останавливается, в журнал уходит ОДНА запись из
 * ai/tts.ts про квоту, и ни одной про имена.
 */
export class WhisperQuotaPausedError extends WhisperAudioError {}

export function whisperFilePath(fileName: string, format: (typeof WHISPER_FORMATS)[number]): string {
  // Имя файла приходит из базы, но путь всё равно собираем через basename: строка с
  // «../» в имени вывела бы запись за пределы каталога.
  return path.join(whisperDir, `${path.basename(fileName)}.${format}`);
}

/** Указание модели про язык и тон — одно на всю озвучку: и на целые фразы, и на
 *  отдельные куски (whisperClips.ts). Разъедься они, и склейка заговорила бы двумя
 *  разными манерами в одной фразе. */
export function stylePrompt(language: WhisperLanguage): string {
  return STYLE_PROMPT[language];
}

/**
 * Привести сырой PCM синтеза к формату станции. Публичная обёртка над transcode для
 * склейки: куски пишутся БЕЗ вступительной тишины (leadSilenceMs: 0) — пауза нужна
 * один раз в начале готовой фразы, а не перед каждым словом.
 */
export function transcodeWhisper(
  pcm: Buffer,
  outPath: string,
  options: { leadSilenceMs: number }
): Promise<void> {
  return transcode(pcm, ["-ar", "8000", "-ac", "1", "-acodec", "pcm_s16le", "-f", "wav"], outPath, options.leadSilenceMs);
}

/**
 * Перекодировать сырой PCM от Gemini (24 кГц, моно, 16 бит) в формат станции.
 *
 * `loudnorm` — однопроходная нормализация громкости к вещательному уровню; для фразы
 * в три секунды двухпроходный вариант точнее, но требует прогонять файл дважды ради
 * разницы, которой в телефонном канале не слышно.
 */
function transcode(pcm: Buffer, args: string[], outPath: string, leadSilenceMs = LEAD_SILENCE_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
        "-af",
        leadSilenceMs > 0
          ? `loudnorm=I=-16:TP=-1.5:LRA=11,adelay=${leadSilenceMs}:all=1`
          : "loudnorm=I=-16:TP=-1.5:LRA=11",
        ...args,
        outPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    );

    const errOut: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      reject(new WhisperAudioError("Перекодировка не уложилась в 30 секунд"));
    }, 30_000);

    ffmpeg.stderr.on("data", (chunk: Buffer) => errOut.push(chunk));

    ffmpeg.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT — ffmpeg не установлен в образе: это поломка инфраструктуры, а не звонка.
      reject(new WhisperAudioError(`ffmpeg недоступен: ${err.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = Buffer.concat(errOut).toString("utf8").trim().slice(0, 300);
      reject(new WhisperAudioError(detail || `ffmpeg завершился с кодом ${code}`));
    });

    ffmpeg.stdin.on("error", () => {
      // EPIPE, когда ffmpeg уже упал и закрыл вход: исход обработает событие "close".
    });
    ffmpeg.stdin.write(pcm);
    ffmpeg.stdin.end();
  });
}

/**
 * Озвучить фразу для прослушивания в браузере — без записи на диск.
 *
 * Тем же голосом, той же моделью и с тем же указанием языка, что и настоящая подсказка:
 * иначе кнопка «Прослушать» показывала бы одно, а агент слышал бы другое. Отличие ровно
 * одно — телефонного сжатия нет: в браузере оно только мешает расслышать произношение,
 * а как звучит фраза в трубке, слышно на самом звонке.
 */
export async function previewWhisperSpeech(
  text: string,
  language: WhisperLanguage,
  voice: string
): Promise<{ audioBase64: string; sampleRateHz: number } | null> {
  return synthesizeSpeech(STYLE_PROMPT[language] + text, { voice, models: GEMINI_WHISPER_TTS_MODELS });
}

/** Убрать файлы подсказки с диска CRM. Отсутствие файла — не ошибка: станция могла
 *  забрать его раньше, а строку в базе мы удаляем в любом случае. */
export async function removeWhisperFiles(fileName: string): Promise<void> {
  await Promise.all(
    WHISPER_FORMATS.map((format) => fs.promises.rm(whisperFilePath(fileName, format), { force: true }))
  );
}

/** Есть ли файлы подсказки на диске — проверка целостности: строка в базе без файла
 *  означает, что станции нечего забирать, и подсказку нужно переозвучить. */
export async function whisperFilesExist(fileName: string): Promise<boolean> {
  const checks = await Promise.all(
    WHISPER_FORMATS.map((format) =>
      fs.promises
        .stat(whisperFilePath(fileName, format))
        .then((stat) => stat.size > 0)
        .catch(() => false)
    )
  );
  return checks.every(Boolean);
}
