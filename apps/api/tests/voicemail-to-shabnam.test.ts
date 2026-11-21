import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * СООБЩЕНИЕ С АВТООТВЕТЧИКА → ДИРЕКТОРУ В ШАБНАМ (владелец 21.11.2026).
 * Стерегут: уходит только директору с привязанным Telegram; один раз на файл;
 * рубильник voicemailToShabnamEnabled выключает молча; сбой Telegram не роняет разбор.
 * Станция, ИИ и Telegram подменены целиком.
 */

process.env.PBX_RECORDINGS_URL = "http://pbx.test";

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));

const transcribeAudio = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock("../src/ai/transcribe.js", () => ({
  transcribeAudio,
  transcribeAudioResult: vi.fn(async () => ({ text: null, failed: false })),
  isTranscriptionEnabled: vi.fn(async () => true),
  transcribeTimeoutFor: () => 60_000,
  looksLikeModelRefusal: () => false,
}));
vi.mock("../src/ai/translateTranscript.js", () => ({ translateTranscript: vi.fn(async (t: string) => `ru:${t}`), looksTajik: () => false }));
const extractIncomingCallLead = vi.fn();
vi.mock("../src/ai/incomingCallLead.js", () => ({ extractIncomingCallLead }));

const sendHtmlMessage = vi.fn<(chatId: string, html: string) => Promise<unknown>>(async () => ({}));
const sendDocumentFile = vi.fn<(chatId: string, file: unknown, filename: string) => Promise<unknown>>(async () => ({}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  isTelegramEnabled: () => true,
  sendHtmlMessage,
  sendDocumentFile,
}));

const { prisma } = await import("../src/db.js");
const { ingestVoicemails } = await import("../src/lib/telephony/voicemailIngest.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const DIRECTOR_CHAT = `vm-shabnam-dir-${runId}`;
const AGENT_CHAT = `vm-shabnam-agent-${runId}`;
const TRANSCRIPT =
  "Здравствуйте, меня зовут Фируз, я ищу двухкомнатную квартиру в районе Сино, " +
  "бюджет примерно до четырёхсот тысяч сомони, перезвоните пожалуйста.";

let agentId = "";
let directorId = "";
let noChatDirectorId = "";
let settingsBefore: { voicemailToShabnamEnabled: boolean } | null = null;
const createdPhones: string[] = [];
const createdFiles: string[] = [];

function voicemailName(digits: string, at = new Date()): string {
  const local = new Date(at.getTime() + 5 * 60 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `vm-${local.getUTCFullYear()}${p(local.getUTCMonth() + 1)}${p(local.getUTCDate())}-${p(local.getUTCHours())}${p(local.getUTCMinutes())}${p(local.getUTCSeconds())}-${digits}.wav`;
}

function mockStation(files: string[], bytes = 40_000): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/royalhome-voicemail/")) {
        return { ok: true, text: async () => files.map((f) => `<a href="${f}">${f}</a>`).join("\n") } as unknown as Response;
      }
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(bytes) } as unknown as Response;
    })
  );
}

function sentTo(chatId: string): number {
  return sendHtmlMessage.mock.calls.filter((c) => c[0] === chatId).length;
}

function docsTo(chatId: string): number {
  return sendDocumentFile.mock.calls.filter((c) => c[0] === chatId).length;
}

function newMessage(prefix: string): { file: string; phone: string } {
  const digits = `${prefix}${tail.slice(-5)}`;
  const file = voicemailName(digits);
  createdFiles.push(file);
  const phone = `+992${digits}`;
  createdPhones.push(phone);
  mockStation([file]);
  return { file, phone };
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { voicemailToShabnamEnabled: true } });
  agentId = (await prisma.agent.create({ data: { fullName: `Агент VM-Шабнам ${runId}`, phone: `+99296${tail}`, role: "AGENT", passwordHash: "x", isActive: true, telegramChatId: AGENT_CHAT } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: `Директор VM-Шабнам ${runId}`, phone: `+99295${tail}`, role: "DIRECTOR", passwordHash: "x", isActive: true, telegramChatId: DIRECTOR_CHAT } })).id;
  noChatDirectorId = (await prisma.agent.create({ data: { fullName: `Директор без бота ${runId}`, phone: `+99294${tail}`, role: "DIRECTOR", passwordHash: "x", isActive: true } })).id;
});

