import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * ИЗМЕНЯЕМЫЙ ТЕКСТ НА РОЛИКЕ (18.11.2026): плашка с ценой и субтитры рисует CRM при сборке.
 * Чистые функции — без ffmpeg; сведение — настоящий ffmpeg на коротком сгенерированном ролике 9:16.
 */
const FF = process.env.FFMPEG_BIN || "ffmpeg";
const ffmpegReady = spawnSync(FF, ["-version"], { stdio: "ignore" }).status === 0
  && /drawtext/u.test(spawnSync(FF, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout ?? "");

const { splitSubtitlePhrases, subtitleCues, wrapSubtitle, ffFilterPath, OVERLAY_FONTS } = await import("../src/lib/video/narrationOverlay.js");
const { mixNarrationOntoMaster } = await import("../src/lib/narrationMix.js");
const { probeMediaInfo } = await import("../src/lib/ffmpeg.js");
const { narrationTextOverlay } = await import("@royal-home/shared");

const tmp = path.join(os.tmpdir(), `narration-overlay-${Date.now()}`);
const script = "Хонаи сеҳуҷрагӣ дар Сино барои фурӯш. Масоҳаташ ҳаштоду шаш метри мураббаъ. Нархаш ҳаштоду панҷ ҳазор доллар. Занг занед.";

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true });
  if (!ffmpegReady) return;
  const ff = (args: string[]) => { if (spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "ignore" }).status !== 0) throw new Error(args.join(" ")); };
  ff(["-f", "lavfi", "-i", "color=c=0x445566:size=360x640:rate=25:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(tmp, "master.mp4")]);
  ff(["-f", "lavfi", "-i", "sine=frequency=700:duration=4", "-c:a", "libmp3lame", path.join(tmp, "voice.mp3")]);
}, 60_000);
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe("текст на ролике: фразы и время", () => {
  it("рубильник по умолчанию выключен", () => {
    expect(narrationTextOverlay({})).toBe(false);
    expect(narrationTextOverlay({ textOverlay: true })).toBe(true);
  });
  it("фразы по знакам, не длиннее двух строк; короткий хвост приклеен; перенос по словам", () => {
    const phrases = splitSubtitlePhrases(script);
    expect(phrases.every((p) => p.length <= 52)).toBe(true);
    expect(phrases.at(-1)).toContain("Занг занед.");
    expect(phrases.some((p) => p === "Занг занед.")).toBe(false);
    expect(wrapSubtitle("Масоҳаташ ҳаштоду шаш метри мураббаъ.").split("\n")).toHaveLength(2);
    expect(wrapSubtitle("Коротко.")).toBe("Коротко.");
  });
  it("время: подряд, от начала голоса до конца с учётом ускорения; по таймингам ElevenLabs — по первой букве фразы", () => {
    const cues = subtitleCues({ script, voiceSec: 9.2, startSec: 0.3, tempo: 1.15 });
    expect(cues[0]!.start).toBeCloseTo(0.3);
    expect(cues.at(-1)!.end).toBeCloseTo(0.3 + 9.2 / 1.15, 3);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeCloseTo(cues[i - 1]!.end, 6);
    const chars = [...script];
    const at = script.indexOf("Нархаш");
    const alignment = { characters: chars, character_start_times_seconds: chars.map((_, i) => (i < at ? i * 0.05 : 6 + (i - at) * 0.05)), character_end_times_seconds: chars.map((_, i) => (i < at ? i * 0.05 + 0.05 : 6 + (i - at) * 0.05 + 0.05)) };
    const exact = subtitleCues({ script, voiceSec: 9.2, startSec: 0.3, alignment });
    const price = exact.find((c) => c.text.startsWith("Нархаш"))!;
    expect(price.start).toBeCloseTo(6.3, 3);
  });
  it("путь шрифта в фильтре: прямые слэши, двоеточие диска экранировано; шрифты на месте", async () => {
    expect(ffFilterPath("C:\\a\\b.ttf")).toBe("C\\:/a/b.ttf");
    await expect(fs.access(OVERLAY_FONTS.bold)).resolves.toBeUndefined();
    await expect(fs.access(OVERLAY_FONTS.semibold)).resolves.toBeUndefined();
  });
});

describe.skipIf(!ffmpegReady)("текст на ролике: сведение", { timeout: 60_000 }, () => {
  it("с текстом: картинка меняется там, где плашка и субтитры, длина и звук те же", async () => {
    const plain = path.join(tmp, "plain.mp4"), withText = path.join(tmp, "text.mp4");
    const a = await mixNarrationOntoMaster({ masterPath: path.join(tmp, "master.mp4"), voicePath: path.join(tmp, "voice.mp3"), outPath: plain, fit: { allowFreeze: true } });
    const b = await mixNarrationOntoMaster({ masterPath: path.join(tmp, "master.mp4"), voicePath: path.join(tmp, "voice.mp3"), outPath: withText, fit: { allowFreeze: true },
      textOverlay: { price: "85 000 $", script } });
    expect(a.ok && b.ok).toBe(true);
    const info = (await probeMediaInfo(withText))!;
    expect(info.hasAudio && info.hasVideo).toBe(true);
    expect(Math.abs(info.durationSec - 5)).toBeLessThan(0.3);
    // Средняя яркость верхнего левого угла (плашка) на 2-й секунде отличается от ролика без текста.
    const crop = (file: string) => spawnSync(FF, ["-hide_banner", "-ss", "2", "-i", file, "-vf", "crop=iw*0.5:ih*0.12:0:ih*0.06,signalstats,metadata=print:key=lavfi.signalstats.UAVG", "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const u = (s: string) => Number(/UAVG=([\d.]+)/u.exec(s)?.[1] ?? "0");
    console.log("UAVG", u(crop(withText)), u(crop(plain)), crop(withText).slice(-400));
    expect(Math.abs(u(crop(withText)) - u(crop(plain)))).toBeGreaterThan(5);
  });
});
