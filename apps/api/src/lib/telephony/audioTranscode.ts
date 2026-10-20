import { spawn } from "node:child_process";

/**
 * ЗВУК ДЛЯ АСТЕРИСКА — 8 кГц, моно, 16-бит PCM WAV.
 *
 * Разбор 15.08.2026: владелец загрузил свою музыку ожидания и приветствие
 * автоответчика ещё 13-14.08, а станция продолжала играть штатную мелодию
 * FreePBX. Причина нашлась в том, чего в CRM не было вовсе: загруженный файл
 * писался на диск байт-в-байт, каким его прислал браузер (обычно 44.1/48 кГц
 * стерео mp3 — то, что выдаёт любой телефон или экспорт из WhatsApp). Штатный
 * формат MOH/автоответчика Asterisk — 8 кГц моно; на другом семпл-рейте станция
 * либо не грузит файл вовсе, либо проигрывает его с искажённой скоростью, и
 * внешне это выглядит как «файл не применился».
 *
 * Поэтому теперь ЛЮБАЯ загрузка приводится к одному каноничному формату здесь,
 * на сервере CRM, а не полагается на то, что владелец сам будет знать про 8 кГц.
 * Формат на выходе всегда `.wav` — станции больше не нужно различать mp3/wav.
 */
const SAMPLE_RATE = 8000;
const TIMEOUT_MS = 30_000;

export class AudioTranscodeError extends Error {}

export function transcodeForAsterisk(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ar", String(SAMPLE_RATE), "-ac", "1", "-acodec", "pcm_s16le", "-f", "wav", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      reject(new AudioTranscodeError("Обработка звука не уложилась в 30 секунд"));
    }, TIMEOUT_MS);

    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => errOut.push(chunk));

    ffmpeg.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT — ffmpeg не установлен в образе; отличаем от «файл битый», чтобы
      // в журнале ошибок это читалось как поломка инфраструктуры, а не звонка.
      reject(new AudioTranscodeError(`ffmpeg недоступен: ${err.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(errOut).toString("utf8").trim().slice(0, 500);
        reject(new AudioTranscodeError(detail || `ffmpeg завершился с кодом ${code} — файл не похож на аудио`));
        return;
      }
      const buffer = Buffer.concat(out);
      if (buffer.length === 0) {
        reject(new AudioTranscodeError("На выходе пустой файл — исходный, вероятно, повреждён"));
        return;
      }
      resolve(buffer);
    });

    ffmpeg.stdin.on("error", () => {
      // EPIPE, если ffmpeg уже упал и закрыл stdin — обработку завершит событие
      // "close" выше, здесь важно не дать необработанному исключению уронить процесс.
    });
    ffmpeg.stdin.write(input);
    ffmpeg.stdin.end();
  });
}
