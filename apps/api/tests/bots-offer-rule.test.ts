import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЧТО БОТАМ МОЖНО ПРЕДЛАГАТЬ — ОДНО ПРАВИЛО (10.10.2026, аудит поиска P0-5).
 *
 * Решение владельца: «показывай, если в продаже и есть публикация». Правило живёт в
 * lib/propertyMatch.ts в двух видах — условие выборки (`botOfferableWhere`) и
 * проверка прочитанной карточки (`botMayOffer`), — и через него идут подбор (чат и
 * голос), рассказ об объекте у голоса, переспрос, СМС и сообщение в мессенджер.
 *
 * Здесь: (1) оба вида правила дают ОДИН результат на одних и тех же карточках в
 * базе, во всех трёх режимах; (2) подбор и голос видят одно и то же; (3) ссылка
 * клиенту для объекта не с сайта — его публикация, а без публикации ссылки нет.
 *
 * Сторож проверен поломкой (10.10.2026), каждая краснит свои тесты:
 *  - в botMayOffer убрана проверка publishedChannels — «оба вида правила» и
 *    «ролик только в Facebook»;
 *  - в botOfferableWhere убран `offSite: false` — «оба вида правила», «закрытый —
 *    никогда»;
 *  - botOfferLink снова отдаёт by-crm адрес сайта объекту не с сайта — «ссылка в СМС»;
 *  - get_property проверяет `publishedOnSite` вместо botMayOffer — «голос называет цену»;
 *  - подбор снова берёт только `publishedOnSite` — оба теста «подбор».
 */

const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }));
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sms/index.js")>()),
  sendSms,
}));

const { prisma } = await import("../src/db.js");
const { BOT_OFFER_SELECT, BOTS_OFFER_MODE, botMayOffer, botOfferableWhere, botOfferLink, findMatchingProperties } = await import(
  "../src/lib/propertyMatch.js"
);
type BotOfferMode = import("../src/lib/propertyMatch.js").BotOfferMode;
const { handlePropertyTool, newPropertyCallMemory, propertiesSmsText } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { propertyLink } = await import("../src/ai/leadQualifier.js");

const runId = Date.now().toString(36);
const TAG = `Правило-${runId}`;
const scope = { title: { startsWith: TAG } };
const CALLER = `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;
const REEL = `https://www.instagram.com/reel/r${runId}/`;
const call = (name: string, args: Record<string, unknown>) => ({ id: "c", name, args });

/** Карточки по меткам: что есть у объекта и предлагается ли он по умолчанию. */
const FIXTURES: { mark: string; data: Record<string, unknown>; offered: boolean }[] = [
  { mark: "site", data: { publishedOnSite: true }, offered: true },
  { mark: "reel", data: { instagramUrl: REEL }, offered: true },
  { mark: "reelUpper", data: { instagramUrl: `HTTPS://Instagram.com/p/u${runId}/` }, offered: true },
  { mark: "facebookOnly", data: { publishedChannels: ["FACEBOOK"] }, offered: true },
  { mark: "reserved", data: { status: "RESERVED", instagramUrl: REEL }, offered: true },
  { mark: "nothing", data: {}, offered: false },
  { mark: "telegram", data: { instagramUrl: "https://t.me/c/12345/6" }, offered: false },
  { mark: "fakeInstagram", data: { instagramUrl: "https://instagram.com.evil.example/x" }, offered: false },
  { mark: "leadingSpace", data: { instagramUrl: ` ${REEL}` }, offered: false },
  { mark: "offSiteSite", data: { offSite: true, publishedOnSite: true }, offered: false },
  { mark: "offSiteReel", data: { offSite: true, instagramUrl: REEL, publishedChannels: ["INSTAGRAM"] }, offered: false },
  { mark: "trashed", data: { publishedOnSite: true, instagramUrl: REEL, deletedAt: new Date() }, offered: false },
  { mark: "sold", data: { status: "SOLD", publishedOnSite: true, instagramUrl: REEL }, offered: false },
  { mark: "withdrawn", data: { status: "WITHDRAWN", instagramUrl: REEL }, offered: false },
];
const ids: Record<string, { id: string; shortId: number }> = {};

beforeAll(async () => {
  const sino = await prisma.district.upsert({ where: { name: "Сино" }, create: { name: "Сино" }, update: {} });
  for (const f of FIXTURES) {
    ids[f.mark] = await prisma.property.create({
      data: {
        title: `${TAG} ${f.mark}`,
        // Семь комнат у коммерческого — таких чужих карточек в общей базе нет.
        type: "COMMERCIAL",
        rooms: 7,
        areaSqm: 140,
        price: 700_000,
        currency: "TJS",
        condition: "GOOD",
        districtId: sino.id,
        address: `Тестовая ${runId}`,
        status: "AVAILABLE",
        publishedOnSite: false,
        ...f.data,
      } as never,
      select: { id: true, shortId: true },
    });
  }
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: scope });
});

beforeEach(() => {
  sendSms.mockReset();
  sendSms.mockResolvedValue({ ok: true, id: "sms-1", parts: 2 });
});

const markOf = (id: string) => Object.entries(ids).find(([, v]) => v.id === id)?.[0];

