import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The channel core reads the mode switch from the settings; here the switch is «on» without a database.
vi.mock("../src/lib/leadOnlyConfig.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/lib/leadOnlyConfig.js")>();
  const { LEAD_ONLY_DEFAULTS } = await import("../src/ai/leadOnlyMode.js");
  return { ...actual, loadLeadOnlyConfig: async () => ({ ...LEAD_ONLY_DEFAULTS, enabled: true }) };
});
import { LEAD_ONLY_DEFAULT_CHANNELS, leadOnlyAppliesTo, leadOnlyChannels } from "../src/ai/leadOnlyMode.js";
import { channelCoreLeadOnly } from "../src/lib/customerChannelCore.js";

/**
 * КАНАЛЫ РЕЖИМА «ТОЛЬКО ЗАЯВКИ» — ОДНА НАСТРОЙКА (17.11.2026). Сайт и Telegram вне режима (решение 13.11.2026); расширить —
 * одна строка BOT_LEAD_ONLY_CHANNELS в .env.production, а не переписывание. Пусто или только неизвестные имена — по умолчанию
 * WhatsApp, Instagram, Facebook; неизвестное имя пропускается и пишется в журнал один раз.
 */
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("BOT_LEAD_ONLY_CHANNELS", () => {
  it("не задано или пусто — WhatsApp, Instagram, Facebook (решение 13.11.2026)", () => {
    expect(leadOnlyChannels({})).toEqual(["WHATSAPP", "INSTAGRAM", "FACEBOOK"]);
    expect(leadOnlyChannels({ BOT_LEAD_ONLY_CHANNELS: "" })).toEqual([...LEAD_ONLY_DEFAULT_CHANNELS]);
    expect(leadOnlyChannels({ BOT_LEAD_ONLY_CHANNELS: " , " })).toEqual([...LEAD_ONLY_DEFAULT_CHANNELS]);
    expect(leadOnlyAppliesTo("WEBSITE", {})).toBe(false);
    expect(leadOnlyAppliesTo("TELEGRAM", {})).toBe(false);
  });
  it("список заменяет умолчание: регистр и пробелы не важны, повторы схлопываются", () => {
    const env = { BOT_LEAD_ONLY_CHANNELS: " whatsapp , Website,WHATSAPP " };
    expect(leadOnlyChannels(env)).toEqual(["WHATSAPP", "WEBSITE"]);
    expect(leadOnlyAppliesTo("WEBSITE", env)).toBe(true);
    expect(leadOnlyAppliesTo("INSTAGRAM", env)).toBe(false);
  });
  it("неизвестное имя пропускается и пишется один раз; одни неизвестные — умолчание", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { BOT_LEAD_ONLY_CHANNELS: "instagram,viber" };
    expect(leadOnlyChannels(env)).toEqual(["INSTAGRAM"]);
    expect(leadOnlyChannels(env)).toEqual(["INSTAGRAM"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("viber");
    expect(leadOnlyChannels({ BOT_LEAD_ONLY_CHANNELS: "viber,signal" })).toEqual([...LEAD_ONLY_DEFAULT_CHANNELS]);
    expect(error).toHaveBeenCalledTimes(2);
  });
  it("переменная доходит до контейнера: она в блоке crm-env docker-compose.prod.yml", () => {
    const compose = readFileSync(new URL("../../../docker-compose.prod.yml", import.meta.url), "utf8");
    expect(compose).toMatch(/^\s+BOT_LEAD_ONLY_CHANNELS: "\$\{BOT_LEAD_ONLY_CHANNELS:-\}"/mu);
  });
});

describe("адаптер каналов спрашивает ту же настройку", () => {
  it("по умолчанию сайт и Telegram вне режима, Instagram — в режиме", async () => {
    expect(await channelCoreLeadOnly("WEBSITE")).toBe(false);
    expect(await channelCoreLeadOnly("TELEGRAM")).toBe(false);
    expect(await channelCoreLeadOnly("INSTAGRAM")).toBe(true);
  });
  it("сайт добавлен одной строкой — адаптер его тоже ведёт в режиме", async () => {
    vi.stubEnv("BOT_LEAD_ONLY_CHANNELS", "WHATSAPP,INSTAGRAM,FACEBOOK,WEBSITE");
    expect(await channelCoreLeadOnly("WEBSITE")).toBe(true);
  });
});
