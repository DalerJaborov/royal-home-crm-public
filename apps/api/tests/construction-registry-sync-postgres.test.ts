import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";

/**
 * Забор реестра строек и привязка к объектам на настоящей базе, с подменой ответа memor.pro (20.11.2026).
 * Проверяем: первый забор (без уведомлений), повторный (без лишних запросов страниц), смена цвета (история и уведомление
 * агенту, рубильник), сторож «список обрезан», исчезнувшие, автосвязь только по уверенному совпадению, ручная связь и отвязка.
 */
const { prisma } = await import("../src/db.js");
const { runConstructionRegistrySync, sanityRefusal } = await import("../src/lib/constructionRegistry/sync.js");
const { parseRegistryList } = await import("../src/lib/constructionRegistry/parse.js");
const { linkPropertyManually, unlinkProperty, autoLinkProperty, toMatchInput } = await import("../src/lib/constructionRegistry/link.js");
const { buildPropertyResponse } = await import("../src/lib/constructionRegistry/view.js");

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const PAGE_GREEN = fx("memor-page-green.html"); // адрес «кӯчаи Р.Набиев №12»
const runId = Date.now();

function item(id: string, color: string, customer: string, lat = 38.5556, lng = 68.7575) {
  return { id, title: `Дом ${id}`, customer, qaror: `${id}-2020`.replace("-2020-2020", "-2020"), lat, lng, url: `${id}/`, is_complete: color === "green", color_status: color, has_commission: false, category: "residential", edu_type: "" };
}

function makeSource(list: () => unknown, pages: string[] = []) {
  return {
    fetchList: async () => list(),
    fetchPage: async (url: string) => {
      pages.push(url);
      return PAGE_GREEN;
    },
    sleep: async () => undefined,
  };
}

let agentId = "";
let districtId = "";
let propertyNear = "";
let propertyFar = "";
const propertyIds: string[] = [];

async function clearRegistry() {
  await prisma.constructionPropertyLink.deleteMany({});
  await prisma.constructionStatusChange.deleteMany({});
  await prisma.constructionProject.deleteMany({});
  await prisma.constructionDeveloper.deleteMany({});
  await prisma.constructionSyncRun.deleteMany({});
}

async function setSettings(data: { constructionRegistryEnabled?: boolean; constructionRegistryNotify?: boolean }) {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (await prisma.agent.create({ data: { fullName: "Агент забора", phone: `+992978${runId}`, role: "AGENT", passwordHash } })).id;
  districtId = (await prisma.district.create({ data: { name: `Район забора ${runId}`, city: "Душанбе" } })).id;
  const base = { type: "APARTMENT" as const, areaSqm: 60, price: 50000, currency: "TJS" as const, districtId, status: "AVAILABLE" as const, intakeAgentId: agentId, createdById: agentId, assignedAgentId: agentId };
  // Рядом (≈0 м), улица и дом совпадают со страницей реестра → автосвязь.
  propertyNear = (await prisma.property.create({ data: { ...base, title: `Рядом ${runId}`, address: "ул. Р. Набиев, 12", condition: "GOOD", lat: 38.5556, lng: 68.7575 } })).id;
  // Далеко (≈1,5 км) → «в реестре не найден».
  propertyFar = (await prisma.property.create({ data: { ...base, title: `Далеко ${runId}`, address: "ул. Другая, 5", condition: "NEW_BUILDING", lat: 38.57, lng: 68.78 } })).id;
  propertyIds.push(propertyNear, propertyFar);
});

beforeEach(async () => {
  await clearRegistry();
  await setSettings({ constructionRegistryEnabled: true, constructionRegistryNotify: true });
});