describe("правило одно: выборка и карточка дают один результат", () => {
  it.each<BotOfferMode>(["site_only", "site_or_publication", "all"])("режим %s", async (mode) => {
    const byWhere = await prisma.property.findMany({ where: { AND: [scope, botOfferableWhere(mode)] }, select: { id: true } });
    const cards = await prisma.property.findMany({ where: scope, select: { id: true, ...BOT_OFFER_SELECT } });
    expect(cards).toHaveLength(FIXTURES.length);
    const byCard = cards.filter((c) => botMayOffer(c, mode));
    expect(byWhere.map((p) => markOf(p.id)).sort()).toEqual(byCard.map((p) => markOf(p.id)).sort());
  });

  it("по умолчанию — на сайте или есть публикация; закрытое, Корзина, продано — никогда", async () => {
    expect(BOTS_OFFER_MODE).toBe("site_or_publication");
    const offered = await prisma.property.findMany({ where: { AND: [scope, botOfferableWhere()] }, select: { id: true } });
    expect(offered.map((p) => markOf(p.id)).sort()).toEqual(FIXTURES.filter((f) => f.offered).map((f) => f.mark).sort());
  });

  it("режим «только сайт» — прежнее правило; «всё» — всё в продаже, кроме закрытого", async () => {
    const siteOnly = await prisma.property.findMany({ where: { AND: [scope, botOfferableWhere("site_only")] }, select: { id: true } });
    expect(siteOnly.map((p) => markOf(p.id))).toEqual(["site"]);
    const all = await prisma.property.findMany({ where: { AND: [scope, botOfferableWhere("all")] }, select: { id: true } });
    const marks = all.map((p) => markOf(p.id));
    expect(marks).toContain("nothing");
    expect(marks).not.toContain("offSiteSite");
    expect(marks).not.toContain("trashed");
    expect(marks).not.toContain("sold");
  });
});

describe("подбор: чат-бот и голос видят одно и то же", () => {
  const query = { districtName: "Сино", type: "COMMERCIAL", rooms: 7 } as const;

  it("подбор (общий для чата и голоса): сайт и публикации — да, без публикации и закрытое — нет", async () => {
    const found = await findMatchingProperties(query, { scope, limit: 50 });
    const marks = found.map((p) => markOf(p.id)).sort();
    // Бронь подбор не предлагает (только AVAILABLE), остальное — ровно правило.
    expect(marks).toEqual(["facebookOnly", "reel", "reelUpper", "site"]);
  });

  it("голос search_properties называет те же объекты, что подбор", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(memory, call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 7 }));
    const numbers = (reply?.response.options as { number: number }[]).map((o) => o.number);
    expect(numbers.length).toBeGreaterThan(0);
    const allowed = ["site", "reel", "reelUpper", "facebookOnly"].map((m) => ids[m].shortId);
    for (const n of numbers) expect(allowed).toContain(n);
  });
});

describe("голос get_property", () => {
  it("не на сайте, в продаже, с роликом в Instagram — рассказывает и называет цену", async () => {
    const reply = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("get_property", { query: String(ids.reel.shortId) })
    );
    expect(reply?.response).toMatchObject({ found: true, number: ids.reel.shortId, price: "семьсот тысяч сомони" });
    expect(reply?.response).not.toHaveProperty("closed");
  });

  it("ролик только в Facebook (publishedChannels) — тоже публикация, цена называется", async () => {
    const reply = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("get_property", { query: String(ids.facebookOnly.shortId) })
    );
    expect(reply?.response).toMatchObject({ found: true, price: "семьсот тысяч сомони" });
  });

  it("без публикации и закрытое — только лично, без цены", async () => {
    for (const mark of ["nothing", "offSiteReel", "telegram"]) {
      const reply = await handlePropertyTool(
        newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
        call("get_property", { query: String(ids[mark].shortId) })
      );
      expect(reply?.response, mark).toMatchObject({ found: true, closed: true });
      expect(reply?.response, mark).not.toHaveProperty("price");
    }
  });
});

describe("ссылка клиенту", () => {
  it("СМС по объекту не с сайта — ссылка на публикацию, не на сайт", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    await handlePropertyTool(memory, call("get_property", { query: String(ids.reel.shortId) }));
    const reply = await handlePropertyTool(memory, call("send_property_sms", {}));
    expect(reply?.response).toEqual({ ok: true, sent: 1 });
    const sms = sendSms.mock.calls[0][0] as { text: string };
    expect(sms.text).toContain(REEL);
    expect(sms.text).not.toContain("royalhome.tj");
  });

  it("ни сайта, ни поста Instagram — СМС не уходит, ссылку не придумываем", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    await handlePropertyTool(memory, call("get_property", { query: String(ids.facebookOnly.shortId) }));
    const reply = await handlePropertyTool(memory, call("send_property_sms", {}));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("текст СМС и ссылка чата — одной функцией botOfferLink", () => {
    const reel = { id: "r1", publishedOnSite: false, instagramUrl: REEL, siteListingId: null };
    const none = { id: "n1", publishedOnSite: false, instagramUrl: null, siteListingId: null };
    const site = { id: "s1", publishedOnSite: true, instagramUrl: REEL, siteListingId: null };
    expect(botOfferLink(reel)).toBe(REEL);
    expect(botOfferLink(none)).toBeNull();
    expect(botOfferLink(site)).toBe("https://royalhome.tj/listing/by-crm/s1");
    expect(propertyLink(reel, "WEBSITE")).toBe(REEL);
    expect(propertyLink(none, "WHATSAPP")).toBeNull();
    const fields = { rooms: 2, areaSqm: 60, price: 500_000, currency: "TJS", district: { name: "Сино" } };
    expect(propertiesSmsText([{ ...reel, ...fields }])).toContain(`: ${REEL}`);
    expect(propertiesSmsText([{ ...none, ...fields }])).not.toContain("https://");
  });
});
