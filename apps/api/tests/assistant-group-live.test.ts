import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import * as gemini from "../src/ai/geminiClient.js";
import {
  LIVE_COOLDOWN_MS, LIVE_MAX_PER_HOUR, claimLiveSlot, considerLiveChime,
} from "../src/telegram/assistantGroupLive.js";

vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGemini: vi.fn(),
}));

const unique = randomInt(100_000, 900_000);
const chatId = String(-970_000_000 - unique);
// 15:00 по Душанбе (10:00 UTC): рабочее время.
const noon = new Date("2026-11-25T10:00:00Z");
let agentId = "";
let settingsBefore: { shabnamGroupLiveEnabled: boolean; shabnamGroupLiveShadowEnabled: boolean } | null = null;
const callGemini = vi.mocked(gemini.callGemini);

const input = (text = "Всем доброе утро, коллеги!") => ({
  chatId, messageId: 5, text, fromTelegramId: 970_000_000 + unique, isBot: false, isForwarded: false, senderIsChat: false,
});

async function resetGroup(data: Record<string, unknown> = {}) {
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
  await prisma.assistantTelegramGroup.create({ data: { chatId, registeredByAgentId: agentId, ...data } });
}

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Живая тест", phone: `+992970${unique}` } })).id;
  settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { shabnamGroupLiveEnabled: true, shabnamGroupLiveShadowEnabled: true } });
});

beforeEach(async () => {
  callGemini.mockReset();
  await prisma.settings.update({ where: { id: "singleton" }, data: { shabnamGroupLiveEnabled: true, shabnamGroupLiveShadowEnabled: false } });
  await resetGroup();
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
  await prisma.agent.delete({ where: { id: agentId } }).catch(() => {});
});

describe("живая беседа в группе", () => {
  it("занимает место атомарно: перерыв и потолок в час", async () => {
    expect(await claimLiveSlot(chatId, noon)).toBe(true);
    expect(await claimLiveSlot(chatId, new Date(noon.getTime() + 60_000))).toBe(false); // перерыв не прошёл
    let t = noon.getTime();
    for (let i = 1; i < LIVE_MAX_PER_HOUR; i++) {
      t += LIVE_COOLDOWN_MS + 1000;
      expect(await claimLiveSlot(chatId, new Date(t))).toBe(true);
    }
    t += LIVE_COOLDOWN_MS + 1000;
    if (t - noon.getTime() < 3_600_000) expect(await claimLiveSlot(chatId, new Date(t))).toBe(false); // потолок
    expect(await claimLiveSlot(chatId, new Date(noon.getTime() + 3_600_000 + 1000))).toBe(true); // новый час
  });

  it("«помолчи» не даёт занять место", async () => {
    await resetGroup({ proactiveMutedUntil: new Date(noon.getTime() + 10 * 60_000) });
    expect(await claimLiveSlot(chatId, noon)).toBe(false);
  });

  it("модель решила вступить: реплика уходит один раз", async () => {
    callGemini.mockResolvedValue({ join: true, reply: "Доброе утро, хорошего дня!" });
    const deliver = vi.fn(async () => true);
    expect(await considerLiveChime(input(), deliver, noon)).toEqual({ kind: "send", reply: "Доброе утро, хорошего дня!" });
    expect(deliver).toHaveBeenCalledOnce();
    // Сразу следующее сообщение: перерыв, модель даже не зовётся.
    callGemini.mockClear();
    expect(await considerLiveChime(input("И вам!"), deliver, new Date(noon.getTime() + 30_000))).toEqual({ kind: "skip", reason: "cooldown" });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("режимы «помогает» и «слушает», ночь, запретная тема, выключатель: модель не зовётся", async () => {
    const deliver = vi.fn(async () => true);
    for (const chatMode of ["HELP", "LISTEN"]) {
      await resetGroup({ chatMode });
      expect(await considerLiveChime(input(), deliver, noon)).toEqual({ kind: "skip", reason: "mode" });
    }
    await resetGroup();
    expect(await considerLiveChime(input(), deliver, new Date("2026-11-25T18:00:00Z"))).toEqual({ kind: "skip", reason: "quiet-hours" });
    expect(await considerLiveChime(input("Опять штраф, надоело"), deliver, noon)).toEqual({ kind: "skip", reason: "topic" });
    await prisma.settings.update({ where: { id: "singleton" }, data: { shabnamGroupLiveEnabled: false } });
    expect(await considerLiveChime(input(), deliver, noon)).toEqual({ kind: "skip", reason: "switch-off" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("пробный режим: решение записано, в группу ничего не уходит и место не занято", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { shabnamGroupLiveShadowEnabled: true } });
    callGemini.mockResolvedValue({ join: true, reply: "Доброе утро!" });
    const deliver = vi.fn(async () => true);
    expect(await considerLiveChime(input(), deliver, noon)).toEqual({ kind: "shadow", reply: "Доброе утро!" });
    expect(deliver).not.toHaveBeenCalled();
    expect((await prisma.assistantTelegramGroup.findUniqueOrThrow({ where: { chatId } })).liveWindowCount).toBe(0);
  });

  it("не человек, пересланное, команда: пропуск без модели", async () => {
    const deliver = vi.fn(async () => true);
    expect(await considerLiveChime({ ...input(), isBot: true }, deliver, noon)).toMatchObject({ kind: "skip" });
    expect(await considerLiveChime({ ...input(), isForwarded: true }, deliver, noon)).toMatchObject({ kind: "skip" });
    expect(await considerLiveChime(input("/start"), deliver, noon)).toMatchObject({ kind: "skip" });
    expect(callGemini).not.toHaveBeenCalled();
  });
});
