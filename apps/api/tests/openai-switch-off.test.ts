/**
 * Рубильник OpenAI целиком (14.11.2026, владелец: «Опен ии полностью выключи, нам не
 * нужны обложки больше от него. И уведомления пусть не идут»). Выключен — ключ
 * «не настроен» даже при заданном ключе, обложка только шаблоном без перерисовки,
 * «кончились деньги OpenAI» не попадает ни в напоминания Мушовир, ни в пульт.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { isOpenAiEnabled, resolveOpenAiKey } from "../src/ai/openaiClient.js";
import { loadCoverRuntimeSettings } from "../src/lib/video/coverOpenAi.js";
import { billingFailures } from "../src/lib/paymentReminders.js";

const MARK = "openai-switch-off-test";
let before: { openaiEnabled: boolean; openaiApiKey: string | null; coverProvider: string; coverPhotoRedraw: boolean } | null = null;

beforeAll(async () => {
  before = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { openaiEnabled: true, openaiApiKey: true, coverProvider: true, coverPhotoRedraw: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { openaiApiKey: encryptSecret("sk-test-switch"), coverProvider: "OPENAI", coverPhotoRedraw: true },
  });
  await prisma.errorLog.create({
    data: { source: "api", message: `${MARK}: Обложка: ChatGPT не справился (На счёте OpenAI закончились деньги, пополните баланс)` },
  });
});

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { message: { startsWith: MARK } } });
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
});

describe("рубильник OpenAI", () => {
  it("выключен: ключа нет, обложка шаблоном без перерисовки, напоминания об оплате OpenAI нет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { openaiEnabled: false } });
    expect(await isOpenAiEnabled()).toBe(false);
    expect(await resolveOpenAiKey()).toBeNull();
    const runtime = await loadCoverRuntimeSettings();
    expect(runtime.openaiEnabled).toBe(false);
    expect(runtime.coverProvider).toBe("TEMPLATE");
    expect(runtime.coverPhotoRedraw).toBe(false);
    const failures = await billingFailures();
    expect(failures.map((f) => f.service.key)).not.toContain("openai");
  });

  it("включён: всё как раньше", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { openaiEnabled: true } });
    expect(await resolveOpenAiKey()).toEqual({ key: "sk-test-switch", source: "settings" });
    const runtime = await loadCoverRuntimeSettings();
    expect(runtime.coverProvider).toBe("OPENAI");
    expect(runtime.coverPhotoRedraw).toBe(true);
    const failures = await billingFailures();
    expect(failures.map((f) => f.service.key)).toContain("openai");
  });

  it("по умолчанию в схеме выключен", async () => {
    const col = await prisma.$queryRaw<{ column_default: string | null }[]>`
      SELECT column_default FROM information_schema.columns WHERE table_name = 'Settings' AND column_name = 'openaiEnabled'`;
    expect(col[0]?.column_default).toBe("false");
  });
});
