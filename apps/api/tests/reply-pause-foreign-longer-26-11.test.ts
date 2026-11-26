import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ЧУЖУЮ БОЛЕЕ ДЛИННУЮ ПАУЗУ ВЫБРАННЫЙ ПРИ ОТВЕТЕ СРОК НЕ УКОРАЧИВАЕТ (ревью PR #463, 26.11.2026).
 * Директор нажал «Пауза бессрочно», агент ответил с умолчанием «1 час» — бот не должен вернуться через час.
 * Свою же паузу сотрудник меняет как выбрал. Три пути: текст, голосовое, фото/видео.
 */

const { sendMessage, sendAudio, sendImage } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => "wamid.t"),
  sendAudio: vi.fn(async () => "wamid.a"),
  sendImage: vi.fn(async () => "wamid.i"),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  sendMessage, sendAudio, sendImage,
  isMetaChannelEnabled: vi.fn(async () => true),
}));
vi.mock("../src/lib/audioTranscode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audioTranscode.js")>()),
  transcodeToOggOpus: vi.fn(async () => Buffer.from("ogg")),
  transcodeToM4a: vi.fn(async () => Buffer.from("m4a")),
  isSilentAudio: vi.fn(async () => false),
}));
vi.mock("../src/ai/transcribe.js", () => ({ transcribeAudio: vi.fn(async () => "Здравствуйте") }));
vi.mock("../src/ai/voiceComplianceGuard.js", () => ({ checkAgentVoiceMessage: vi.fn(async () => ({ blocked: false })) }));
vi.mock("../src/lib/outgoingVoice.js", () => ({ saveOutgoingVoice: vi.fn(async () => "/uploads/msg-voice/t.ogg") }));
vi.mock("../src/lib/voiceSecurityAlert.js", () => ({ alertVoiceViolation: vi.fn(async () => {}) }));
vi.mock("../src/lib/outgoingMedia.js", () => ({ uploadOutgoingMedia: vi.fn(async (id: string, _s: unknown, ext: string) => `chat-media/${id}/t.${ext}`) }));
vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  r2PresignDownloadUrl: vi.fn(async (key: string) => `https://r2.test/${key}`),
  isR2Configured: vi.fn(() => true),
}));
process.env.CRM_PUBLIC_URL = "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { deliverToConversation, deliverVoiceToConversation, deliverMediaToConversation } = await import("../src/lib/conversationDelivery.js");

let fixture: CustomerMessengerFixture;
const runId = Date.now().toString(36);
const ids: string[] = [];
const TEN_YEARS = 10 * 365 * 24 * 3_600_000;
const agentA = { kind: "agent" as const, agentId: `agent-a-${runId}`, agentName: "А" };
const agentB = { kind: "agent" as const, agentId: `agent-b-${runId}`, agentName: "Б" };
const hour = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => { fixture = await createCustomerMessengerFixture("INSTAGRAM"); });
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  await fixture?.dispose();
});

async function pausedByOther() {
  const c = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM", accountId: fixture.id, endpointScopeId: fixture.transport.endpointScopeId,
      subscriberId: `foreign-${runId}-${ids.length}`,
      messages: [{ role: "user", content: "Здравствуйте", at: new Date().toISOString() }],
      pausedUntil: new Date(Date.now() + TEN_YEARS), botPausedAt: new Date(Date.now() - 3_600_000),
    },
  });
  ids.push(c.id);
  return c;
}
const targetOf = (c: { id: string; channel: string; subscriberId: string }) =>
  ({ kind: "bot" as const, id: c.id, channel: c.channel, subscriberId: c.subscriberId, accountId: fixture.id, transport: fixture.transport });
const pauseOf = async (id: string) => (await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { pausedUntil: true } })).pausedUntil!.getTime();

type Sender = (c: Awaited<ReturnType<typeof pausedByOther>>, sender: typeof agentA, until: Date) => Promise<{ ok: boolean }>;
const paths: Record<string, Sender> = {
  "текст": (c, sender, until) => deliverToConversation(targetOf(c), "Здравствуйте", until, { sender }),
  "голосовое": (c, sender, until) => deliverVoiceToConversation(targetOf(c), { buffer: Buffer.from("x") }, { sender, pausedUntilOverride: until }),
  "фото": (c, sender, until) => deliverMediaToConversation(targetOf(c), { buffer: Buffer.from("x"), mimetype: "image/jpeg", originalname: "a.jpg" }, { sender, pausedUntilOverride: until }),
};

for (const [name, send] of Object.entries(paths)) {
  describe(`${name}: выбранный срок и чужая пауза`, () => {
    it("пауза, поставленная не этим сотрудником и более длинная, не укорачивается", async () => {
      const c = await pausedByOther();
      const before = await pauseOf(c.id);
      expect((await send(c, agentA, hour())).ok).toBe(true);
      expect(await pauseOf(c.id)).toBe(before);
    });

    it("свою паузу сотрудник меняет как выбрал; чужой агент её уже не укорачивает", async () => {
      const c = await pausedByOther();
      await prisma.botConversation.update({ where: { id: c.id }, data: { pausedUntil: null, botPausedAt: null } });
      // А выбрал «бессрочно» — пауза его.
      expect((await send(c, agentA, new Date(Date.now() + TEN_YEARS))).ok).toBe(true);
      // Б с умолчанием «1 час» чужую длинную паузу не трогает.
      expect((await send(c, agentB, hour())).ok).toBe(true);
      expect(await pauseOf(c.id)).toBeGreaterThan(Date.now() + 9 * 365 * 24 * 3_600_000);
      // А сам выбрал час — меняется.
      expect((await send(c, agentA, hour())).ok).toBe(true);
      expect(await pauseOf(c.id)).toBeLessThan(Date.now() + 2 * 3_600_000);
    });

    it("более длинный выбор по-прежнему продлевает чужую короткую паузу", async () => {
      const c = await pausedByOther();
      const short = new Date(Date.now() + 10 * 60_000);
      await prisma.botConversation.update({ where: { id: c.id }, data: { pausedUntil: short } });
      expect((await send(c, agentA, hour())).ok).toBe(true);
      expect(await pauseOf(c.id)).toBeGreaterThan(short.getTime() + 30 * 60_000);
    });
  });
}
