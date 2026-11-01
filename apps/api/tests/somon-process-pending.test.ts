import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ detail: vi.fn(), phone: vi.fn(), sendPhoto: vi.fn(), sendMessage: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceClient.js", () => ({ fetchSomon: mocks.detail, SomonSourceUnavailable: class SomonSourceUnavailable extends Error { reason = "not_ready"; } }));
vi.mock("../src/lib/somonLeads/phone.js", () => ({ fetchSomonPhone: mocks.phone }));
vi.mock("../src/telegram/api.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/telegram/api.js")>()), sendPhoto: mocks.sendPhoto, sendMessage: mocks.sendMessage }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn().mockResolvedValue(undefined) }));
import { prisma } from "../src/db.js";
import { processSomonPending } from "../src/lib/somonLeads/processPending.js";
import { sendReservedSomon } from "../src/lib/somonLeads/sendReserved.js";
import { reserveSomonDelivery } from "../src/lib/somonLeads/deliveryStore.js";
import { rekeySellerPage } from "../src/lib/somonLeads/discoveryStore.js";
import { somonKeyFingerprint, somonSellerKey } from "../src/lib/somonLeads/contactIdentity.js";
const agentId = "stand-somon-process-agent";
const adIds = ["987651001", "987651002", "987651003", "987651004", "987651005", "987651006", "987651007", "987651008", "987651009", "987651010", "987651011", "987651012", "987651013", "987651014"];
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
    await prisma.somonPhoneSighting.deleteMany({ where: { advertId: { in: adIds } } });
    await prisma.somonDelivery.deleteMany({ where: { advertId: { in: adIds } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: adIds } } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.agent.create({ data: { id: agentId, fullName: "Stand Agent", phone: "stand-somon-process", telegramChatId: "stand-chat-process", role: "AGENT" } });
    await prisma.somonRecipient.create({ data: { agentId, position: 1 } });
    const baseline = new Date(Date.now() - 60_000);
    await prisma.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", enabled: true, activatedAt: baseline, baselineAt: baseline }, update: { enabled: true, activatedAt: baseline, baselineAt: baseline, lastAssignedAgentId: null, sellerKeyRekeyPage: null } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint(), sourceStopped: false } });
    // У каждого объявления свой автор: счёт объявлений автора в категории = 1.
    await prisma.somonSeenAdvert.createMany({ data: adIds.map(advertId => ({ advertId, slug: `${advertId}_stand`, status: "PENDING", baseline: false, sellerKey: somonSellerKey(advertId) })) });
  });
  beforeEach(() => { vi.clearAllMocks(); mocks.phone.mockImplementation(async (id: string) => `+992${String(931000000 + adIds.indexOf(id))}`); mocks.sendPhoto.mockResolvedValue({ message_id: 1, chat: { id: "stand-chat-process" } }); mocks.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "stand-chat-process" } }); });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonContactReceipt.deleteMany({ where: { agentId } });
    await prisma.somonPhoneSighting.deleteMany({ where: { advertId: { in: adIds } } });
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
    expect(mocks.sendPhoto.mock.calls[0][2]).toContain("ОБЪЯВЛЕНИЕ · ДУШАНБЕ");
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
    const reservation = await reserveSomonDelivery(adIds[5], "+992931000005", { kind: "uncertain" });
    expect(reservation.status).toBe("reserved");
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: false } });
    expect(await sendReservedSomon(adIds[5], agentId, "stand-chat-process", "test", null)).toBe("cancelled");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true } });
    expect((await reserveSomonDelivery(adIds[5], "+992931000005", { kind: "uncertain" })).status).toBe("reserved");
  });
  it("rejects the third advert that reuses the same phone as an agency", async () => {
    const same = "+992931000999";
    mocks.phone.mockImplementation(async () => same);
    mocks.detail.mockImplementation(async (url: string) => new Response(JSON.stringify(fakeCard(/(\d{9})_/.exec(url)![1]))));
    const [a, b, c] = [adIds[11], adIds[12], adIds[13]];
    expect(await processSomonPending(a, async () => {})).toBe("sent");
    expect(await processSomonPending(b, async () => {})).toBe("skipped");
    expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: b } }))?.status).toBe("KNOWN_CONTACT");
    expect(await processSomonPending(c, async () => {})).toBe("skipped");
    expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: c } }))?.status).toBe("REJECTED");
    expect(mocks.sendPhoto).toHaveBeenCalledTimes(1);
  });
  it("does not fetch the card when the author has two adverts in the category or is unknown", async () => {
    const extra = ["987651021", "987651022", "987651023"];
    try {
      await prisma.somonSeenAdvert.createMany({ data: [
        { advertId: extra[0], status: "BASELINE", baseline: true, sellerKey: somonSellerKey("7011") },
        { advertId: extra[1], slug: `${extra[1]}_stand`, status: "PENDING", baseline: false, sellerKey: somonSellerKey("7011") },
      ] });
      mocks.detail.mockImplementation(async (url: string) => new Response(JSON.stringify(fakeCard(/(\d{9})_/.exec(url)![1]))));
      expect(await processSomonPending(extra[1], async () => {})).toBe("skipped");
      expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: extra[1] } }))?.status).toBe("REJECTED");
      await prisma.somonSeenAdvert.create({ data: { advertId: extra[2], slug: `${extra[2]}_stand`, status: "PENDING", baseline: false } });
      // Неизвестный автор — не отказ навсегда: отложено, ссылка сохранена до появления автора.
      expect(await processSomonPending(extra[2], async () => {})).toBe("skipped");
      const deferred = await prisma.somonSeenAdvert.findUnique({ where: { advertId: extra[2] } });
      expect(deferred?.status).toBe("SELLER_UNKNOWN");
      expect(deferred?.slug).toBe(`${extra[2]}_stand`);
      expect(mocks.detail).not.toHaveBeenCalled();
      expect(mocks.phone).not.toHaveBeenCalled();
    } finally {
      await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: extra } } });
    }
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
  it("sends an unclaimed owner with one property and two unrelated ads after checking categories", async () => {
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true } });
    const current = { ...fakeCard(adIds[7], "Продам квартиру"), user: { ...fakeCard(adIds[7]).user, id: 7, active_adverts: "3 активных объявления" } };
    const profile = `<a href="/items/author/7/">seller</a><span>Найдено 3 объявлений</span>${[adIds[7], "987652001", "987652002"].map(id => `<div class="advert-grid" data-advert-id="${id}"><a href="/adv/${id}_stand/">item</a></div>`).join("")}`;
    mocks.detail.mockImplementation(async (path: string) => {
      if (path === "/items/author/7/") return new Response(profile);
      if (path.includes(adIds[7])) return new Response(JSON.stringify(current));
      const id = path.includes("987652001") ? 987652001 : 987652002;
      return new Response(JSON.stringify({ id, is_closed: false, user: { id: 7 }, categories: [{ slug: "vakansii" }] }));
    });
    expect(await processSomonPending(adIds[7], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[7], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[7], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[7], async () => {})).toBe("sent");
    expect(mocks.sendPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.sendPhoto.mock.calls[0][2]).toContain("Вероятно собственник");
  });
  it("does not send a seller with three real-estate advertisements", async () => {
    const current = { ...fakeCard(adIds[8], "Продам квартиру"), user: { ...fakeCard(adIds[8]).user, id: 7, active_adverts: "3 активных объявления" } };
    const profile = `<a href="/items/author/7/">seller</a><span>Найдено 3 объявлений</span>${[adIds[8], "987653001", "987653002"].map(id => `<div class="advert-grid" data-advert-id="${id}"><a href="/adv/${id}_stand/">item</a></div>`).join("")}`;
    mocks.detail.mockImplementation(async (path: string) => {
      if (path === "/items/author/7/") return new Response(profile);
      if (path.includes(adIds[8])) return new Response(JSON.stringify(current));
      const id = path.includes("987653001") ? 987653001 : 987653002;
      return new Response(JSON.stringify({ id, is_closed: false, user: { id: 7 }, categories: [{ slug: "nedvizhimost" }] }));
    });
    expect(await processSomonPending(adIds[8], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[8], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[8], async () => {})).toBe("skipped");
    expect(mocks.sendPhoto).not.toHaveBeenCalled();
    expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: adIds[8] } })).status).toBe("REJECTED");
  });
  it("holds for review when a seller replaces an advert while the total is unchanged", async () => {
    const current = { ...fakeCard(adIds[9], "Продам квартиру"), user: { ...fakeCard(adIds[9]).user, id: 7, active_adverts: "3 активных объявления" } };
    let profileCalls = 0;
    const profile = (last: string) => `<a href="/items/author/7/">seller</a><span>Найдено 3 объявлений</span>${[adIds[9], "987654001", last].map(id => `<div class="advert-grid" data-advert-id="${id}"><a href="/adv/${id}_stand/">item</a></div>`).join("")}`;
    mocks.detail.mockImplementation(async (path: string) => {
      if (path === "/items/author/7/") return new Response(profile(++profileCalls === 1 ? "987654002" : "987654003"));
      if (path.includes(adIds[9])) return new Response(JSON.stringify(current));
      const id = path.includes("987654001") ? 987654001 : 987654002;
      return new Response(JSON.stringify({ id, is_closed: false, user: { id: 7 }, categories: [{ slug: "vakansii" }] }));
    });
    expect(await processSomonPending(adIds[9], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[9], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[9], async () => {})).toBe("waiting");
    expect(await processSomonPending(adIds[9], async () => {})).toBe("skipped");
    expect(mocks.sendPhoto).not.toHaveBeenCalled();
    expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: adIds[9] } })).status).toBe("REVIEW_SELLER");
  });
  it("holds for review when a seller profile disappears", async () => {
    const { SomonSourceUnavailable } = await import("../src/lib/somonLeads/sourceClient.js");
    const current = { ...fakeCard(adIds[10], "Продам квартиру"), user: { ...fakeCard(adIds[10]).user, id: 7, active_adverts: "3 активных объявления" } };
    mocks.detail.mockImplementation(async (path: string) => {
      if (path === "/items/author/7/") throw Object.assign(new SomonSourceUnavailable("http", 404), { status: 404 });
      return new Response(JSON.stringify(current));
    });
    expect(await processSomonPending(adIds[10], async () => {})).toBe("skipped");
    const seen = await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: adIds[10] } });
    expect(seen.status).toBe("REVIEW_SELLER"); expect(seen.slug).not.toBeNull();
  });
  it("keeps delivering during the soft author-key rekey without passing an undercounted seller as owner", async () => {
    // Прод: baseline собран до поля sellerKey, у старых записей ключа нет. Сброса baseline
    // нет — вместо него проход rekey. Пока он идёт, занижение счёта по автору возможно.
    const [old, multi, single] = ["987651031", "987651032", "987651033"];
    try {
      await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true, sellerKeyRekeyPage: 1 } });
      await prisma.somonSeenAdvert.createMany({ data: [
        // Старое объявление того же автора (агентство) — без ключа, как на проде после миграции.
        { advertId: old, status: "BASELINE", baseline: true },
        { advertId: multi, slug: `${multi}_stand`, status: "PENDING", baseline: false, sellerKey: somonSellerKey("7101") },
        { advertId: single, slug: `${single}_stand`, status: "PENDING", baseline: false, sellerKey: somonSellerKey("7102") },
      ] });
      const card = (id: string, total: string) => ({ ...fakeCard(id), user: { ...fakeCard(id).user, active_adverts: total } });
      mocks.detail.mockImplementation(async (path: string) => new Response(JSON.stringify(path.includes(multi) ? card(multi, "2 активных объявления") : card(single, "1 активное объявление"))));
      mocks.phone.mockImplementation(async () => "+992931007102");
      // Счёт по ключу = 1, но на сайте 2 объявления: при незавершённой дозаписи — не собственник, а отложено.
      expect(await processSomonPending(multi, async () => {})).toBe("skipped");
      const deferred = await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: multi } });
      expect(deferred.status).toBe("SELLER_UNKNOWN");
      expect(deferred.slug).toBe(`${multi}_stand`);
      expect(mocks.phone).not.toHaveBeenCalled();
      // Автор с единственным объявлением на сайте занижения не допускает — рассылка идёт.
      expect(await processSomonPending(single, async () => {})).toBe("sent");
      expect(mocks.sendPhoto).toHaveBeenCalledTimes(1);
      // Проход дописал ключ старой записи и вернул отложенное в очередь.
      expect(await rekeySellerPage(1, 1, [{ id: old, sellerId: "7101" }, { id: multi, sellerId: "7101" }])).toBe("complete");
      expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).sellerKeyRekeyPage).toBeNull();
      expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: old } })).sellerKey).toBe(somonSellerKey("7101"));
      expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: multi } })).status).toBe("PENDING");
      // Теперь счёт честный (2 в категории) — отказ без запросов к сайту.
      mocks.detail.mockClear();
      expect(await processSomonPending(multi, async () => {})).toBe("skipped");
      expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: multi } })).status).toBe("REJECTED");
      expect(mocks.detail).not.toHaveBeenCalled();
      expect(mocks.sendPhoto).toHaveBeenCalledTimes(1);
    } finally {
      await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { sellerKeyRekeyPage: null } });
      await prisma.somonContactReceipt.deleteMany({ where: { advertId: { in: [old, multi, single] } } });
      await prisma.somonPhoneSighting.deleteMany({ where: { advertId: { in: [old, multi, single] } } });
      await prisma.somonDelivery.deleteMany({ where: { advertId: { in: [old, multi, single] } } });
      await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: [old, multi, single] } } });
    }
  });
});
