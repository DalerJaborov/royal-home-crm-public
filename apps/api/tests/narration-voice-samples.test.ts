import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * ОБРАЗЦЫ ГОЛОСОВ (11.11.2026): одна фраза каждым голосом, платно ОДИН раз на голос + модель +
 * текст фразы, в общем дневном потолке; прослушивание — бесплатно, любому сотруднику;
 * готовит только руководство. ElevenLabs подменён (fetch), база и файлы настоящие.
 */
const s = vi.hoisted(() => ({ role: "DIRECTOR" }));
vi.mock("../src/auth/middleware.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/auth/middleware.js")>(),
  requireAuth: (req: any, _res: any, next: () => void) => { req.agent = { id: "staff", role: s.role }; next(); } }));
vi.mock("../src/ai/liveVoiceProvider.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/liveVoiceProvider.js")>(), resolveElevenLabsKey: () => "test-key" }));

const { prisma } = await import("../src/db.js");
const { generateVoiceSamples, readyVoiceSamples, narrationBudgetUsage, NARRATION_SAMPLE_FOLDER } = await import("../src/lib/narrationGeneration.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { narrationRouter } = await import("../src/routes/properties/narration.js");
const { NARRATION_VOICE_SAMPLE_TEXT } = await import("@royal-home/shared");

const runId = Date.now().toString(36);
const voices = [{ id: `vA-${runId}`, name: "Мадина", gender: "female" as const }, { id: `vB-${runId}`, name: "Фирӯз", gender: "male" as const }];
const config = { modelId: "eleven_v4", voices, templates: [
  { id: "tg-s", name: "Т", lang: "tg" as const, text: "{вид} барои фурӯш. Масоҳаташ {площадь} метри мураббаъ." },
  { id: "ru-s", name: "Р", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров." },
], dailyCharLimit: 1_000_000, dailyGenerationLimit: 1000 };
let settingsBefore: unknown = null;

const audioFetch = () => vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  void init;
  return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg", "request-id": "r1" } });
});
const app = express(); app.use(express.json()); app.use("/properties", narrationRouter);

beforeAll(async () => {
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? {};
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", propertyNarrationConfig: config }, update: { propertyNarrationConfig: config } });
});
afterAll(async () => {
  const rows = await prisma.narrationVoiceSample.findMany({ where: { voiceId: { endsWith: runId } }, select: { storageKey: true } });
  for (const r of rows) if (r.storageKey) await fs.rm(localVideoFilePath(r.storageKey)!, { force: true });
  await prisma.narrationVoiceSample.deleteMany({ where: { voiceId: { endsWith: runId } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: settingsBefore as object } });
});

describe("образцы голосов", () => {
  it("готовятся один раз на голос и язык фразы; повтор не платит; считаются в дневном потолке", async () => {
    const before = await narrationBudgetUsage();
    const fetcher = audioFetch();
    const first = await generateVoiceSamples({ config, key: "test-key", actorId: "staff", fetcher });
    expect(first).toMatchObject({ created: 4, existing: 0, failed: 0, budget: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text as string);
    expect(bodies).toContain(NARRATION_VOICE_SAMPLE_TEXT.ru);
    // Фраза владельца 12.11.2026 (NARRATION_VOICE_SAMPLE_TEXT.tg), числа уже словами.
    expect(bodies.some((t) => t.startsWith("Ассалому алайкум! Хонаи се ҳуҷра"))).toBe(true);
    const after = await narrationBudgetUsage();
    expect(after.usedGenerations - before.usedGenerations).toBeGreaterThanOrEqual(4);
    expect(after.usedChars - before.usedChars).toBeGreaterThanOrEqual(2 * (NARRATION_VOICE_SAMPLE_TEXT.ru.length + NARRATION_VOICE_SAMPLE_TEXT.tg.length));

    const again = audioFetch();
    expect(await generateVoiceSamples({ config, key: "test-key", actorId: "staff", fetcher: again })).toMatchObject({ created: 0, existing: 4 });
    expect(again).not.toHaveBeenCalled();
    const ready = await readyVoiceSamples(config);
    expect(ready).toHaveLength(4);
    expect(ready.every((r) => r.storageKey.startsWith(`${NARRATION_SAMPLE_FOLDER}/`))).toBe(true);
    // Другая модель — другой звук: прежние образцы ей не подходят.
    expect(await readyVoiceSamples({ ...config, modelId: "eleven_v4_turbo" })).toHaveLength(0);
  });

  it("дневной потолок исчерпан — новый образец не заказывается", async () => {
    const used = await narrationBudgetUsage();
    const fetcher = audioFetch();
    const extra = { ...config, voices: [...voices, { id: `vC-${runId}`, name: "Третий" }], dailyGenerationLimit: used.usedGenerations };
    const report = await generateVoiceSamples({ config: extra, key: "test-key", actorId: "staff", fetcher });
    expect(report.budget).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("прослушать может любой сотрудник без затрат; готовит только руководство", async () => {
    s.role = "AGENT";
    const ok = await request(app).get(`/properties/narration-voice-samples/${voices[0].id}/tg`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("audio/mpeg");
    expect((await request(app).get(`/properties/narration-voice-samples/nobody-${runId}/tg`)).status).toBe(404);
    expect((await request(app).post("/properties/narration-voice-samples/prepare").send({ confirmed: true })).status).toBe(403);
    const options = await request(app).get("/properties/narration-options");
    expect(options.body.samples).toEqual(expect.arrayContaining([{ voiceId: voices[0].id, lang: "tg" }, { voiceId: voices[1].id, lang: "ru" }]));
    s.role = "DIRECTOR";
    const prepared = await request(app).post("/properties/narration-voice-samples/prepare").send({ confirmed: true });
    expect(prepared.status).toBe(200);
    expect(prepared.body).toMatchObject({ created: 0, existing: 4 });
    expect(path.basename(localVideoFilePath((await readyVoiceSamples(config))[0].storageKey)!)).toMatch(/\.mp3$/);
  });
});
