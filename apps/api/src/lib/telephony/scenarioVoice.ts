import { DEFAULT_GEMINI_VOICE, voiceGender, type VoiceGender } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { LIVE_VOICE_TUNING } from "../settingsConstants.js";

/**
 * ГОЛОС СЦЕНАРНОГО ЗВОНКА — ДО ТОГО, КАК СОБРАН ПРОМТ (02.10.2026, жалоба владельца
 * на род: «сотрудница Мадина» мужским голосом и наоборот).
 *
 * Опрос после показа и проверка продавца представляются по имени, а имя и
 * «сотрудница/сотрудник» должны совпадать с голосом. Мост выбирает голос сам
 * (liveVoiceBridge.ts::resolveLiveVoiceVoiceName: замок «Только русский» — основной
 * голос, без замка — таджикский, если задан), но уже после того, как промт собран.
 * Поэтому сценарий выбирает голос здесь тем же правилом и передаёт его мосту явно
 * (task.voiceName): промт и звучащий голос не разойдутся.
 *
 * Мост сюда не импортируется нарочно: тесты расписания подменяют его модуль целиком.
 */
export interface ScenarioVoice {
  voiceName: string;
  gender: VoiceGender;
  /**
   * Замок «только русский» из Настроек (02.10.2026, аудит текстов, п. 3). Голос выше
   * выбран по нему: замок снят — таджикский голос. Промт сценария обязан собираться с
   * ТЕМ ЖЕ значением (buildPostShowingCallPrompt(ctx, forceRussianOnly)) и сессия —
   * тоже (task.forceRussianOnly): иначе таджикским голосом звучит текст «говори только
   * по-русски, даже если собеседник перешёл на таджикский».
   */
  forceRussianOnly: boolean;
}

export function pickScenarioVoiceName(
  settings: { liveVoiceVoiceName: string | null; liveVoiceVoiceNameTajik: string | null; liveVoiceForceRussianOnly: boolean } | null
): string {
  const fallback = process.env.LIVE_VOICE_VOICE_NAME || DEFAULT_GEMINI_VOICE;
  if (!settings) return fallback;
  const picked = settings.liveVoiceForceRussianOnly
    ? settings.liveVoiceVoiceName
    : settings.liveVoiceVoiceNameTajik || settings.liveVoiceVoiceName;
  return picked || fallback;
}

/** Не бросает: отказ базы — голос по умолчанию, звонок не срывается. */
export async function scenarioVoice(): Promise<ScenarioVoice> {
  const settings = await prisma.settings
    .findUnique({
      where: { id: "singleton" },
      select: { liveVoiceVoiceName: true, liveVoiceVoiceNameTajik: true },
    })
    // Замок «только русский» — константа с 01.11.2026 (lib/settingsConstants.ts).
    .then((row) => (row ? { ...row, liveVoiceForceRussianOnly: LIVE_VOICE_TUNING.forceRussianOnly } : null))
    .catch(() => null);
  const voiceName = pickScenarioVoiceName(settings);
  // Нет настроек (отказ базы) — голос по умолчанию, как при замке, и замок считаем включённым.
  return { voiceName, gender: voiceGender(voiceName), forceRussianOnly: settings?.liveVoiceForceRussianOnly ?? true };
}