afterAll(async () => {
  await setSettings({ constructionRegistryEnabled: true, constructionRegistryNotify: true });
  await clearRegistry();
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("забор реестра", () => {
  it("первый забор: проекты, застройщики по нормализованному имени, страницы, автосвязь, без уведомлений", async () => {
    const pages: string[] = [];
    const list = [item("a1", "green", "ҶДММ «Альфа»"), item("a2", "red", "Альфа"), item("b1", "yellow", "ҶДММ «Бета»", 38.6, 68.9)];
    const r = await runConstructionRegistrySync({ source: makeSource(() => list, pages) });
    expect(r).toMatchObject({ ok: true, fetched: 3, created: 3, removed: 0, detailsFetched: 3, notified: 0 });
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatch(/^https:\/\/www\.memor\.pro\/sokhtmon\//);
    // «ҶДММ «Альфа»» и «Альфа» — один застройщик.
    expect(await prisma.constructionDeveloper.count()).toBe(2);
    const a1 = await prisma.constructionProject.findUniqueOrThrow({ where: { sourceId: "a1" } });
    expect(a1.address).toBe("кӯчаи Р.Набиев №12");
    expect(a1.floors).toBe(14);
    expect(a1.blocks).toEqual(["Блок А"]);
    expect(a1.statusChangedAt).toBeNull(); // нулевая точка, не «смена»
    // Два проекта стоят в одной точке с совпавшим адресом: неоднозначно, само не связываем (выберет агент).
    const near = await buildPropertyResponse(toMatchInput((await prisma.property.findUniqueOrThrow({ where: { id: propertyNear } }))), true);
    expect(near.link).toBeNull();
    expect(near.suggestions.length).toBeGreaterThanOrEqual(2);
    const far = await buildPropertyResponse(toMatchInput((await prisma.property.findUniqueOrThrow({ where: { id: propertyFar } }))), true);
    expect(far.notFound).toBe(true);
    expect(await prisma.notification.count({ where: { agentId } })).toBe(0);
    expect(r.linked).toBe(0);
  });

  it("однозначное совпадение связывается само; ручная связь и отвязка работают, отвергнутое не возвращается", async () => {
    const list = [item("c1", "green", "Гамма")];
    const r = await runConstructionRegistrySync({ source: makeSource(() => list) });
    expect(r.linked).toBe(1);
    const view = await buildPropertyResponse(toMatchInput(await prisma.property.findUniqueOrThrow({ where: { id: propertyNear } })), true);
    expect(view.link?.method).toBe("AUTO");
    expect(view.link?.project.color).toBe("green");
    expect(view.link?.developer.rating.total).toBe(1);
    expect(view.link?.developer.rating.letter).toBeNull(); // меньше трёх проектов

    expect(await unlinkProperty(propertyNear, agentId)).toBe(1);
    const prop = toMatchInput(await prisma.property.findUniqueOrThrow({ where: { id: propertyNear } }));
    expect(await autoLinkProperty(prop)).toBe(false); // отвергнутое автосвязь не возвращает
    const after = await buildPropertyResponse(prop, true);
    expect(after.link).toBeNull();
    expect(after.suggestions).toHaveLength(0);

    const project = await prisma.constructionProject.findUniqueOrThrow({ where: { sourceId: "c1" } });
    await linkPropertyManually(propertyNear, project.id, agentId);
    const manual = await buildPropertyResponse(prop, true);
    expect(manual.link?.method).toBe("MANUAL");
    expect(manual.link?.confidence).toBe(100);
  });

  it("повторный забор без изменений: страницы не перечитываются", async () => {
    const list = [item("d1", "green", "Дельта")];
    await runConstructionRegistrySync({ source: makeSource(() => list) });
    const pages: string[] = [];
    const r = await runConstructionRegistrySync({ source: makeSource(() => list, pages) });
    expect(r).toMatchObject({ ok: true, created: 0, changed: 0, detailsFetched: 0 });
    expect(pages).toHaveLength(0);
  });

  it("смена цвета: история, страница перечитана, уведомление ответственному агенту; рубильник уведомлений гасит", async () => {
    await runConstructionRegistrySync({ source: makeSource(() => [item("e1", "green", "Эпсилон")]) });
    expect((await buildPropertyResponse(toMatchInput(await prisma.property.findUniqueOrThrow({ where: { id: propertyNear } })), true)).link).not.toBeNull();

    const pages: string[] = [];
    const r = await runConstructionRegistrySync({ source: makeSource(() => [item("e1", "red", "Эпсилон")], pages) });
    expect(r).toMatchObject({ ok: true, changed: 1, detailsFetched: 1, notified: 1 });
    const changes = await prisma.constructionStatusChange.findMany({ orderBy: { changedAt: "asc" } });
    expect(changes.map((c) => c.toColor)).toEqual(["GREEN", "RED"]);
    const n = await prisma.notification.findFirstOrThrow({ where: { agentId } });
    expect(n.title).toContain("Разрешения нет");
    expect(n.body).toContain("Эпсилон");
    expect(n.url).toMatch(/^\/properties\/\d+$/);

    await prisma.notification.deleteMany({ where: { agentId } });
    await setSettings({ constructionRegistryNotify: false });
    const r2 = await runConstructionRegistrySync({ source: makeSource(() => [item("e1", "yellow", "Эпсилон")]) });
    expect(r2).toMatchObject({ ok: true, changed: 1, notified: 0 });
    expect(await prisma.notification.count({ where: { agentId } })).toBe(0);
  });

  it("сторож: пустой, не список и сильно урезанный список ничего не применяют", async () => {
    const big = Array.from({ length: 24 }, (_, i) => item(`g${i}`, "green", `Застройщик ${i}`, 38.6 + i / 1000, 68.9));
    await runConstructionRegistrySync({ source: makeSource(() => big) });
    expect(await prisma.constructionProject.count({ where: { removedAt: null } })).toBe(24);

    const cut = await runConstructionRegistrySync({ source: makeSource(() => big.slice(0, 5)) });
    expect(cut.ok).toBe(false);
    expect(cut.error).toContain("сократился");
    expect(await prisma.constructionProject.count({ where: { removedAt: null } })).toBe(24);

    const notJson = await runConstructionRegistrySync({ source: makeSource(() => ({ error: "oops" })) });
    expect(notJson.ok).toBe(false);
    const empty = await runConstructionRegistrySync({ source: makeSource(() => []) });
    expect(empty.ok).toBe(false);
    const runs = await prisma.constructionSyncRun.findMany({ orderBy: { startedAt: "desc" }, take: 3 });
    expect(runs.every((x) => !x.ok && x.error)).toBe(true);

    expect(sanityRefusal(parseRegistryList(big.slice(0, 20)), 24)).toBeNull();
  });

  it("исчезнувший из списка помечается, не удаляется; вернулся — снова активен", async () => {
    const big = Array.from({ length: 24 }, (_, i) => item(`h${i}`, "green", `Застройщик ${i}`, 38.6 + i / 1000, 68.9));
    await runConstructionRegistrySync({ source: makeSource(() => big) });
    const r = await runConstructionRegistrySync({ source: makeSource(() => big.slice(1)) });
    expect(r.removed).toBe(1);
    const gone = await prisma.constructionProject.findUniqueOrThrow({ where: { sourceId: "h0" } });
    expect(gone.removedAt).not.toBeNull();
    await runConstructionRegistrySync({ source: makeSource(() => big) });
    expect((await prisma.constructionProject.findUniqueOrThrow({ where: { sourceId: "h0" } })).removedAt).toBeNull();
  });

  it("рубильник выключен: забор не идёт", async () => {
    await setSettings({ constructionRegistryEnabled: false });
    const r = await runConstructionRegistrySync({ source: makeSource(() => [item("z1", "green", "Зета")]) });
    expect(r.skipped).toBe("disabled");
    expect(await prisma.constructionProject.count()).toBe(0);
    const view = await buildPropertyResponse(toMatchInput(await prisma.property.findUniqueOrThrow({ where: { id: propertyNear } })), false);
    expect(view.enabled).toBe(false);
    expect(view.link).toBeNull();
    expect(view.suggestions).toEqual([]);
  });

  it("сбой страницы: хэш не сохраняется, страница перечитывается в следующий раз", async () => {
    await runConstructionRegistrySync({ source: makeSource(() => [item("p1", "green", "Пи")]) });
    const bad = { ...makeSource(() => [item("p1", "yellow", "Пи")]), fetchPage: async () => { throw new Error("сеть"); } };
    const r1 = await runConstructionRegistrySync({ source: bad });
    expect(r1).toMatchObject({ ok: true, changed: 1, detailsFetched: 0 });
    const pages: string[] = [];
    const r2 = await runConstructionRegistrySync({ source: makeSource(() => [item("p1", "yellow", "Пи")], pages) });
    expect(r2.detailsFetched).toBe(1);
    expect(pages).toHaveLength(1);
  });

  it("страница-заглушка не затирает сохранённый адрес и документы", async () => {
    await runConstructionRegistrySync({ source: makeSource(() => [item("q1", "green", "Ку")]) });
    const stub = { ...makeSource(() => [item("q1", "red", "Ку")]), fetchPage: async () => "<html><body>Технические работы</body></html>" };
    await runConstructionRegistrySync({ source: stub });
    const p = await prisma.constructionProject.findUniqueOrThrow({ where: { sourceId: "q1" } });
    expect(p.address).toBe("кӯчаи Р.Набиев №12");
    expect(p.blocks).toEqual(["Блок А"]);
  });

  it("сторож вёрстки: почти все страницы без узнаваемых данных — забор останавливается и сообщает, старое цело", async () => {
    const list = Array.from({ length: 30 }, (_, i) => item(`v${i}`, "green", `Вэ ${i}`, 38.7 + i / 1000, 69.1));
    await runConstructionRegistrySync({ source: makeSource(() => list) });
    const before = await prisma.constructionProject.findUniqueOrThrow({ where: { sourceId: "v0" } });
    const fetched: string[] = [];
    const changed = list.map((x) => ({ ...x, color_status: "red" }));
    const broken = { ...makeSource(() => changed), fetchPage: async (u: string) => { fetched.push(u); return "<html><body>новая вёрстка</body></html>"; } };
    const r = await runConstructionRegistrySync({ source: broken });
    expect(fetched.length).toBeLessThan(30); // остановились, не обошли все
    expect(r.error).toMatch(/вёрстка/);
    const after = await prisma.constructionProject.findUniqueOrThrow({ where: { sourceId: "v0" } });
    expect(after.address).toBe(before.address);
  });

  it("автосвязь при создании: объект рядом с проектом связывается сразу, без недельного забора", async () => {
    await runConstructionRegistrySync({ source: makeSource(() => [item("z1", "green", "Зэ")]) });
    await prisma.constructionPropertyLink.deleteMany({});
    const { autoLinkPropertyById } = await import("../src/lib/constructionRegistry/autoLinkOnSave.js");
    await autoLinkPropertyById(propertyNear);
    expect(await prisma.constructionPropertyLink.count({ where: { propertyId: propertyNear, state: "LINKED" } })).toBe(1);
  });

  it("слишком много неразобранных строк: ничего не применяется", async () => {
    const good = Array.from({ length: 24 }, (_, i) => item(`s${i}`, "green", `Эс ${i}`, 38.6 + i / 1000, 68.9));
    await runConstructionRegistrySync({ source: makeSource(() => good) });
    const broken = [...good.slice(0, 20), ...Array.from({ length: 10 }, (_, i) => ({ id: `bad${i}`, lat: 0, lng: 0, color_status: "green" }))];
    const r = await runConstructionRegistrySync({ source: makeSource(() => broken) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Не разобрано");
    expect(await prisma.constructionProject.count({ where: { removedAt: null } })).toBe(24);
  });

  it("проект без названия застройщика не получает общего застройщика с чужим рейтингом", async () => {
    await runConstructionRegistrySync({ source: makeSource(() => [item("n1", "green", "ҶДММ"), item("n2", "red", "")]) });
    expect(await prisma.constructionDeveloper.count()).toBe(2);
  });

  it("связь с исчезнувшим из реестра проектом не показывается как текущая", async () => {
    const list = Array.from({ length: 24 }, (_, i) => item(`r${i}`, "green", `Эр ${i}`, i === 0 ? 38.5556 : 38.6 + i / 1000, i === 0 ? 68.7575 : 68.9));
    await runConstructionRegistrySync({ source: makeSource(() => list) });
    const prop = toMatchInput(await prisma.property.findUniqueOrThrow({ where: { id: propertyNear } }));
    expect((await buildPropertyResponse(prop, true)).link).not.toBeNull();
    await runConstructionRegistrySync({ source: makeSource(() => list.slice(1)) });
    expect((await buildPropertyResponse(prop, true)).link).toBeNull();
  });

  it("реестр ещё не загружен: notLoaded, а не «не найден»", async () => {
    const prop = toMatchInput(await prisma.property.findUniqueOrThrow({ where: { id: propertyFar } }));
    const v = await buildPropertyResponse(prop, true);
    expect(v.notLoaded).toBe(true);
    expect(v.notFound).toBe(false);
  });

  it("уведомление уходит один раз: повторный запуск не шлёт то же снова", async () => {
    await runConstructionRegistrySync({ source: makeSource(() => [item("t1", "green", "Тэ")]) });
    const r1 = await runConstructionRegistrySync({ source: makeSource(() => [item("t1", "red", "Тэ")]) });
    expect(r1.notified).toBe(1);
    const { notifyStatusChanges } = await import("../src/lib/constructionRegistry/sync.js");
    expect(await notifyStatusChanges()).toBe(0);
  });
});
