import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПОДСКАЗКА ПО ПРИМЕТАМ ОБЪЕКТА — КРОН (24.09.2026, перевод агенту объекта).
 *
 * Синтез подменён: проверяем решения вокруг него — какие объекты озвучиваются, на
 * каком языке (агента, который ведёт объект), что пересобирается при правке
 * карточки и что исчезает, когда объект продан. И что станция видит файл в
 * манифесте.
 */

const synth = vi.hoisted(() => ({ calls: [] as { parts: string[]; language: string; fileName: string }[] }));
vi.mock("../src/lib/telephony/whisperClips.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/whisperClips.js")>()),
  assembleWhisper: async (parts: string[], o: { language: string; fileName: string }) => {
    synth.calls.push({ parts, language: o.language, fileName: o.fileName });
    return { durationMs: 3000, synthesized: 0, skipped: 0 };
  },
  whisperPiecesOnCooldown: () => 0,
}));
vi.mock("../src/lib/telephony/whisperAudio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/whisperAudio.js")>()),
  whisperFilesExist: async () => true,
  removeWhisperFiles: async () => undefined,
}));
vi.mock("../src/ai/tts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/tts.js")>()),
  ttsQuotaPausedUntil: async () => null,
}));
vi.mock("../src/lib/telephony/whisperSync.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/telephony/whisperSync.js")>();
  return { ...real, loadWhisperSettings: async () => ({ ...(await real.loadWhisperSettings()), enabled: true, language: "tg" }) };
});

const { prisma } = await import("../src/db.js");
const { syncPropertyWhispers, propertyWhisperFile } = await import("../src/lib/telephony/propertyWhisper.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36);
let ruAgent = "";
let offAgent = "";
const ids: string[] = [];

async function property(agentId: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Подсказка объекта ${runId}`,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 90,
      price: 120_000,
      currency: "USD",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
      landmark: "Садбарг",
      ...extra,
    },
    select: { id: true },
  });
  ids.push(p.id);
  return p.id;
}

beforeAll(async () => {
  ruAgent = await createTestAgent("Агент Русский");
  offAgent = await createTestAgent("Агент Без Подсказок");
  await prisma.agent.update({ where: { id: ruAgent }, data: { whisperLanguage: "ru" } });
  await prisma.agent.update({ where: { id: offAgent }, data: { whisperLanguage: "off" } });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await deleteAgentsWithTraces([ruAgent, offAgent]);
});

beforeEach(() => {
  synth.calls.length = 0;
});

describe("подсказки по объектам", () => {
  it("озвучивает объект на языке его агента; агенту с «off» — нет", async () => {
    const mine = await property(ruAgent);
    const silent = await property(offAgent);
    const result = await syncPropertyWhispers({ propertyIds: [mine, silent] });

    expect(result.rendered).toBe(1);
    expect(synth.calls[0]).toMatchObject({ language: "ru" });
    expect(synth.calls[0]!.parts).toEqual(expect.arrayContaining(["3-комнатная квартира", "90 квадратов", "ориентир Садбарг"]));
    expect(await propertyWhisperFile({ propertyId: mine, agentWhisperLanguage: "ru" })).toBe(synth.calls[0]!.fileName);
    expect(await prisma.propertyWhisper.count({ where: { propertyId: silent } })).toBe(0);

    // Повторный проход без правок — ничего не пересобирает.
    synth.calls.length = 0;
    await syncPropertyWhispers({ propertyIds: [mine, silent] });
    expect(synth.calls).toEqual([]);
  });

  it("правка карточки пересобирает тот же файл; продан — подсказка убрана", async () => {
    const id = await property(ruAgent);
    await syncPropertyWhispers({ propertyIds: [id] });
    const first = await prisma.propertyWhisper.findFirstOrThrow({ where: { propertyId: id } });

    await prisma.property.update({ where: { id }, data: { price: 110_000 } });
    synth.calls.length = 0;
    await syncPropertyWhispers({ propertyIds: [id] });
    expect(synth.calls).toHaveLength(1);
    expect(synth.calls[0]!.parts).toContain("110 тысяч долларов");
    const second = await prisma.propertyWhisper.findFirstOrThrow({ where: { propertyId: id } });
    expect(second.fileName).toBe(first.fileName);
    expect(second.digest).not.toBe(first.digest);

    await prisma.property.update({ where: { id }, data: { status: "SOLD", soldAt: new Date() } });
    const removed = await syncPropertyWhispers({ propertyIds: [id] });
    expect(removed.removed).toBe(1);
    expect(await prisma.propertyWhisper.count({ where: { propertyId: id } })).toBe(0);
  });
});
