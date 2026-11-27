import { expect, it } from "vitest";
import { applySpokenPronunciation, narrationSpeechText } from "@royal-home/shared";
import { assistantVoiceCacheKey } from "../src/telegram/assistantVoiceCache.js";
import { directAssistantVoice } from "../src/telegram/assistantVoiceDirection.js";

/** CRM в голосе читается «сиарэм» (27.11.2026, владелец). Меняется только текст для синтеза, не письменный. */
it("заменяет отдельное слово CRM в любом регистре", () => {
  expect(applySpokenPronunciation("Откройте CRM и найдите карточку.")).toBe("Откройте сиарэм и найдите карточку.");
  expect(applySpokenPronunciation("в crm, в Crm и в CRM.")).toBe("в сиарэм, в сиарэм и в сиарэм.");
  expect(applySpokenPronunciation("CRM-система")).toBe("сиарэм-система");
  expect(applySpokenPronunciation("Дар CRM нигоҳ кунед!")).toBe("Дар сиарэм нигоҳ кунед!");
  expect(applySpokenPronunciation("(CRM)")).toBe("(сиарэм)");
});

it("не трогает адреса, домены, пути и слова, где CRM внутри", () => {
  for (const kept of ["crm.royalhome.tj", "https://crm.royalhome.tj/clients", "@crm", "/crm/clients", "my_crm_app", "CRMS", "preCRM", "royal-crm", "CRM2"]) {
    expect(applySpokenPronunciation(kept)).toBe(kept);
  }
  expect(applySpokenPronunciation("Зайдите на crm.royalhome.tj в CRM")).toBe("Зайдите на crm.royalhome.tj в сиарэм");
});

it("голос Шабнам и озвучка: подмена в тексте для синтеза, ключ кэша от неё зависит, письменный текст цел", () => {
  const written = "Готово, смотрите в CRM.";
  const spoken = applySpokenPronunciation(directAssistantVoice(written));
  expect(spoken).toContain("сиарэм");
  expect(written).toContain("CRM");
  const settings = { voiceId: "v", language: "ru" };
  expect(assistantVoiceCacheKey(spoken, settings)).not.toBe(assistantVoiceCacheKey(directAssistantVoice(written), settings));
  for (const lang of ["ru", "tg", null] as const) expect(narrationSpeechText("Новая карточка в CRM", lang)).toBe("Новая карточка в сиарэм");
});
