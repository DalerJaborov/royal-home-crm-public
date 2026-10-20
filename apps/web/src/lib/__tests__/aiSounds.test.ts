import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Единая точка гейта тумблера «Звуки уведомлений» (R2-код-ревью, дефект «мешает»
 * 09.09.2026; тумблер переименован из «Звуки ИИ» 15.09.2026 после удаления знака
 * ИИ — гейт и его назначение те же): `lib/aiSounds.ts` сам читает
 * `useUiPrefs.getState().aiSoundsEnabled`, а не разрозненные вызывающие компоненты.
 * Тест бьёт по самому важному следствию: при выключенном тумблере ни один
 * `play*`/`unlockAudio()` не должен создавать `AudioContext`.
 */

let aiSoundsEnabled = true;

vi.mock("../../store/uiPrefs", () => ({
  useUiPrefs: {
    getState: () => ({ aiSoundsEnabled }),
  },
}));

describe("aiSounds: тумблер «Звуки уведомлений» — единая точка в lib/aiSounds.ts", () => {
  let audioContextCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    aiSoundsEnabled = true;
    audioContextCtor = vi.fn().mockImplementation(() => ({
      state: "suspended",
      currentTime: 0,
      sampleRate: 44100,
      resume: vi.fn().mockResolvedValue(undefined),
      createGain: () => ({
        gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      }),
      createOscillator: () => ({
        type: "sine",
        frequency: { setValueAtTime: vi.fn(), value: 0 },
        detune: {},
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }),
      createBiquadFilter: () => ({
        type: "lowpass",
        Q: { value: 0 },
        frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      }),
      createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
      createConvolver: () => ({ buffer: null, normalize: false, connect: vi.fn() }),
      createBufferSource: () => ({ buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
      destination: {},
    }));
    (globalThis as { window?: unknown }).window = { AudioContext: audioContextCtor };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it("выключенный тумблер: unlockAudio() не создаёт AudioContext", async () => {
    aiSoundsEnabled = false;
    const { unlockAudio } = await import("../aiSounds");
    unlockAudio();
    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  it("выключенный тумблер: ни один play* не создаёт AudioContext", async () => {
    aiSoundsEnabled = false;
    const {
      playSoftTick,
      // Звуки событий, добавленные 12.09.2026: тумблер обязан гасить и их —
      // иначе «Звуки уведомлений: выкл» перестаёт означать тишину.
      playNewLead,
      playNewMessage,
      playIncomingCall,
      playSuccess,
      playError,
    } = await import("../aiSounds");
    playSoftTick();
    playNewLead();
    playNewMessage();
    playIncomingCall();
    playSuccess();
    playError();
    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  /**
   * ТИХИЕ ЧАСЫ 21:00 → 08:00 ПО ДУШАНБЕ (владелец 12.09.2026, то же окно, что у
   * пушей). Граница проверяется через тот же `dushanbeHour`, которым живёт весь
   * фронт, — час подменяется моком, а не `setHours` на настоящей дате: у
   * владельца устройство может стоять в любом поясе, и тест обязан проверять
   * правило, а не часы машины, на которой он бежит.
   */
  it("ночью молчат звуки СОБЫТИЙ, но не отклик на собственное действие", async () => {
    aiSoundsEnabled = true;
    vi.doMock("../date", () => ({ dushanbeHour: () => 23 }));
    const { playNewLead, playNewMessage, playSoftTick } = await import("../aiSounds");
    playNewLead();
    playNewMessage();
    playSoftTick();
    expect(audioContextCtor).not.toHaveBeenCalled();

    // Своё действие (сохранение/отказ) и звонок, который идёт прямо сейчас,
    // тишиной не глушатся.
    const { playSuccess, playError, playIncomingCall } = await import("../aiSounds");
    playSuccess();
    expect(audioContextCtor).toHaveBeenCalled();
    playError();
    playIncomingCall();
    vi.doUnmock("../date");
  });

  it("днём звуки событий проходят", async () => {
    aiSoundsEnabled = true;
    vi.doMock("../date", () => ({ dushanbeHour: () => 12 }));
    const { playNewLead } = await import("../aiSounds");
    playNewLead();
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    vi.doUnmock("../date");
  });

  it("включённый тумблер: unlockAudio() создаёт/использует AudioContext", async () => {
    aiSoundsEnabled = true;
    const { unlockAudio } = await import("../aiSounds");
    unlockAudio();
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
  });
});
