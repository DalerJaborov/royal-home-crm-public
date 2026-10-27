import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ detail: vi.fn(), phone: vi.fn(), sendPhoto: vi.fn(), sendMessage: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceClient.js", () => ({ fetchSomon: mocks.detail, SomonSourceUnavailable: class SomonSourceUnavailable extends Error { reason = "not_ready"; } }));
vi.mock("../src/lib/somonLeads/phone.js", () => ({ fetchSomonPhone: mocks.phone }));
vi.mock("../src/telegram/api.js", () => ({ sendPhoto: mocks.sendPhoto, sendMessage: mocks.sendMessage, TelegramApiError: class TelegramApiError extends Error { constructor(public errorCode: number) { super("Telegram rejected"); } } }));
vi.mock("../src/lib/systemError.js", () => ({ logSystemError: vi.fn().mockResolvedValue(undefined) }));
import { prisma } from "../src/db.js";
import { processSomonPending } from "../src/lib/somonLeads/processPending.js";
import { sendReservedSomon } from "../src/lib/somonLeads/sendReserved.js";
import { reserveSomonDelivery } from "../src/lib/somonLeads/deliveryStore.js";
import { somonKeyFingerprint } from "../src/lib/somonLeads/contactIdentity.js";
const agentId = "stand-somon-process-agent";
const adIds = ["987651001", "987651002", "987651003", "987651004", "987651005", "987651006", "987651007"];
let previousMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;
let previousRecipients: Awaited<ReturnType<typeof prisma.somonRecipient.findMany>> = [];
const fakeCard = (id: string, description = "Собственник") => ({ id: Number(id), name: "Квартира", description, price: { price: "100 c." }, location: { name: "Душанбе" }, gallery: { preview: ["https://cdntj.somon.tj/stand.jpg"] }, user: { name: "Продавец", active_adverts: "1 активное объявление", is_business_account: false, is_company: false }, categories: [{ slug: "nedvizhimost" }, { slug: "prodazha-kvartir" }], is_closed: false });
describe("Somon pending flow on isolated database", () => {
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
    previousMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    previousRecipients = await prisma.somonRecipient.findMany();
    await prisma.somonRecipient.deleteMany();
    await prisma.somonContactReceipt.deleteMany({ where: { agentId } });
    await prisma.somonDelivery.deleteMany({ where: { advertId: { in: adIds } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: adIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.agent.create({ data: { id: agentId, fullName: "Stand Agent", phone: "stand-somon-process", telegramChatId: "stand-chat-process", role: "AGENT" } });
    await prisma.somonRecipient.create({ data: { agentId, position: 1 } });
    const baseline = new Date(Date.now() - 60_000);
    await prisma.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", enabled: true, activatedAt: baseline, baselineAt: baseline }, update: { enabled: true, activatedAt: baseline, baselineAt: baseline, lastAssignedAgentId: null } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint(), sourceStopped: false } });
    await prisma.somonSeenAdvert.createMany({ data: adIds.map(advertId => ({ advertId, slug: `${advertId}_stand`, status: "PENDING", baseline: false })) });
  });
  beforeEach(() => { vi.clearAllMocks(); mocks.phone.mockImplementation(async (id: string) => `+992${String(900000000 + adIds.indexOf(id))}`); mocks.sendPhoto.mockResolvedValue({ message_id: 1, chat: { id: "stand-chat-process" } }); mocks.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "stand-chat-process" } }); });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonContactReceipt.deleteMany({ where: { agentId } });
    await prisma.somonDelivery.deleteMany({ where: { advertId: { in: adIds } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: adIds } } });
    await prisma.somonRecipient.deleteMany();
    if (previousRecipients.length) await prisma.somonRecipient.createMany({ data: previousRecipients });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    if (previousMonitor) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: previousMonitor });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });
  it("sends one date-warning card even if two workers race", async () => {
    mocks.detail.mockImplementation(async () => new Response(JSON.stringify(fakeCard(adIds[0]))));
    const results = await Promise.all([processSomonPending(adIds[0], async () => {}), processSomonPending(adIds[0], async () => {})]);
    expect(results.filter(x => x === "sent")).toHaveLength(1);
    expect(mocks.sendPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.sendPhoto.mock.calls[0][2]).toContain("Проверить дату");
    expect((await prisma.somonDelivery.findUnique({ where: { advertId: adIds[0] } }))?.status).toBe("ACCEPTED");
  });
  it("never retries an uncertain Telegram send", async () => {
    mocks.detail.mockResolvedValue(new Response(JSON.stringify(fakeCard(adIds[1]))));
    mocks.sendPhoto.mockRejectedValue(new Error("timeout"));
    expect(await processSomonPending(adIds[1], async () => {})).toBe("unknown");
    expect(await processSomonPending(adIds[1], async () => {})).toBe("skipped");
    expect(mocks.sendPhoto).toHaveBeenCalledTimes(1);
  });
  it("does not send an agency profile", async () => {
    const value = fakeCard(adIds[2]); value.user.is_business_account = true;
    mocks.detail.mockResolvedValue(new Response(JSON.stringify(value)));
    expect(await processSomonPending(adIds[2], async () => {})).toBe("skipped");
    expect(mocks.phone).not.toHaveBeenCalled();
    expect(mocks.sendPhoto).not.toHaveBeenCalled();
  });
  it("does not claim delivery when Telegram returns an incomplete receipt", async () => {
    mocks.detail.mockResolvedValue(new Response(JSON.stringify(fakeCard(adIds[3]))));
    mocks.sendPhoto.mockResolvedValue({});
    expect(await processSomonPending(adIds[3], async () => {})).toBe("unknown");
    expect((await prisma.somonDelivery.findUnique({ where: { advertId: adIds[3] } }))?.status).toBe("UNKNOWN");
  });
  it("disables the recipient when Telegram explicitly rejects the bot", async () => {
    const { TelegramApiError } = await import("../src/telegram/api.js");
    mocks.detail.mockImplementation(async () => new Response(JSON.stringify(fakeCard(adIds[4]))));
    mocks.sendPhoto.mockRejectedValue(new TelegramApiError(403, "sendPhoto", "stand blocked"));
    expect(await processSomonPending(adIds[4], async () => {})).toBe("unknown");
    expect((await prisma.somonRecipient.findUnique({ where: { agentId } }))?.enabled).toBe(false);
    expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: adIds[4] } }))?.status).toBe("PENDING");
    await prisma.somonRecipient.update({ where: { agentId }, data: { enabled: true } });
    mocks.sendPhoto.mockResolvedValue({ message_id: 2, chat: { id: "stand-chat-process" } });
    expect(await processSomonPending(adIds[4], async () => {})).toBe("sent");
  });
  it("does not start a reserved send after monitoring is stopped", async () => {
    const reservation = await reserveSomonDelivery(adIds[5], "+992900000005", { kind: "uncertain" });
    expect(reservation.status).toBe("reserved");
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: false } });
    expect(await sendReservedSomon(adIds[5], agentId, "stand-chat-process", "test", null)).toBe("cancelled");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true } });
    expect((await reserveSomonDelivery(adIds[5], "+992900000005", { kind: "uncertain" })).status).toBe("reserved");
  });
  it("waits for an in-flight send before completing a stop", async () => {
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true } });
    mocks.detail.mockResolvedValue(new Response(JSON.stringify(fakeCard(adIds[6]))));
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    mocks.sendPhoto.mockImplementation(() => new Promise(resolve => { release = () => resolve({ message_id: 1, chat: { id: "stand-chat-process" } }); started(); }));
    const sending = processSomonPending(adIds[6], async () => {});
    await startedPromise;
    let stopped = false;
    const stop = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
      await tx.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: false } });
      stopped = true;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    release();
    expect(await sending).toBe("sent");
    await stop;
    expect(stopped).toBe(true);
  });
});


