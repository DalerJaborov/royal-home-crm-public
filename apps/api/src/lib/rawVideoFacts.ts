import { tryRunFfmpeg } from "./ffmpeg.js";

/**
 * ФАКТЫ СЫРОГО ВИДЕО — звук/длительность/размеры/кодек (23.09.2026, задание C,
 * аудит «звонок → лид → агент»). Объект №127: исходник IMG_8361.mov с iPhone
 * (3840×2160, rotation=-90) был БЕЗ аудиопотока уже при загрузке агентом — и
 * этого не увидел никто: ни агент в мастере, ни модератор (одобрил видео), ни
 * монтажёр (в подписи к файлу фактов не было). Плеер в CRM (`<video src>`)
 * молчит, если браузер не умеет HEVC (Firefox, часть Chrome/Android) —
 * «видео не открывается», причина не видна никому. probeRawVideoFacts даёт
 * то, что можно проверить один раз ffprobe'ом и показать честно везде, где
 * ролик всплывает — карточке модератора, монтажёру, экрану объекта.
 *
 * Отдельно от probeVideoDimensions/probeDurationSec (lib/ffmpeg.ts): тем двум
 * достаточно видеопотока, а здесь ещё и codec_type=audio (есть ли звук вообще)
 * и rotation — их проще получить одним вызовом ffprobe с `-of json`, чем
 * добавлять аудио/поворот в уже устоявшиеся функции с другими вызывающими.
 */

export interface RawVideoFacts {
  /** false — видеопоток есть, аудиопотока нет вовсе (не «тихая дорожка», а
   *  ОТСУТСТВИЕ потока). true — есть хотя бы один аудиопоток. */
  hasAudio: boolean;
  durationSec: number | null;
  /** Экранные (после поворота, если rotation в метаданных ±90/270). */
  width: number | null;
  height: number | null;
  /** Имя кодека верхним регистром (HEVC, H264) — как коротко печатают монтажёру. */
  videoCodec: string | null;
}

interface FfprobeSideData {
  side_data_type?: string;
  rotation?: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  side_data_list?: FfprobeSideData[];
  tags?: { rotate?: string };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

/**
 * Один вызов ffprobe, `-of json`. Никогда не бросает — null означает «ffprobe
 * недоступен, файл битый, или в нём вовсе нет видеопотока»; вызывающий код
 * (routes/properties/videos.ts) оставляет поля PropertyVideo пустыми и пишет
 * причину в lib/systemError.ts, ответ агенту это не задерживает и не портит.
 */
export async function probeRawVideoFacts(inputPath: string, timeoutMs = 20_000): Promise<RawVideoFacts | null> {
  const result = await tryRunFfmpeg({
    bin: "ffprobe",
    label: "факты сырого видео",
    timeoutMs,
    captureStdout: true,
    args: [
      "-v", "error",
      "-of", "json",
      "-show_entries",
      "stream=codec_type,codec_name,width,height:stream_side_data=rotation:stream_tags=rotate:format=duration",
      inputPath,
    ],
  });
  if (!result) return null;

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch {
    return null;
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  if (!videoStream) return null; // не видеофайл или ffprobe ничего не разобрал

  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const videoCodec = videoStream.codec_name ? videoStream.codec_name.toUpperCase() : null;

  let width = typeof videoStream.width === "number" ? videoStream.width : null;
  let height = typeof videoStream.height === "number" ? videoStream.height : null;

  // Поворот — из side_data (Display Matrix, современные iPhone) либо из старого
  // тега rotate. |90|/|270| переставляют экранные ширину/высоту местами: iPhone
  // почти всегда снимает вертикально, но контейнер хранит кадр горизонтальным
  // с флагом поворота — без учёта rotation в базе легла бы «альбомная» карточка
  // для вертикального ролика.
  const sideDataRotation = videoStream.side_data_list?.find((sd) => sd.side_data_type === "Display Matrix")?.rotation;
  const tagRotation = videoStream.tags?.rotate ? Number.parseInt(videoStream.tags.rotate, 10) : null;
  const rotation = typeof sideDataRotation === "number" ? sideDataRotation : Number.isFinite(tagRotation) ? tagRotation : null;
  if (rotation != null && Math.abs(rotation) % 180 === 90 && width != null && height != null) {
    [width, height] = [height, width];
  }

  const durationRaw = Number.parseFloat(parsed.format?.duration ?? "");
  const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;

  return { hasAudio, durationSec, width, height, videoCodec };
}

/** «1:20» — минуты:секунды, без часов (сырые ролики агента — 20-50 сек, см.
 *  комментарий модели PropertyVideo). Часы не нужны ни одному ролику этого
 *  конвейера, а появятся — округлятся в минуты, что для факта в подписи
 *  достаточно честно. */
export function formatDurationShort(sec: number): string {
  const total = Math.round(sec);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * «1:20 · 2160×3840 · HEVC · ⚠ БЕЗ ЗВУКА» — одна строка фактов, общая для
 * карточки модератора (telegramModeration.ts), подписи монтажёру
 * (videoHandoff.ts) и чипов на экране объекта (PropertyVideoManager.tsx).
 * Пустые поля пропускаются молча — на старых записях (до 23.09.2026, пока
 * фактов не было) строка была бы пустой либо укороченной, а не «null· null».
 */
export function describeRawVideo(v: {
  hasAudio?: boolean | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
}): string {
  const parts: string[] = [];
  if (v.durationSec != null) parts.push(formatDurationShort(v.durationSec));
  if (v.width != null && v.height != null) parts.push(`${v.width}×${v.height}`);
  if (v.videoCodec) parts.push(v.videoCodec);
  if (v.hasAudio === false) parts.push("⚠ БЕЗ ЗВУКА");
  return parts.join(" · ");
}
