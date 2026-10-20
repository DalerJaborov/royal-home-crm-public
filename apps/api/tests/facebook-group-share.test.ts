import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * «РАЗДАТЬ ПО ГРУППАМ FACEBOOK» (28.09.2026, docs/agent-briefs/facebook-groups-share-28-09.md).
 * `parseShareGroups`/`groupShareText` — юнит-часть (lib/facebookGroupShare.ts),
 * done/undo — роуты на стенде (routes/properties/groupShare.ts).
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { parseShareGroups, groupShareText } = await import("../src/lib/facebookGroupShare.js");

const runId = Date.now();
const password = "testpass123";

const GROUP_LIST = [
  `Недвижимость Душанбе | https://www.facebook.com/groups/dushanbe.realty`,
  `Купи-продай квартиры | https://www.facebook.com/groups/kupi.prodai.flats/`,
  // Дубль первой строки (тот же URL, другой регистр и хвостовой слэш) — должен схлопнуться.
  `Недвижимость Душанбе (2) | HTTPS://WWW.FACEBOOK.COM/groups/dushanbe.realty/`,
  // Мусор: не facebook.com/groups, без разделителя, без имени/ссылки.
  `Просто ссылка на Страницу | https://www.facebook.com/RoyalHomeTj`,
  `без разделителя вовсе`,
  ` | https://www.facebook.com/groups/no-name`,
];

describe("parseShareGroups", () => {
  it("валидные строки остаются, дубли по ссылке схлопываются, мусор отбрасывается", () => {
    const groups = parseShareGroups(GROUP_LIST);
    expect(groups).toEqual([
      { name: "Недвижимость Душанбе", url: "https://www.facebook.com/groups/dushanbe.realty" },
      { name: "Купи-продай квартиры", url: "https://www.facebook.com/groups/kupi.prodai.flats/" },
    ]);
  });

  it("пустой список — пустой результат", () => {
    expect(parseShareGroups([])).toEqual([]);
  });
});

describe("groupShareText", () => {
  const baseProperty = {
    id: `prop-${runId}`,
    publishedOnSite: true,
    siteListingId: 42,
    shortId: 112,
    reelsCaption: "3-комн. квартира, 70 м², район Сино. Цена 60000$.",
    type: "APARTMENT",
    rooms: 3,
    areaSqm: "70",
    floor: 4,
    totalFloors: 9,
    price: "60000",
    currency: "USD",
    condition: "GOOD",
    stage: null,
    marketType: null,
    address: "Рудаки, 1",
    landAreaSotka: null,
    amenities: [],
    districtName: "Сино",
  };
  const agent = { fullName: "Сурайё Каримова", phone: "+992777070100" };

  it("разные индексы дают разные первые строки (крючок)", () => {
    const t0 = groupShareText(baseProperty, agent, 0);
    const t1 = groupShareText(baseProperty, agent, 1);
    const t2 = groupShareText(baseProperty, agent, 2);
    expect(t0.split("\n")[0]).not.toBe(t1.split("\n")[0]);
    expect(t1.split("\n")[0]).not.toBe(t2.split("\n")[0]);
    // По кругу: индекс 3 = индекс 0 (три варианта крючка).
    expect(groupShareText(baseProperty, agent, 3).split("\n")[0]).toBe(t0.split("\n")[0]);
  });

  it("ссылка на сайт — последней строкой у опубликованного объекта", () => {
    const text = groupShareText(baseProperty, agent, 0);
    const lines = text.split("\n").filter(Boolean);
    expect(lines.at(-1)).toBe("https://royalhome.tj/listing/42");
  });

  it("объект не опубликован на сайте — без ссылки", () => {
    const text = groupShareText({ ...baseProperty, publishedOnSite: false, siteListingId: null }, agent, 0);
    expect(text).not.toContain("royalhome.tj");
  });
});

