import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * СТОРОЖ «НОМЕРА ВИДИТ ТОЛЬКО ДИРЕКТОР» (владелец 18.11.2026, дословно: «Номера
 * продавцов закрыть от агентов совсем. Никто не может видеть своих, даже клиентов.
 * РОП полностью тоже закрыть номера. То есть, кроме директора, ни у кого вообще не
 * будет доступа к номерам телефона вообще»).
 *
 * Самый трудный случай — СВОЙ: агент ведёт объект (ответственный, интейкер и
 * создатель сразу), продавец и покупатель закреплены за ним и приняты. До
 * 18.11.2026 именно так номер и утекал: lib/ownerContact.ts открывал ownerContact
 * «своему», а блок рынка сверял номер площадки только с ownerContact, мимо
 * WhatsApp-номера продавца. Здесь агент и РОП обходят все поверхности, где есть
 * номер, — и ни в одном ответе нет девяти цифр ни одного номера. Директор видит
 * их целиком: сторож проверяет закрытие, а не поломку.
 */

const { fetchSomonPhone } = vi.hoisted(() => ({ fetchSomonPhone: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("../src/lib/somonLeads/phone.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/phone.js")>()),
  fetchSomonPhoneInteractive: fetchSomonPhone,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { catalogRaw } = await import("./helpers/somonPage.js");

const runId = Date.now().toString().slice(-7);
const tail = (n: number) => `9${runId.slice(-6)}${String(n).padStart(2, "0")}`; // 9 цифр
const phone = (n: number) => `+992${tail(n)}`;
const SELLER_MAIN = 11;
const SELLER_WA = 12;
const SELLER_EXTRA = 13;
const BUYER = 14;
const ALL_TAILS = [SELLER_MAIN, SELLER_WA, SELLER_EXTRA, BUYER].map(tail);

const agentIds: string[] = [];
const clientIds: string[] = [];
let districtId = "";
let propertyId = "";
let propertyShortId = 0;
let sellerShortId = 0;
let buyerShortId = 0;
let dealId = "";
const listingIds: string[] = [];
let listingUrl = "";
const tokens: Record<"AGENT" | "HEAD_OF_SALES" | "DIRECTOR", string> = { AGENT: "", HEAD_OF_SALES: "", DIRECTOR: "" };

beforeAll(async () => {
  for (const [i, role] of (["AGENT", "HEAD_OF_SALES", "DIRECTOR"] as const).entries()) {
    const a = await prisma.agent.create({
      data: { fullName: `Сторож номеров ${role} ${runId}`, phone: `+99296${i}${runId}`, role, passwordHash: "x" },
    });
    agentIds.push(a.id);
    tokens[role] = signAccessToken({ sub: a.id, role });
  }
  const agentId = agentIds[0];
  districtId = (await prisma.district.create({ data: { name: `Район сторожа номеров ${runId}` } })).id;

  const seller = await prisma.client.create({
    data: {
      fullName: `Продавец Сторожев ${runId}`,
      phone: phone(SELLER_MAIN),
      whatsappPhone: phone(SELLER_WA),
      extraPhones: [phone(SELLER_EXTRA)],
      source: "WALK_IN",
      kind: "SELLER",
      status: "NEW",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      // Номер «не в том поле» — свободный текст тоже закрыт.
      requirementsNotes: `Второй номер ${tail(SELLER_EXTRA)}, звонить вечером`,
    } as never,
  });
  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель Сторожев ${runId}`,
      phone: phone(BUYER),
      source: "WALK_IN",
      kind: "BUYER",
      status: "NEW",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      refusalReason: `Перезвонить на ${tail(BUYER)}`,
    } as never,
  });
  clientIds.push(seller.id, buyer.id);
  sellerShortId = seller.shortId;
  buyerShortId = buyer.shortId;

  const property = await prisma.property.create({
    data: {
      title: `Объект сторожа номеров ${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 500000,
      currency: "TJS",
      districtId,
      address: "Тестовая сторожа, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentId,
      intakeAgentId: agentId,
      createdById: agentId,
      ownerContact: phone(SELLER_MAIN),
      sellerClientId: seller.id,
    } as never,
  });
  propertyId = property.id;
  propertyShortId = property.shortId;

  dealId = (
    await prisma.deal.create({
      data: { clientId: buyer.id, propertyId, agentId, notes: `Покупатель просил писать на ${phone(BUYER)}` } as never,
    })
  ).id;

  await prisma.auditLog.create({
    data: {
      agentName: "Сторож",
      action: "PROPERTY_FIELDS_CHANGED",
      entityType: "Property",
      entityId: propertyId,
      meta: { changes: [{ field: "ownerContact", label: "Контакт владельца", was: phone(SELLER_EXTRA), becomes: phone(SELLER_MAIN) }] },
    },
  });

  // Продавец выставил квартиру и сам — с WhatsApp-номера, которого нет в ownerContact.
  const listing = await prisma.marketListing.create({
    data: {
      source: "somon.tj",
      sourceId: `guard-${runId}`,
      sourceUrl: `https://somon.tj/adv/${runId}_guard/`,
      dealType: "SALE",
      propertyType: "APARTMENT",
      city: "Душанбе",
      rooms: 2,
      areaSqm: 60,
      price: 510000,
      currency: "TJS",
      priceTjs: 510000,
      title: "2-комн., сторож",
      isAgency: false,
      sellerName: "Продавец",
      sellerPhone: phone(SELLER_WA),
      isActive: true,
      raw: catalogRaw(),
    } as never,
  });
  listingIds.push(listing.id);
  listingUrl = listing.sourceUrl;
  await prisma.propertyMarketMatch.create({
    data: { propertyId, listingId: listing.id, score: 80, reasons: [{ code: "rooms", label: "2 комн." }] },
  });
});

