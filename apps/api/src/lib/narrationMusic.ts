import { NARRATION_LOUDNESS } from "./narrationLoudness.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NARRATION_MUSIC_LIMITS, narrationOwnMusicRemix, type NarrationConfig, type NarrationMusicFormat } from "@royal-home/shared";
import { prisma } from "../db.js";
import { probeMediaInfo, runFfmpeg } from "./ffmpeg.js";
import { localVideoDelete, localVideoFilePath } from "./localVideoStorage.js";

/**
 * СВОЯ МУЗЫКА ДЛЯ ПЕРЕМОНТАЖА (18.11.2026, решение владельца после отказа от машинного отделения голоса:
 * «музыку я найду специальную… без авторских прав. Ими будут пользоваться все, и монтажёр, и ты»).
 *
 * Библиотека треков (модель NarrationMusicTrack, файлы — в закрытом хранилище роликов под одной папкой
 * NARRATION_MUSIC_FOLDER). Перемонтаж вышедшего ролика без ролика без голоса (lib/narrationAutoFlow.ts →
 * remixFromMasterClaimed, режим MUSIC): со старого ролика снимается ВЕСЬ звук, кладётся случайный трек
 * (не тот же, что в прошлый раз у объекта) — это «ролик без голоса», дальше та же дверь сведения
 * lib/narrationMix.ts (подгонка длины, приглушение музыки под голосом). Здесь только библиотека и
 * музыкальная подложка; решения о публикации и замке — в потоке озвучки.
 */

/** Папка треков в закрытом хранилище (ключ «uuid/uuid.ext», lib/localVideoStorage.ts). Объекта с таким id нет. */
export const NARRATION_MUSIC_FOLDER = "00000000-0000-4000-8000-00000000a0d1";
export function narrationMusicKey(trackId: string, format: NarrationMusicFormat): string {
  return `${NARRATION_MUSIC_FOLDER}/${trackId}.${format}`;
}

/**
 * Тип файла по СОДЕРЖИМОМУ, а не по имени (18.11.2026): mp3 — тег ID3 или кадр MPEG (11 единичных бит синхро),
 * m4a — контейнер ISO (`ftyp` на 4-м байте). Иначе null. Окончательно звук проверяет ffprobe (probeMusicFile).
 */
export function sniffMusicFormat(head: Uint8Array): NarrationMusicFormat | null {
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return "mp3";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "mp3";
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "m4a";
  return null;
}

export type MusicProbe = { ok: true; durationSec: number } | { ok: false; error: string };
/** Звук читается (mp3 или aac), длина в пределах. Обложка внутри mp3 (поток картинки) не мешает. */
export async function probeMusicFile(filePath: string, format: NarrationMusicFormat): Promise<MusicProbe> {
  const info = await probeMediaInfo(filePath);
  if (!info?.hasAudio) return { ok: false, error: "В файле нет звука, который CRM может прочитать." };
  const codecOk = format === "mp3" ? info.audioCodec === "mp3" : info.audioCodec === "aac";
  if (!codecOk) return { ok: false, error: format === "mp3" ? "Файл называется mp3, но звук в нём другого вида." : "В файле m4a звук не AAC — пересохраните его в mp3." };
  const sec = info.durationSec;
  if (!(sec >= NARRATION_MUSIC_LIMITS.minSec)) return { ok: false, error: `Трек короче ${NARRATION_MUSIC_LIMITS.minSec} секунд.` };
  if (sec > NARRATION_MUSIC_LIMITS.maxSec) return { ok: false, error: `Трек длиннее ${NARRATION_MUSIC_LIMITS.maxSec / 60} минут.` };
  return { ok: true, durationSec: Math.round(sec * 10) / 10 };
}

export type AddTrackResult = { ok: true; id: string } | { ok: false; status: 400 | 413; error: string };
/** Новый трек: тип по содержимому → во временный файл → ffprobe → в хранилище → запись. */
export async function addNarrationMusicTrack(input: { buffer: Buffer; title: string; createdById: string }): Promise<AddTrackResult> {
  if (input.buffer.length > NARRATION_MUSIC_LIMITS.maxBytes) return { ok: false, status: 413, error: `Файл больше ${NARRATION_MUSIC_LIMITS.maxBytes / 1024 / 1024} МБ.` };
  const format = sniffMusicFormat(input.buffer.subarray(0, 16));
  if (!format) return { ok: false, status: 400, error: "Это не mp3 и не m4a. Загрузите трек в одном из этих форматов." };
  const id = randomUUID();
  const key = narrationMusicKey(id, format);
  const dest = localVideoFilePath(key);
  if (!dest) return { ok: false, status: 400, error: "Некорректный ключ трека." };
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, input.buffer);
  const probed = await probeMusicFile(dest, format);
  if (!probed.ok) {
    await fs.promises.rm(dest, { force: true }).catch(() => {});
    return { ok: false, status: 400, error: probed.error };
  }
  try {
    await prisma.narrationMusicTrack.create({ data: { id, title: input.title, storageKey: key, format, durationSec: probed.durationSec, sizeBytes: input.buffer.length, createdById: input.createdById } });
  } catch (err) {
    await fs.promises.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
  return { ok: true, id };
}

/** Удалить трек: запись, затем файл. Ролики, уже сведённые с ним, не меняются (трек в них вшит). */
export async function deleteNarrationMusicTrack(id: string): Promise<boolean> {
  const row = await prisma.narrationMusicTrack.findUnique({ where: { id }, select: { storageKey: true } });
  if (!row) return false;
  await prisma.narrationMusicTrack.delete({ where: { id } });
  await localVideoDelete(row.storageKey).catch(() => false);
  return true;
}