let districtId: string;
let marketingToken: string;
let ownerToken: string;
let strangerToken: string;
let ownerId: string;
const agentIds: string[] = [];
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function propertyOwnedBy(agentId: string) {
  const p = await prisma.property.create({
    data: {
      title: `Раздача по группам ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

function getStatus(id: string, token: string) {
  return request(app).get(`/api/v1/properties/${id}/group-share`).set("Authorization", `Bearer ${token}`);
}
function markDone(id: string, index: number, token: string) {
  return request(app).post(`/api/v1/properties/${id}/group-share/${index}/done`).set("Authorization", `Bearer ${token}`);
}
function undo(id: string, index: number, token: string) {
  return request(app).delete(`/api/v1/properties/${id}/group-share/${index}/done`).set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-group-share-${runId}` } })).id;
  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог group-share", phone: `+992971${runId}`, role: "MARKETING", passwordHash },
  });
  const owner = await prisma.agent.create({
    data: { fullName: "Хозяин объекта", phone: `+992972${runId}`, role: "AGENT", passwordHash },
  });
  const stranger = await prisma.agent.create({
    data: { fullName: "Чужой агент", phone: `+992973${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(marketing.id, owner.id, stranger.id);
  ownerId = owner.id;
  marketingToken = await login(marketing.phone);
  ownerToken = await login(owner.phone);
  strangerToken = await login(stranger.phone);

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", facebookShareGroups: GROUP_LIST },
    update: { facebookShareGroups: GROUP_LIST },
  });
});

afterAll(async () => {
  await prisma.propertyGroupShare.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.settings.update({ where: { id: "singleton" }, data: { facebookShareGroups: [] } }).catch(() => {});
  await prisma.$disconnect();
});

describe("GET/POST/DELETE /properties/:id/group-share", () => {
  it("GET отдаёт две валидные группы (из шести строк настроек), 0 из 2 сначала", async () => {
    const p = await propertyOwnedBy(ownerId);
    const res = await getStatus(p.id, marketingToken);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.done).toBe(0);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.groups[0].sharedAt).toBeNull();
    expect(typeof res.body.groups[0].text).toBe("string");
  });

  it("хозяин объекта отмечает «Выложено» — done растёт, agentName подставляется", async () => {
    const p = await propertyOwnedBy(ownerId);
    const res = await markDone(p.id, 0, ownerToken);
    expect(res.status).toBe(200);
    const status = await getStatus(p.id, marketingToken);
    expect(status.body.done).toBe(1);
    expect(status.body.groups[0].sharedAt).not.toBeNull();
    expect(status.body.groups[0].agentName).toBe("Хозяин объекта");
  });

  it("повторное «Выложено» на ту же группу не создаёт вторую строку (@@unique) — обновляет дату", async () => {
    const p = await propertyOwnedBy(ownerId);
    expect((await markDone(p.id, 0, ownerToken)).status).toBe(200);
    expect((await markDone(p.id, 0, ownerToken)).status).toBe(200);
    const rows = await prisma.propertyGroupShare.findMany({ where: { propertyId: p.id } });
    expect(rows).toHaveLength(1);
  });

  it("«Отменить» убирает отметку", async () => {
    const p = await propertyOwnedBy(ownerId);
    expect((await markDone(p.id, 1, ownerToken)).status).toBe(200);
    expect((await getStatus(p.id, marketingToken)).body.done).toBe(1);
    expect((await undo(p.id, 1, ownerToken)).status).toBe(200);
    expect((await getStatus(p.id, marketingToken)).body.done).toBe(0);
  });

  it("чужой агент без роли маркетинга — 403 на отметку, GET всё равно читает", async () => {
    const p = await propertyOwnedBy(ownerId);
    expect((await markDone(p.id, 0, strangerToken)).status).toBe(403);
    expect((await getStatus(p.id, strangerToken)).status).toBe(200);
  });

  it("маркетинг может отметить чужой объект", async () => {
    const p = await propertyOwnedBy(ownerId);
    expect((await markDone(p.id, 0, marketingToken)).status).toBe(200);
  });

  it("несуществующий индекс группы — 404", async () => {
    const p = await propertyOwnedBy(ownerId);
    expect((await markDone(p.id, 99, ownerToken)).status).toBe(404);
  });

  it("объект не найден — 404", async () => {
    const res = await getStatus("00000000-0000-0000-0000-000000000000", marketingToken);
    expect(res.status).toBe(404);
  });
});
