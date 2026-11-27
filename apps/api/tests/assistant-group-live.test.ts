import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import * as gemini from "../src/ai/geminiClient.js";
import {
  LIVE_COOLDOWN_MS, LIVE_MAX_PER_DAY, LIVE_MAX_PER_HOUR, claimLiveSlot, considerLiveChime,
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
let settingsBefore: { shabnamGroupLiveEnabled: boolean; shabnamGroupLiveShadowEnabled: boolean; shabnamGroupUnaddressedEnabled: boolean } | null = null;
const callGemini = vi.mocked(gemini.callGemini);

const input = (text = "Всем доброе утро, коллеги!") => ({
  chatId, messageId: 5, text, fromTelegramId: 970_000_000 + unique, isBot: false, isForwarded: false, senderIsChat: false,
});

async function resetGroup(data: Record<string, unknown> = {}) {
  await prisma.assistantTelegramGroup.deleteMany({ where: { chatId } });
  await prisma.assistantTelegramGroup.create({ data: { chatId, registeredByAgentId: agentId, contextEnabledAt: new Date(), ...data } });
}

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Живая тест", phone: `+992970${unique}` } })).id;
  settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { shabnamGroupLiveEnabled: true, shabnamGroupLiveShadowEnabled: true, shabnamGroupUnaddressedEnabled: true } });
});

beforeEach(async () => {
  callGemini.mockReset();
  await prisma.settings.update({ where: { id: "singleton" }, data: { shabnamGroupLiveEnabled: true, shabnamGroupLiveShadowEnabled: false, shabnamGroupUnaddressedEnabled: true } });
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

  // Ревью 26.11.2026: не больше шести живых реплик в сутки по Душанбе на группу, новые сутки — заново.
  it("потолок в сутки по Душанбе: шесть реплик, седьмая нет, наутро снова можно", async () => {
    const start = new Date("2026-11-25T03:30:00Z"); // 08:30 по Душанбе
    let claimed = 0;
    for (let i = 0; i < LIVE_MAX_PER_DAY + 2; i++) {
      // Раз в 25 минут: перерыв и часовой потолок не мешают, мешает только суточный.
      if (await claimLiveSlot(chatId, new Date(start.getTime() + i * 25 * 60_000))) claimed++;
    }
    expect(claimed).toBe(LIVE_MAX_PER_DAY);
    expect(await claimLiveSlot(chatId, new Date("2026-11-25T18:30:00Z"))).toBe(false); // 23:30 тех же суток
    expect(await claimLiveSlot(chatId, new Date("2026-11-25T19:10:00Z"))).toBe(true); // 00:10 следующих суток
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

  it("группа без памяти: молчит, модель не зовётся", async () => {
    await resetGroup({ contextEnabledAt: null });
    expect(await considerLiveChime(input(), vi.fn(async () => true), noon)).toEqual({ kind: "skip", reason: "no-memory" });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("недавний спор в окне: «хорошего вечера» не получает ответа", async () => {
    await prisma.assistantTelegramContext.create({ data: {
      groupChatId: chatId, messageId: 1, text: "Опять штраф за опоздание, надоело", occurredAt: new Date(noon.getTime() - 60_000),
      expiresAt: new Date(noon.getTime() + 86_400_000), authorTelegramId: "1", authorAgentId: null,
      sourceVersion: noon, sourceUpdateId: BigInt(unique), propertyRefs: [],
    } });
    callGemini.mockResolvedValue({ join: true, reply: "Хорошего вечера!" });
    const outcome = await considerLiveChime(input("Всем хорошего вечера"), vi.fn(async () => true), noon);
    expect(outcome).toEqual({ kind: "skip", reason: "topic-window" });
    expect(callGemini).not.toHaveBeenCalled();
    await prisma.assistantTelegramContext.deleteMany({ where: { groupChatId: chatId } });
  });

  // Ревью 26.11.2026: рубильник «отвечает без обращения» выключен — живая реплика тоже молчит.
  it("рубильник «отвечает без обращения» выключен: живая беседа молчит, модель не зовётся", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { shabnamGroupUnaddressedEnabled: false } });
    const deliver = vi.fn(async () => true);
    expect(await considerLiveChime(input(), deliver, noon)).toEqual({ kind: "skip", reason: "unaddressed-off" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("ответ человека человеку: живая реплика не вмешивается", async () => {
    callGemini.mockResolvedValue({ join: true, reply: "Доброе утро!" });
    const deliver = vi.fn(async () => true);
    expect(await considerLiveChime({ ...input(), replyToOtherHuman: true }, deliver, noon)).toEqual({ kind: "skip", reason: "reply-to-human" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("не человек, пересланное, команда: пропуск без модели", async () => {
    const deliver = vi.fn(async () => true);
    expect(await considerLiveChime({ ...input(), isBot: true }, deliver, noon)).toMatchObject({ kind: "skip" });
    expect(await considerLiveChime({ ...input(), isForwarded: true }, deliver, noon)).toMatchObject({ kind: "skip" });
    expect(await considerLiveChime(input("/start"), deliver, noon)).toMatchObject({ kind: "skip" });
    expect(callGemini).not.toHaveBeenCalled();
  });
});
