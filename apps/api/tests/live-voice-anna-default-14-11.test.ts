import { describe, expect, it } from "vitest";
import { DEFAULT_PHONE_VOICE_ID } from "../src/ai/liveVoiceProvider.js";
import { LIVE_VOICE_SPEECH_RULES } from "../src/ai/liveVoicePersona.js";
import { buildConsultantSystemPrompt } from "../src/ai/liveVoiceConsultantPersona.js";
import { buildLiveVoiceKnowledge } from "../src/ai/liveVoiceKnowledge.js";

/** 14.11.2026, владелец: голос телефонии — Anna; без «понял/поняла/ага», без эмоций, быстро по делу. */
describe("голос Anna по умолчанию и деловой тон робота", () => {
  it("голос по умолчанию — Anna - Premium Lifestyle Ads", () => {
    expect(DEFAULT_PHONE_VOICE_ID).toBe("0XJ7mts7SfzZk5uEHl4e");
  });

  it("общие правила речи не советуют «Ага/Понятно/Хорошо» и запрещают зачины-подтверждения", () => {
    expect(LIVE_VOICE_SPEECH_RULES).not.toContain('Живой ответ: "Ага", "Понятно"');
    expect(LIVE_VOICE_SPEECH_RULES).toContain("БЕЗ ПОДТВЕРЖДЕНИЙ-ЗАЧИНОВ");
    expect(LIVE_VOICE_SPEECH_RULES).toContain("без эмоций");
  });

  it("консультант: подтверждения без «Ага/Угу/Ясно» и таджикского «фаҳмидам»", () => {
    const prompt = buildConsultantSystemPrompt({
      knowledge: buildLiveVoiceKnowledge({
        folkGeography: "",
        sellerRules: "",
        learnedRules: "",
        usdToTjs: 10.95,
        wallClock: new Date(Date.UTC(2026, 10, 14, 10, 30)),
      }),
      caller: { numberKnown: true, selfName: null, agentName: null, dossier: "" },
      withinWorkingHours: true,
      forceRussianOnly: false,
    });
    const line = prompt.split("\n").find((l) => l.startsWith("- Подтверждения меняй:")) ?? "";
    const list = line.slice(0, line.indexOf(". Один"));
    for (const bad of ["«Ага»", "«Угу»", "«Ясно»", "«Понял»", "«Поняла»"]) expect(list).not.toContain(bad);
    expect(line).toContain("никогда «понял», «поняла»");
    expect(prompt).not.toContain("«Ҳа, фаҳмидам»");
  });
});
