import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * «Кому подходит объект» в Telegram и «Предложить коллеге» (решение владельца
 * 10.11.2026): чужой клиент — без имени и телефона, повторное предложение не
 * шлётся второй раз, владельцу без Telegram — уведомление в CRM, руководство
 * видит всех полностью, процента совпадения нет. Подбор подменён (его правила —
 * routes/matching.ts, здесь проверяется, кто что видит); база настоящая.
 */
const { sendHtmlMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText, findMatching } = vi.hoisted(() => ({
  sendHtmlMessage: vi.fn(async (_c: string, _h: string, _r?: number, _b?: unknown) => ({})),
  sendMessageWithButtons: vi.fn(async (_c: string, _t: string, _b: unknown) => ({ message_id: 700 })),
  answerCallbackQuery: vi.fn(async (_id: string, _text?: string) => ({})),
  editMessageText: vi.fn(async () => {}),
  findMatching: vi.fn(),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendHtmlMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText,
}));
vi.mock("../src/routes/matching.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/matching.js")>()),
  findMatchingClients: findMatching,
}));

const { prisma } = await import("../src/db.js");
const { loadAgentAccess } = await import("../src/auth/middleware.js");
const { sendPropertyMatchesCard, handlePropertyOfferCallback } = await import("../src/telegram/assistantPropertyOffers.js");
const { formatClientCode } = await import("@royal-home/shared");

const runId = String(Date.now()).slice(-7);
const ag: Record<string, { id: string; chatId: string | null; fullName: string }> = {};
const cl: Record<string, { id: string; shortId: number; fullName: string; assignedAgentId: string }> = {};
let propertyId = "";
let propertyShortId = 0;
let districtId = "";
let callbackId = 1;

