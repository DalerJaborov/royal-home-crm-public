// The model's words beside the template, 72 hours (lib/customerAgentAnswerSamples.ts, 17.11.2026): masks, retention, cap,
// switch, and a failed write that never reaches the turn.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { customerAgentAnswerSamplesEnabled, recordCustomerAgentAnswerSample, resetCustomerAgentAnswerSamplePurge, sampleSafeText,
  SAMPLE_DAILY_CAP, SAMPLE_TEXT_MAX, SAMPLE_TTL_MS } from "../src/lib/customerAgentAnswerSamples.js";
import * as systemError from "../src/lib/systemError.js";

const CHANNEL = `TEST_${Date.now() % 100000}`;
const base = { channel: CHANNEL, conversationId: "conv-1", eventKey: "event-1", answerMode: "shadow" as const, status: "dropped" as const,
  reason: "shadow", customerText: "Цена?", modelText: "Понимаю вас.\nЦена 900 000 сомони.", templateText: "Цена 900 000 сомони." };

describe("customer agent answer samples", () => {
  beforeEach(async () => { resetCustomerAgentAnswerSamplePurge(); await prisma.customerAgentAnswerSample.deleteMany({}); });
  afterAll(async () => { await prisma.customerAgentAnswerSample.deleteMany({}); });

  it("masks phones and links, bounds the length", () => {
    const text = sampleSafeText("Мой номер +992 900 12 34 56, смотрите https://royalhome.tj/p/123?x=1 и wa.me/992900123456");
    expect(text).not.toMatch(/900 12 34 56|992900123456|\d{4}/u);
    // Whole number hidden (the shared mask keeps first/last digits), e-mails too; prices stay.
    for (const phone of ["900-12-34-56", "+992900123456", "900123456", "2 21 45 67", "(37) 221-45-67"]) {
      expect(sampleSafeText(`Звоните ${phone}`)).toBe("Звоните [номер]");
    }
    expect(sampleSafeText("пишите ali.k@mail.ru")).toBe("пишите [почта]");
    expect(sampleSafeText("Цена 1 200 000 сомони, 3 комнаты")).toBe("Цена 1 200 000 сомони, 3 комнаты");
    expect(text).not.toContain("royalhome.tj/p/123");
    expect(text).toContain("[ссылка]");
    expect(sampleSafeText("а".repeat(SAMPLE_TEXT_MAX + 50))).toHaveLength(SAMPLE_TEXT_MAX);
  });

  it("on by default; only the exact word off stops it", () => {
    expect(customerAgentAnswerSamplesEnabled({})).toBe(true);
    expect(customerAgentAnswerSamplesEnabled({ CUSTOMER_AGENT_ANSWER_SAMPLES: "OFF" })).toBe(false);
    expect(customerAgentAnswerSamplesEnabled({ CUSTOMER_AGENT_ANSWER_SAMPLES: "on" })).toBe(true);
  });

  it("writes one masked row that expires in 72 hours", async () => {
    const now = new Date("2026-11-17T08:00:00.000Z");
    expect(await recordCustomerAgentAnswerSample({ ...base, customerText: "Позвоните +992 900 12 34 56" }, now, {})).toBe("written");
    const row = await prisma.customerAgentAnswerSample.findFirstOrThrow({ where: { channel: CHANNEL } });
    expect(row.expiresAt.getTime() - now.getTime()).toBe(SAMPLE_TTL_MS);
    expect(row.customerText).not.toContain("900 12 34 56");
    expect(row).toMatchObject({ status: "dropped", reason: "shadow", answerMode: "shadow", modelText: base.modelText, templateText: base.templateText });
  });

  it("off writes nothing but still removes expired rows", async () => {
    const now = new Date("2026-11-20T09:00:00.000Z");
    await prisma.customerAgentAnswerSample.create({ data: { ...base, createdAt: new Date(now.getTime() - SAMPLE_TTL_MS - 60_000),
      expiresAt: new Date(now.getTime() - 60_000) } });
    expect(await recordCustomerAgentAnswerSample(base, now, { CUSTOMER_AGENT_ANSWER_SAMPLES: "off" })).toBe("off");
    expect(await prisma.customerAgentAnswerSample.count()).toBe(0);
  });

  it("one row per customer turn: a retried turn with the same eventKey is not written twice", async () => {
    expect(await recordCustomerAgentAnswerSample(base, new Date(), {})).toBe("written");
    expect(await recordCustomerAgentAnswerSample(base, new Date(), {})).toBe("duplicate");
    expect(await prisma.customerAgentAnswerSample.count()).toBe(1);
  });

  it("expired rows are removed on the next write", async () => {
    const now = new Date("2026-11-20T09:00:00.000Z");
    await prisma.customerAgentAnswerSample.create({ data: { ...base, createdAt: new Date(now.getTime() - SAMPLE_TTL_MS - 60_000),
      expiresAt: new Date(now.getTime() - 60_000) } });
    expect(await recordCustomerAgentAnswerSample(base, now, {})).toBe("written");
    expect(await prisma.customerAgentAnswerSample.count()).toBe(1);
  });

  it("the daily cap stops writes for the rest of the Dushanbe day", async () => {
    const now = new Date("2026-11-17T10:00:00.000Z");
    await prisma.customerAgentAnswerSample.createMany({ data: Array.from({ length: SAMPLE_DAILY_CAP }, (_, i) => ({ ...base, eventKey: `cap-${i}`,
      createdAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() + SAMPLE_TTL_MS) })) });
    expect(await recordCustomerAgentAnswerSample({ ...base, eventKey: "cap-new" }, now, {})).toBe("capped");
    expect(await prisma.customerAgentAnswerSample.count()).toBe(SAMPLE_DAILY_CAP);
    // The cap is per channel: another channel still writes.
    expect(await recordCustomerAgentAnswerSample({ ...base, channel: `${CHANNEL}_B`, eventKey: "cap-other" }, now, {})).toBe("written");
  });

  it("a failed write goes to the error journal and never throws", async () => {
    const log = vi.spyOn(systemError, "logSystemError").mockResolvedValue(undefined as never);
    const result = await recordCustomerAgentAnswerSample({ ...base, modelText: undefined as never }, new Date(), {});
    expect(result).toBe("failed");
    expect(log).toHaveBeenCalledWith("ai", expect.stringContaining("не записан"), { dedupKey: "customer-agent-answer-sample-write" });
    expect(String(log.mock.calls[0][1])).not.toContain("Цена");
    log.mockRestore();
  });
});
