import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  checkElevenLabsBalances,
  checkSmsBalance,
  collectElevenLabsKeys,
  runBalanceWatch,
  smsLowBalanceThreshold,
  ELEVENLABS_LOW_ALARM_TAG,
  SMS_BALANCE_ALARM_TAG,
} from "../src/lib/balanceWatch.js";
import { ELEVENLABS_QUOTA_ALARM_TAG } from "../src/lib/channelKeyAlarm.js";

/**
 * Остаток платных сервисов заранее (охота 14.11.2026, №6). В тестах НИКАКИХ живых вызовов:
 * ElevenLabs и СМС подменены заглушками (fetch или подставленные функции). Правило 11.11:
 * кредиты ElevenLabs уже сгорали от автотестов.
 */

const TAGS = [ELEVENLABS_QUOTA_ALARM_TAG, ELEVENLABS_LOW_ALARM_TAG, SMS_BALANCE_ALARM_TAG];
const clean = () => prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: TAGS } } });
beforeEach(async () => {
  await clean();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await clean();
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

const alerts = (tag: string) => prisma.pendingDirectorAlert.findMany({ where: { tag } });
const keys = (...sources: string[]) => async () => sources.map((source) => ({ source, apiKey: `test-key-${source}` }));
const usage = (map: Record<string, [number, number]>) => async (apiKey: string) => {
  const [used, limit] = map[apiKey.replace("test-key-", "")] ?? [0, 0];
  return { used, limit };
};

describe("ElevenLabs: остаток по каждому ключу", () => {
  it("ниже 80%: тишина", async () => {
    expect(await checkElevenLabsBalances({ listKeys: keys("а"), subscription: usage({ а: [790, 1000] }) })).toBe(0);
    expect(await alerts(ELEVENLABS_LOW_ALARM_TAG)).toHaveLength(0);
    expect(await alerts(ELEVENLABS_QUOTA_ALARM_TAG)).toHaveLength(0);
  });

  it("80% и больше: «к сведению», не срочно", async () => {
    expect(await checkElevenLabsBalances({ listKeys: keys("а"), subscription: usage({ а: [850, 1000] }) })).toBe(1);
    const [row] = await alerts(ELEVENLABS_LOW_ALARM_TAG);
    expect(row.urgent).toBe(false);
    expect(row.body).toContain("85%");
  });

  it("95% и больше хотя бы по одному ключу: срочная тревога, в тексте источник, а не ключ", async () => {
    expect(
      await checkElevenLabsBalances({ listKeys: keys("Настройки", "Шабнам"), subscription: usage({ Настройки: [100, 1000], Шабнам: [980, 1000] }) })
    ).toBe(1);
    const [row] = await alerts(ELEVENLABS_QUOTA_ALARM_TAG);
    expect(row).toMatchObject({ level: "CRITICAL", urgent: true });
    expect(row.body).toContain("Шабнам");
    expect(row.body).not.toContain("test-key");
    expect(await alerts(ELEVENLABS_LOW_ALARM_TAG)).toHaveLength(0);
  });

  it("повтор в тот же день не плодит тревоги; сбой чтения одного ключа не прячет другой", async () => {
    const deps = {
      listKeys: keys("а", "б"),
      subscription: async (apiKey: string) => {
        if (apiKey.endsWith("а")) throw new Error("ElevenLabs GET: нет ответа");
        return { used: 990, limit: 1000 };
      },
    };
    expect(await checkElevenLabsBalances(deps)).toBe(1);
    expect(await checkElevenLabsBalances(deps)).toBe(0);
    expect(await alerts(ELEVENLABS_QUOTA_ALARM_TAG)).toHaveLength(1);
  });

  it("безлимит (limit 0): не тревога", async () => {
    expect(await checkElevenLabsBalances({ listKeys: keys("а"), subscription: usage({ а: [5000, 0] }) })).toBe(0);
  });

  it("настоящий путь чтения идёт через fetch-заглушку, без сети", async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ character_count: 960, character_limit: 1000 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchStub);
    const saved = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-key-env-only";
    try {
      const listed = await collectElevenLabsKeys();
      expect(listed.some((k) => k.apiKey === "test-key-env-only" && k.source.includes(".env"))).toBe(true);
      expect(await checkElevenLabsBalances({ listKeys: async () => listed.filter((k) => k.apiKey === "test-key-env-only") })).toBe(1);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("/v1/user/subscription");
      expect(init.method).toBe("GET");
    } finally {
      if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = saved;
    }
  });
});

describe("СМС Payom: остаток ниже порога", () => {
  const saved = process.env.SMS_LOW_BALANCE_TJS;
  afterAll(() => {
    if (saved === undefined) delete process.env.SMS_LOW_BALANCE_TJS;
    else process.env.SMS_LOW_BALANCE_TJS = saved;
  });

  it("порог по умолчанию 50 TJS; ниже: срочная тревога, выше: тишина", async () => {
    delete process.env.SMS_LOW_BALANCE_TJS;
    expect(smsLowBalanceThreshold()).toBe(50);
    expect(await checkSmsBalance({ smsConfigured: async () => true, smsBalance: async () => ({ ok: true, balance: 120, currency: "TJS" }) })).toBe(0);
    expect(await checkSmsBalance({ smsConfigured: async () => true, smsBalance: async () => ({ ok: true, balance: 12.5, currency: "TJS" }) })).toBe(1);
    const [row] = await alerts(SMS_BALANCE_ALARM_TAG);
    expect(row).toMatchObject({ level: "CRITICAL", urgent: true });
    expect(row.body).toContain("12.5");
  });

  it("порог из .env; СМС не подключены или ответ не получен: тишина", async () => {
    process.env.SMS_LOW_BALANCE_TJS = "200";
    expect(smsLowBalanceThreshold()).toBe(200);
    expect(await checkSmsBalance({ smsConfigured: async () => false, smsBalance: async () => ({ ok: true, balance: 0, currency: "TJS" }) })).toBe(0);
    expect(await checkSmsBalance({ smsConfigured: async () => true, smsBalance: async () => ({ ok: false, error: "нет ответа" }) })).toBe(0);
    expect(await checkSmsBalance({ smsConfigured: async () => true, smsBalance: async () => ({ ok: true, balance: 10, currency: "USD" }) })).toBe(0);
    expect(await alerts(SMS_BALANCE_ALARM_TAG)).toHaveLength(0);
  });
});

describe("суточный проход", () => {
  it("отказ одной проверки не прячет другую", async () => {
    delete process.env.SMS_LOW_BALANCE_TJS;
    const total = await runBalanceWatch({
      listKeys: async () => {
        throw new Error("база не ответила");
      },
      smsConfigured: async () => true,
      smsBalance: async () => ({ ok: true, balance: 5, currency: "TJS" }),
    });
    expect(total).toBe(1);
    expect(await alerts(SMS_BALANCE_ALARM_TAG)).toHaveLength(1);
  });
});