async function mkAgent(key: string, n: number, role: string, withTelegram = true) {
  const chatId = withTelegram ? String(830_000_000 + Number(runId) * 10 + n) : null;
  const fullName = `${key === "umed" ? "Умед" : key} ${runId}`;
  const agent = await prisma.agent.create({ data: {
    fullName, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: role as "AGENT",
    passwordHash: await bcrypt.hash("testpass123", 4), telegramUserId: chatId, telegramChatId: chatId,
  } });
  ag[key] = { id: agent.id, chatId, fullName };
}
async function mkClient(key: string, agentKey: string, phoneTail: string) {
  const fullName = `Покупатель ${key} +992 93 ${phoneTail}`;
  const client = await prisma.client.create({ data: {
    fullName, phone: `+99293${runId.slice(0, 3)}${phoneTail.replace(/\D/g, "")}`.slice(0, 13), source: "WEBSITE", kind: "BUYER",
    acceptedAt: new Date(), assignedAgentId: ag[agentKey].id, budgetMax: 90_000, currency: "USD", desiredRooms: 2, desiredDistrictId: districtId,
  } as never });
  cl[key] = { id: client.id, shortId: client.shortId, fullName, assignedAgentId: ag[agentKey].id };
}
const viewerOf = async (key: string) => {
  const access = (await loadAgentAccess(ag[key].id))!;
  return { agent: { ...access, id: ag[key].id, can: (p: string) => access.permissions.has(p as never) } } as never;
};
const press = (key: string, data: string) => handlePropertyOfferCallback({
  id: `cb-${runId}-${callbackId++}`, data, from: { id: Number(ag[key].chatId) },
  message: { chat: { id: Number(ag[key].chatId), type: "private" }, message_id: 900, text: "Предложение" },
} as never);
const lastAnswer = () => String(answerCallbackQuery.mock.calls.at(-1)?.[1] ?? "");

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Сино ${runId}` } })).id;
  await mkAgent("author", 1, "AGENT");
  await mkAgent("umed", 2, "AGENT");
  await mkAgent("silent", 3, "AGENT", false);
  await mkAgent("boss", 4, "DIRECTOR");
  await mkAgent("stranger", 5, "AGENT");
  await mkClient("own", "author", "111 11 11");
  await mkClient("umeds", "umed", "222 22 22");
  await mkClient("silents", "silent", "333 33 33");
  const property = await prisma.property.create({ data: {
    type: "APARTMENT", areaSqm: 64, rooms: 2, price: 85_000, currency: "USD", districtId, address: `Улица ${runId}`,
    title: `Подбор ${runId}`, condition: "GOOD", status: "AVAILABLE", createdById: ag.author.id, intakeAgentId: ag.author.id,
  } });
  propertyId = property.id;
  propertyShortId = property.shortId;
  const item = (key: string, agentKey: string) => ({
    id: cl[key].id, shortId: cl[key].shortId, fullName: cl[key].fullName, status: "NEW", score: 92,
    reasons: ["район совпал", "в бюджете"], assignedAgentId: ag[agentKey].id, assignedAgentName: ag[agentKey].fullName,
  });
  const all = [item("umeds", "umed"), item("own", "author"), item("silents", "silent")];
  findMatching.mockImplementation(async (_p: string, _limit: number, scope: { assignedAgentId?: string; clientId?: string } = {}) => {
    const items = all.filter(c => (!scope.assignedAgentId || c.assignedAgentId === scope.assignedAgentId) && (!scope.clientId || c.id === scope.clientId));
    return { items, total: items.length };
  });
});

beforeEach(() => {
  for (const m of [sendHtmlMessage, sendMessageWithButtons, answerCallbackQuery, editMessageText]) m.mockClear();
});

afterAll(async () => {
  const ids = Object.values(ag).map(a => a.id);
  await prisma.propertyClientOffer.deleteMany({ where: { propertyId } });
  await prisma.notification.deleteMany({ where: { agentId: { in: ids } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: Object.values(cl).map(c => c.id) } } });
  await prisma.district.delete({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});

describe("кому подходит объект в Telegram", () => {
  it("агенту: свои полностью, чужие без имени и телефона, без процента, с причинами и кнопкой", async () => {
    await sendPropertyMatchesCard(ag.author.chatId!, await viewerOf("author"), propertyId, "ru");
    const [, html, , buttons] = sendHtmlMessage.mock.calls.at(-1)!;
    expect(html).toContain("🎯 Подходит 3 клиентам");
    expect(html.indexOf("⭐ Ваши")).toBeLessThan(html.indexOf("👥 У коллег"));
    expect(html).toContain(cl.own.fullName.split(" +")[0]);
    expect(html).toContain(formatClientCode(cl.umeds.shortId));
    expect(html).toContain(`ведёт ${ag.umed.fullName}`);
    expect(html).not.toContain("Покупатель umeds");
    expect(html).not.toContain("222 22 22");
    expect(html).not.toContain("%");
    expect(html).toContain("✅ район совпал");
    expect(html).toContain("💰 до $90");
    expect(html).toContain(`📍 Сино ${runId}`);
    const offer = (buttons as { callback_data: string; text: string }[][]).flat();
    expect(offer.map(b => b.callback_data)).toContain(`pdo:${propertyShortId}:${cl.umeds.shortId}`);
    expect(offer.some(b => b.callback_data.endsWith(`:${cl.own.shortId}`))).toBe(false);
  });

  it("руководству — все клиенты с именами", async () => {
    await sendPropertyMatchesCard(ag.boss.chatId!, await viewerOf("boss"), propertyId, "ru");
    const html = String(sendHtmlMessage.mock.calls.at(-1)![1]);
    expect(html).toContain("Покупатель umeds");
    expect(html).toContain("Покупатель silents");
  });
});

describe("предложить коллеге", () => {
  it("одно сообщение владельцу клиента в Telegram; повторное нажатие не шлёт второй раз", async () => {
    await press("author", `pdo:${propertyShortId}:${cl.umeds.shortId}`);
    expect(sendMessageWithButtons).toHaveBeenCalledTimes(1);
    const [chatId, text, buttons] = sendMessageWithButtons.mock.calls[0];
    expect(chatId).toBe(ag.umed.chatId);
    expect(text).toContain(`${ag.author.fullName} предлагает объект`);
    expect(text).toContain("Клиенту ничего не отправлено");
    expect(JSON.stringify(buttons)).toContain("pdr:s:");
    expect(lastAnswer()).toContain(ag.umed.fullName);
    await press("author", `pdo:${propertyShortId}:${cl.umeds.shortId}`);
    expect(sendMessageWithButtons).toHaveBeenCalledTimes(1);
    expect(lastAnswer()).toContain("Уже предлагали");
    expect(await prisma.propertyClientOffer.count({ where: { propertyId, clientId: cl.umeds.id } })).toBe(1);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: cl.umeds.id } })).assignedAgentId).toBe(ag.umed.id);
  });

  it("владелец клиента отвечает один раз", async () => {
    const offer = await prisma.propertyClientOffer.findFirstOrThrow({ where: { propertyId, clientId: cl.umeds.id } });
    await press("umed", `pdr:s:${offer.id}`);
    expect((await prisma.propertyClientOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("WILL_SEND");
    await press("umed", `pdr:n:${offer.id}`);
    expect(lastAnswer()).toContain("Уже отвечено");
    await press("author", `pdr:n:${offer.id}`);
    expect((await prisma.propertyClientOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("WILL_SEND");
  });

  it("владельцу без Telegram — уведомление в CRM", async () => {
    await press("author", `pdo:${propertyShortId}:${cl.silents.shortId}`);
    expect(sendMessageWithButtons).not.toHaveBeenCalled();
    const offer = await prisma.propertyClientOffer.findFirstOrThrow({ where: { propertyId, clientId: cl.silents.id } });
    expect(offer.channel).toBe("CRM");
    expect(await prisma.notification.count({ where: { agentId: ag.silent.id, kind: "property-offer" } })).toBe(1);
  });

  it("предложить чужой объект и своего клиента нельзя", async () => {
    await press("stranger", `pdo:${propertyShortId}:${cl.umeds.shortId}`);
    expect(lastAnswer()).toContain("чей это объект");
    await press("author", `pdo:${propertyShortId}:${cl.own.shortId}`);
    expect(lastAnswer()).toContain("ваш клиент");
    expect(sendMessageWithButtons).not.toHaveBeenCalled();
  });
});
