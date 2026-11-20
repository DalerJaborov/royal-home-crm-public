import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/systemError.js")>(), logSystemError: vi.fn() }));
import { looksLikeMp3, NARRATION_LOUDNESS, normalizeNarrationVoice } from "../src/lib/narrationLoudness.js";
import { narrationAudioGraph } from "../src/lib/narrationMix.js";
import { musicBedFilter } from "../src/lib/narrationMusic.js";

/**
 * ГРОМКОСТЬ ОЗВУЧКИ (21.11.2026, владелец: «тихо»). Замер настоящим ffmpeg: голос ElevenLabs был −24 LUFS,
 * пробный перемонтаж −17 LUFS при привычных соцсетям −14. Тест строит «голос» и «музыку» из генераторов
 * ffmpeg, прогоняет ровно те фильтры, что в коде, и меряет громкость (EBU R128).
 */
const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"], { shell: process.platform === "win32" }).status === 0;
// Без ffmpeg замер не пропускается молча (ревью #348): на сервере и в CI ffmpeg есть, его пропажа — поломка.
// Локально без ffmpeg — явно: NARRATION_LOUDNESS_ALLOW_NO_FFMPEG=1.
const skipMeasure = !hasFfmpeg && process.env.NARRATION_LOUDNESS_ALLOW_NO_FFMPEG === "1";
const run = (args: string[]) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(r.stderr.slice(-800));
  return r.stderr;
};
const loudness = (file: string, trim = "") => {
  const out = run(["-i", file, "-af", `${trim}loudnorm=print_format=json`, "-f", "null", "-"]);
  return Number(/"input_i"\s*:\s*"(-?[\d.]+)"/.exec(out)![1]);
};

describe("громкость озвучки", () => {
  it("уровни в одном месте: голос −14 LUFS, музыка на 2 дБ ниже, сведение и подложка берут их отсюда", () => {
    expect(NARRATION_LOUDNESS.voice).toMatch(/I=-14\b/);
    expect(NARRATION_LOUDNESS.music).toMatch(/I=-16\b/);
    expect(narrationAudioGraph(true)).toContain(NARRATION_LOUDNESS.voice);
    expect(musicBedFilter(30)).toContain(NARRATION_LOUDNESS.music);
    expect(looksLikeMp3(Buffer.from("garbage"))).toBe(false);
    expect(looksLikeMp3(Buffer.from([0x49, 0x44, 0x33, 0x04]))).toBe(true);
  });

  it("ffmpeg есть (иначе голос монтажёру уходит тихим, а замер ниже ничего не проверяет)", () => {
    if (skipMeasure) return;
    expect(hasFfmpeg, `ffmpeg не найден (${ffmpeg}). Поставьте ffmpeg или FFMPEG_BIN; локально пропустить — NARRATION_LOUDNESS_ALLOW_NO_FFMPEG=1`).toBe(true);
  });

  it("полный диск: временная папка не создалась — оплаченный голос сохраняется как есть, в журнал запись, без исключения", async () => {
    const audio = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)]);
    const { logSystemError } = await import("../src/lib/systemError.js");
    vi.mocked(logSystemError).mockClear();
    const spy = vi.spyOn(fs.promises, "mkdtemp").mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    try {
      await expect(normalizeNarrationVoice(audio, "теста")).resolves.toBe(audio);
      expect(vi.mocked(logSystemError)).toHaveBeenCalledWith("api", expect.stringMatching(/громкость не выровнена.*ENOSPC/su), expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(skipMeasure)("тихий голос (−26 LUFS) после выравнивания ≈ −14; сведение: голос громкий, музыка под голосом не громче голоса − 12 дБ", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narr-loud-"));
    try {
      const quietVoice = path.join(dir, "voice.mp3");
      // «Речь»: тон 220 Гц, включается и выключается как фразы, на −26 LUFS.
      run(["-y", "-f", "lavfi", "-i", "sine=f=220:duration=12", "-af", "volume='if(lt(mod(t,3),2),1,0)':eval=frame,loudnorm=I=-26:TP=-6:LRA=11", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", quietVoice]);
      expect(loudness(quietVoice)).toBeLessThan(-23);
      const normalized = await normalizeNarrationVoice(fs.readFileSync(quietVoice), "теста");
      const voice = path.join(dir, "voice-norm.mp3");
      fs.writeFileSync(voice, normalized);
      expect(Math.abs(loudness(voice) - -14)).toBeLessThan(1.5);

      const music = path.join(dir, "music.wav");
      run(["-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=14:amplitude=0.5", "-af", `${NARRATION_LOUDNESS.music},aformat=sample_rates=48000:channel_layouts=stereo`, music]);
      const graph = (muteVoice: boolean, muteMusic: boolean) => narrationAudioGraph(true)
        .replace("[0:a]aformat", muteMusic ? "[0:a]volume=0,aformat" : "[0:a]aformat")
        .replace("[ducked][vmix]amix", muteVoice ? "[vmix]volume=0[vz];[ducked][vz]amix" : "[ducked][vmix]amix");
      const measure = (muteVoice: boolean, muteMusic: boolean) => {
        const out = path.join(dir, `mix-${muteVoice}-${muteMusic}.wav`);
        run(["-y", "-i", music, "-i", voice, "-filter_complex", graph(muteVoice, muteMusic), "-map", "[aout]", "-t", "12", out]);
        return loudness(out, "atrim=1:11,");
      };
      const full = measure(false, false), voiceOnly = measure(false, true), musicUnderVoice = measure(true, false);
      expect(full).toBeGreaterThan(-16.5);
      expect(voiceOnly - musicUnderVoice).toBeGreaterThan(12);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
