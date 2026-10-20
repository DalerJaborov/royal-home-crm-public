import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Охрана голосового сотрудника: два рубежа. Регулярка ловит цифры подряд —
 * проверяется без моков, это тот же разбор, что уже используется в maskContacts.
 * Классификатор (Gemini, с 16.08.2026 — раньше жёстко звал Anthropic в обход
 * общего переключателя поставщика) мокается: реальный вызов модели в юнит-тесте
 * не нужен, важно только, что его вердикт учитывается и что сбой модели НЕ
 * блокирует голосовое (иначе агент терял бы записи каждый раз, когда модель
 * прилегла).
 */

vi.mock("../src/ai/geminiClient.js", () => ({ callGemini: vi.fn() }));

const { callGemini } = await import("../src/ai/geminiClient.js");
const { checkAgentVoiceMessage } = await import("../src/ai/voiceComplianceGuard.js");

describe("Рубеж 1: номер телефона в расшифровке", () => {
  afterEach(() => vi.clearAllMocks());

  it("международный номер — блок без обращения к модели", async () => {
    const result = await checkAgentVoiceMessage("Можете написать мне на +992 930 00 10 01");
    expect(result.blocked).toBe(true);
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("девять цифр подряд (местный мобильный) — тоже блок", async () => {
    const result = await checkAgentVoiceMessage("мой номер 930001001 пишите туда");
    expect(result.blocked).toBe(true);
  });

  it("обычный рабочий разговор без цифр — не блокируется", async () => {
    vi.mocked(callGemini).mockResolvedValue({ violation: false, reason: "" });
    const result = await checkAgentVoiceMessage("Квартира трёхкомнатная, этаж третий, можем показать завтра");
    expect(result.blocked).toBe(false);
  });
});

describe("Рубеж 2: классификатор ловит обход без явных цифр", () => {
  afterEach(() => vi.clearAllMocks());

  it("предложение писать в личный WhatsApp в обход CRM — блок по вердикту модели", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      violation: true,
      reason: "предлагает договориться в обход агентства",
    });
    const result = await checkAgentVoiceMessage("Давайте я вам в личный вотсап напишу, так проще договоримся");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("обход");
  });

  it("модель недоступна (null) — НЕ блокирует: первый рубеж уже чист", async () => {
    vi.mocked(callGemini).mockResolvedValue(null);
    const result = await checkAgentVoiceMessage("Обсудим детали при встрече");
    expect(result.blocked).toBe(false);
  });

  it("пустая расшифровка — блокировать нечего, модель не вызывается", async () => {
    const result = await checkAgentVoiceMessage("");
    expect(result.blocked).toBe(false);
    expect(callGemini).not.toHaveBeenCalled();
  });
});