beforeEach(async () => {
  extractIncomingCallLead.mockReset();
  extractIncomingCallLead.mockResolvedValue({ kind: "BUYER", confident: true, fullName: "Фируз", requirementsNotes: null, desiredDistrictId: null, desiredRooms: 2, desiredType: "APARTMENT", budgetMin: null, budgetMax: 400_000 });
  transcribeAudio.mockReset();
  transcribeAudio.mockResolvedValue(TRANSCRIPT);
  sendHtmlMessage.mockReset();
  sendHtmlMessage.mockResolvedValue({});
  sendDocumentFile.mockReset();
  sendDocumentFile.mockResolvedValue({});
  await prisma.settings.update({ where: { id: "singleton" }, data: { voicemailToShabnamEnabled: true } });
});

afterEach(async () => {
  await prisma.voicemailMessage.deleteMany({ where: { file: { in: createdFiles } } });
  await prisma.incomingCall.deleteMany({ where: { voicemailFile: { in: createdFiles } } });
  createdFiles.length = 0;
  const clients = await prisma.client.findMany({ where: { phone: { in: createdPhones } }, select: { id: true } });
  const ids = clients.map((c) => c.id);
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  createdPhones.length = 0;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId, noChatDirectorId] } } });
  await prisma.$disconnect();
});

describe("Автоответчик → Шабнам директору", () => {
  it("директору с привязанным Telegram уходит текст с полным номером, временем Душанбе и расшифровкой, затем файл; агенту нет", async () => {
    const { file, phone } = newMessage("9381");
    expect(await ingestVoicemails()).toBe(1);

    expect(sentTo(DIRECTOR_CHAT)).toBe(1);
    expect(sentTo(AGENT_CHAT)).toBe(0);
    const html = sendHtmlMessage.mock.calls.find((c) => c[0] === DIRECTOR_CHAT)![1];
    expect(html).toContain(phone);
    expect(html).toContain("(Душанбе)");
    expect(html).toContain(`ru:${TRANSCRIPT.slice(0, 40)}`);
    expect(html).not.toContain("—");
    expect(docsTo(DIRECTOR_CHAT)).toBe(1);
    expect(sendDocumentFile.mock.calls.find((c) => c[0] === DIRECTOR_CHAT)![2]).toBe(file);
    expect(docsTo(AGENT_CHAT)).toBe(0);
  });

  it("повторный проход по тому же файлу второго сообщения не шлёт", async () => {
    newMessage("9382");
    expect(await ingestVoicemails()).toBe(1);
    expect(sentTo(DIRECTOR_CHAT)).toBe(1);
    expect(await ingestVoicemails()).toBe(0);
    expect(sentTo(DIRECTOR_CHAT)).toBe(1);
    expect(docsTo(DIRECTOR_CHAT)).toBe(1);
  });

  it("рубильник выключен: ничего не уходит, разбор идёт как обычно", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { voicemailToShabnamEnabled: false } });
    const { file } = newMessage("9383");
    expect(await ingestVoicemails()).toBe(1);
    expect(sentTo(DIRECTOR_CHAT)).toBe(0);
    expect(docsTo(DIRECTOR_CHAT)).toBe(0);
    expect((await prisma.voicemailMessage.findUnique({ where: { file } }))?.processedAt).not.toBeNull();
  });

  it("сбой Telegram не роняет разбор: сообщение обработано, карточка заведена", async () => {
    sendHtmlMessage.mockRejectedValue(new Error("telegram down"));
    const { file, phone } = newMessage("9384");
    expect(await ingestVoicemails()).toBe(1);
    expect((await prisma.voicemailMessage.findUnique({ where: { file } }))?.processedAt).not.toBeNull();
    expect(await prisma.client.findFirst({ where: { phone } })).not.toBeNull();
  });

  it("не вышел файл: текст уже ушёл, разбор цел", async () => {
    sendDocumentFile.mockRejectedValue(new Error("upload failed"));
    const { file } = newMessage("9385");
    expect(await ingestVoicemails()).toBe(1);
    expect(sentTo(DIRECTOR_CHAT)).toBe(1);
    expect((await prisma.voicemailMessage.findUnique({ where: { file } }))?.processedAt).not.toBeNull();
  });
});