export async function narrationMusicTracks() {
  return prisma.narrationMusicTrack.findMany({ orderBy: { createdAt: "asc" }, take: NARRATION_MUSIC_LIMITS.maxTracks });
}

/** Включено ли «своя музыка при перемонтаже» и есть ли что класть (рубильник ВЫКЛ или библиотека пуста — монтажёру). */
export async function ownMusicReady(config: Pick<NarrationConfig, "ownMusicRemix">): Promise<boolean> {
  if (!narrationOwnMusicRemix(config)) return false;
  return (await prisma.narrationMusicTrack.count()) > 0;
}

/**
 * Случайный трек, не тот же, что в прошлый раз у этого объекта (если в библиотеке их больше одного).
 * random — для тестов.
 */
export function pickMusicTrackId(ids: readonly string[], lastId: string | null, random: () => number = Math.random): string | null {
  if (!ids.length) return null;
  const pool = ids.length > 1 && lastId ? ids.filter((id) => id !== lastId) : [...ids];
  const list = pool.length ? pool : [...ids];
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
}

/** Трек к перемонтажу объекта: случайный, файл на месте. null — класть нечего. */
export async function chooseMusicTrack(lastId: string | null, random: () => number = Math.random): Promise<{ id: string; path: string; title: string } | null> {
  const tracks = (await narrationMusicTracks()).flatMap((t) => {
    const p = localVideoFilePath(t.storageKey);
    return p && fs.existsSync(p) ? [{ id: t.id, path: p, title: t.title }] : [];
  });
  const id = pickMusicTrackId(tracks.map((t) => t.id), lastId, random);
  return tracks.find((t) => t.id === id) ?? null;
}

/**
 * Музыкальная подложка (18.11.2026) — «ролик без голоса» из вышедшего ролика: картинка копией (-c:v copy;
 * не копируется — один повтор с перекодированием), звук ролика НЕ берётся вовсе (в карту идёт только 0:v:0),
 * звук — трек: зациклен (-stream_loop -1, короче ролика), обрезан по длине ролика, громкость выровнена
 * (loudnorm −18 LUFS: тогда приглушение под голосом в lib/narrationMix.ts работает одинаково для тихого и
 * громкого трека), затухание в конце MUSIC_FADE_SEC.
 */
// 21.11.2026: −18 → −16 LUFS вместе с голосом (lib/narrationLoudness.ts), разница с голосом прежняя.
export const MUSIC_BED = { loudness: NARRATION_LOUDNESS.music, fadeSec: 1.5 } as const;
export function musicBedFilter(durationSec: number): string {
  const fade = Math.min(MUSIC_BED.fadeSec, Math.max(0.2, durationSec / 4));
  const start = Math.max(0, durationSec - fade);
  return `[1:a]atrim=0:${durationSec.toFixed(3)},asetpts=N/SR/TB,${MUSIC_BED.loudness},aformat=sample_rates=48000:channel_layouts=stereo,afade=t=out:st=${start.toFixed(3)}:d=${fade.toFixed(3)}[music]`;
}

/**
 * ЧИСТАЯ КАРТИНКА — ОСНОВА ВСЕХ ПЕРЕМОНТАЖЕЙ СВОЕЙ МУЗЫКОЙ (ревью 18.11). Первый перемонтаж сохраняет картинку
 * ролика монтажёра (без звука, копией) мастером с отметкой MUSIC_BASE; каждый следующий строит ролик из неё,
 * а не из прошлого результата CRM. Иначе плашка с ценой и субтитры ложились бы поверх прежних, а файл
 * монтажёра пропадал бы после первой подмены.
 */
export const MUSIC_BASE_SOURCE = "MUSIC_BASE";
export async function buildPictureBase(input: { clipPath: string; outPath: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runFfmpeg({ args: ["-y", "-hide_banner", "-loglevel", "error", "-i", input.clipPath, "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", input.outPath],
      timeoutMs: 120_000, label: "чистая картинка ролика" });
  } catch (err) {
    await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
    return { ok: false, error: `ffmpeg не смог сохранить картинку ролика: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` };
  }
  const info = await probeMediaInfo(input.outPath);
  if (!info?.hasVideo) return { ok: false, error: "Картинка ролика не читается как видео." };
  return { ok: true };
}

export type MusicBedResult = { ok: true; durationSec: number } | { ok: false; error: string };
export async function buildMusicBed(input: { clipPath: string; trackPath: string; outPath: string }): Promise<MusicBedResult> {
  const clip = await probeMediaInfo(input.clipPath);
  if (!clip?.hasVideo || !(clip.durationSec > 0)) return { ok: false, error: "Вышедший ролик не читается как видео." };
  const d = clip.durationSec;
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-i", input.clipPath, "-stream_loop", "-1", "-i", input.trackPath,
    "-filter_complex", musicBedFilter(d), "-map", "0:v:0", "-map", "[music]"];
  const tail = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", d.toFixed(3), "-movflags", "+faststart", input.outPath];
  try {
    await runFfmpeg({ args: [...base, "-c:v", "copy", ...tail], timeoutMs: 120_000, label: "музыка под ролик" });
  } catch {
    await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
    try {
      await runFfmpeg({ args: [...base, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", ...tail], timeoutMs: 420_000, label: "музыка под ролик" });
    } catch (err) {
      await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
      return { ok: false, error: `ffmpeg не смог положить музыку под ролик: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` };
    }
  }
  const out = await probeMediaInfo(input.outPath);
  if (!out?.hasVideo || !out.hasAudio) {
    await fs.promises.rm(input.outPath, { force: true }).catch(() => {});
    return { ok: false, error: "После замены музыки в ролике нет картинки или звука." };
  }
  return { ok: true, durationSec: out.durationSec };
}

