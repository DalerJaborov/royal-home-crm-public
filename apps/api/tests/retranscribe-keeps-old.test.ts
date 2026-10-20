import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ПЕРЕ-РАСШИФРОВКА НЕ СТИРАЕТ СТАРОЕ ДО НОВОГО (03.10.2026).
 *
 * retranscribeInteraction раньше снимала расшифровку и разбор ДО скачивания
 * записи: станция не отдала файл или поставщик отказал — разговор оставался вовсе
 * без текста и без разбора. Теперь старое снимается только когда новый текст уже
 * получен. И запись консультанта (ИИ) не пере-расшифровывается вовсе: её текст —
 * живая расшифровка разговора, другой нет.
 */
process.env.PBX_RECORDINGS_URL = "http://pbx.test";

const transcribeAudioResult = vi.fn(async (..._args: unknown[]) => ({ text: null as string | null, failed: true }));
vi.mock("../src/ai/transcribe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/transcribe.js")>()),
  transcribeAudioResult: (...args: unknown[]) => transcribeAudioResult(...args),
}));

const { prisma } = await import("../src/db.js");
const { retranscribeInteraction, isLiveVoiceRecording } = await import("../src/lib/telephony/callRecordings.js");
const { liveVoiceRecordingKey } = await import("../src/lib/telephony/liveVoiceBridge.js");

const runId = Date.now();
let clientId = "";
let agentId = "";

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент повтора ${runId}`, phone: `+99294${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Повтор расшифровки ${runId}`, phone: `+99293${String(runId).slice(-7)}`, source: "PHONE_CALL" },
    })
  ).id;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4000) }) as unknown as Response)
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.callAnalysis.deleteMany({ where: { interaction: { clientId } } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("retranscribeInteraction", () => {
  it("ключ записи консультанта узнаётся тем же префиксом, что пишет мост", () => {
    expect(isLiveVoiceRecording(liveVoiceRecordingKey("ch-1", Date.now()))).toBe(true);
    expect(isLiveVoiceRecording("2026/09/24/out-1-1004-20260924-120000-1.mp3")).toBe(false);
  });

  it("запись консультанта (ИИ) — отказ, расшифровка не тронута", async () => {
    const i = await prisma.interaction.create({
      data: { clientId, actorKind: "SYSTEM", type: "CALL", notes: "Ответил консультант", transcript: "Консультант: здравствуйте", recordingUrl: liveVoiceRecordingKey("ch-2", Date.now()) },
    });
    const res = await retranscribeInteraction(i.id);
    expect(res.ok).toBe(false);
    expect(transcribeAudioResult).not.toHaveBeenCalled();
    expect((await prisma.interaction.findUnique({ where: { id: i.id } }))?.transcript).toBe("Консультант: здравствуйте");
  });

  it("поставщик отказал — старая расшифровка и разбор на месте", async () => {
    const i = await prisma.interaction.create({
      data: {
        clientId,
        actorKind: "SYSTEM",
        type: "CALL",
        notes: "Звонок — старое резюме",
        transcript: "Агент: старый текст",
        transcriptRu: "старый перевод",
        recordingUrl: "2026/10/03/in-1-20261003-100000-1.wav",
      },
    });
    await prisma.callAnalysis.create({ data: { interactionId: i.id, agentId, score: 50, objections: [], agreements: [], summary: "старое резюме" } });

    const res = await retranscribeInteraction(i.id);
    expect(res.ok).toBe(false);
    expect(transcribeAudioResult).toHaveBeenCalled();
    const after = await prisma.interaction.findUnique({ where: { id: i.id } });
    expect(after?.transcript).toBe("Агент: старый текст");
    expect(after?.transcriptRu).toBe("старый перевод");
    expect(after?.notes).toBe("Звонок — старое резюме");
    expect(await prisma.callAnalysis.count({ where: { interactionId: i.id } })).toBe(1);
  });
});