afterAll(async () => {
  await prisma.marketListingContact.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.propertyMarketMatch.deleteMany({ where: { propertyId } });
  await prisma.marketListing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [propertyId, dealId, ...clientIds] } } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

let clock = Date.now();
beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

type Surface = { name: string; call: (token: string) => request.Test; mustContain?: string };
const auth = (t: request.Test, token: string) => t.set("Authorization", `Bearer ${token}`);
const SURFACES: Surface[] = [
  { name: "карточка объекта", call: (t) => auth(request(app).get(`/api/v1/properties/${propertyShortId}`), t), mustContain: "Объект сторожа номеров" },
  { name: "список объектов", call: (t) => auth(request(app).get(`/api/v1/properties?districtId=${districtId}`), t), mustContain: "Объект сторожа номеров" },
  { name: "карточка продавца", call: (t) => auth(request(app).get(`/api/v1/clients/${sellerShortId}`), t), mustContain: "Продавец Сторожев" },
  { name: "карточка покупателя", call: (t) => auth(request(app).get(`/api/v1/clients/${buyerShortId}`), t), mustContain: "Покупатель Сторожев" },
  { name: "список клиентов", call: (t) => auth(request(app).get(`/api/v1/clients?q=${encodeURIComponent(`Сторожев ${runId}`)}`), t), mustContain: "Сторожев" },
  { name: "сделки", call: (t) => auth(request(app).get(`/api/v1/deals`), t), mustContain: dealId },
  { name: "рынок: совпадения объекта", call: (t) => auth(request(app).get(`/api/v1/market/matches/property/${propertyShortId}`), t), mustContain: "сторож" },
  { name: "история объекта", call: (t) => auth(request(app).get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`), t), mustContain: "PROPERTY_FIELDS_CHANGED" },
  {
    name: "рынок: номер объявления",
    call: (t) => {
      clock += 10_000; // троттлинг 3 с на сотрудника обходим временем
      return auth(request(app).post("/api/v1/market/listing-contact").send({ sourceUrl: listingUrl }), t);
    },
  },
];

const leakedTails = (body: unknown) => {
  const text = JSON.stringify(body);
  return ALL_TAILS.filter((t) => text.includes(t));
};

describe.each(["AGENT", "HEAD_OF_SALES"] as const)("%s не получает ни одного полного номера — даже своих", (role) => {
  it.each(SURFACES.map((s) => [s.name, s] as const))("%s", async (_name, surface) => {
    const res = await surface.call(tokens[role]);
    expect([200, 403]).toContain(res.status);
    if (surface.mustContain && res.status === 200) expect(JSON.stringify(res.body)).toContain(surface.mustContain);
    if (leakedTails(res.body).length) {
      const walk = (v: unknown, path: string): void => {
        if (typeof v === "string") { if (ALL_TAILS.some((t) => v.includes(t))) console.log("LEAK", path, v.slice(0, 120)); return; }
        if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      };
      walk(res.body, "body");
    }
    expect(leakedTails(res.body)).toEqual([]);
  });

  it("на своём объекте видит продавца именем и маской номера — звонить есть чем", async () => {
    if (role !== "AGENT") return;
    const res = await SURFACES[0].call(tokens.AGENT);
    expect(res.body.ownerContactHidden).toBe(true);
    expect(res.body.ownerContactMasked).toBe(`+992•••••${String(SELLER_MAIN)}`);
    expect(res.body.sellerClient?.id).toBe(clientIds[0]);
    expect(res.body.sellerClient?.canOpen).toBe(true);
  });
});

describe("DIRECTOR видит номера целиком", () => {
  it("карточка объекта — контакт владельца", async () => {
    const res = await SURFACES[0].call(tokens.DIRECTOR);
    expect(res.body.ownerContact).toBe(phone(SELLER_MAIN));
  });
  it("карточка продавца — все номера", async () => {
    const res = await SURFACES[2].call(tokens.DIRECTOR);
    expect(res.body.phone).toBe(phone(SELLER_MAIN));
    expect(res.body.whatsappPhone).toBe(phone(SELLER_WA));
  });
  it("рынок — номер объявления, совпавший с WhatsApp продавца", async () => {
    const matches = await SURFACES[6].call(tokens.DIRECTOR);
    expect(matches.body.matches[0].sellerPhone).toBe(phone(SELLER_WA));
    const contact = await SURFACES[8].call(tokens.DIRECTOR);
    expect(contact.status).toBe(200);
    expect(contact.body.phone).toBe(phone(SELLER_WA));
  });
  it("сделки — заметка с номером", async () => {
    const res = await SURFACES[5].call(tokens.DIRECTOR);
    expect(JSON.stringify(res.body)).toContain(tail(BUYER));
  });
});
