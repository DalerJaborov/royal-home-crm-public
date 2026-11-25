import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { autoLinkProperty } from "../src/lib/constructionRegistry/link.js";
import { applyRegistryChoice } from "../src/lib/constructionRegistry/autoLinkOnSave.js";
import { linkPropertyRegistryExecutor } from "../src/ai/assistant/tools/registryLinkTool.js";
import { howToFixLine } from "../src/ai/assistant/tools/registryBrief.js";
import { waitFor } from "./helpers/waitFor.js";
import type { AssistantActionActor } from "../src/lib/assistantActions.js";

/**
 * ПОЛЕ «ЗАСТРОЙЩИК И РАЗРЕШЕНИЕ» (25.11.2026): поиск по всему реестру, предпросмотр до создания, выбор сотрудника вместе
 * с объектом (ручная связь не затирается автоматикой, «нет в реестре» отвергает проекты рядом) и инструмент Шабнам
 * «привяжи объект к застройщику» с откатом.
 */
const runId = Date.now();
const tag = `пик${runId}`;
const password = "testpass123";
// Своя точка вдали от проектов соседних тестов (они стоят у 38.5556, 68.7575).
const BASE = { lat: 38.6 + (runId % 900) / 100_000, lng: 68.9 + (runId % 700) / 100_000 };
const metersNorth = (m: number) => BASE.lat + m / 111_320;

let districtId = "";
let ownerId = "";
let strangerId = "";
let ownerToken = "";
let strangerToken = "";
let developerId = "";
let syncRunId = "";
const projectIds: Record<string, string> = {};
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  return res.body.accessToken as string;
}

async function project(key: string, data: { title: string; address?: string; lat?: number; lng?: number; color?: "GREEN" | "YELLOW" | "RED"; qaror?: string; category?: string; removed?: boolean }) {
  const p = await prisma.constructionProject.create({
    data: {
      sourceId: `${tag}-${key}`,
      qaror: data.qaror ?? `${key}-2024`,
      title: data.title,
      customer: `Ширкати ${tag}`,
      developerId,
      lat: data.lat ?? BASE.lat,
      lng: data.lng ?? BASE.lng,
      category: data.category ?? "residential",
      colorStatus: data.color ?? "GREEN",
      sourceUrl: `https://www.memor.pro/sokhtmon/${tag}-${key}/`,
      listHash: "x",
      address: data.address ?? null,
      removedAt: data.removed ? new Date() : null,
    },
  });
  projectIds[key] = p.id;
  return p.id;
}

async function property(data: { address: string; lat?: number | null; lng?: number | null; condition?: string }) {
  const p = await prisma.property.create({
    data: {
      title: `Объект ${tag}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 50000,
      currency: "TJS",
      districtId,
      address: data.address,
      condition: (data.condition ?? "NEW_BUILDING") as "NEW_BUILDING",
      status: "AVAILABLE",
      intakeAgentId: ownerId,
      createdById: ownerId,
      assignedAgentId: ownerId,
      lat: data.lat === undefined ? BASE.lat : data.lat,
      lng: data.lng === undefined ? BASE.lng : data.lng,
    },
  });
  propertyIds.push(p.id);
  return p;
}

const linkOf = (propertyId: string) =>
  prisma.constructionPropertyLink.findFirst({ where: { propertyId, state: "LINKED" }, select: { projectId: true, method: true } });

beforeAll(async () => {
  const hash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Район ${tag}`, city: "Душанбе" } })).id;
  const ownerPhone = `+992961${String(runId).slice(-6)}`;
  const strangerPhone = `+992962${String(runId).slice(-6)}`;
  ownerId = (await prisma.agent.create({ data: { fullName: "Агент поля реестра", phone: ownerPhone, role: "AGENT", passwordHash: hash } })).id;
  strangerId = (await prisma.agent.create({ data: { fullName: "Чужой агент", phone: strangerPhone, role: "AGENT", passwordHash: hash } })).id;
  ownerToken = await login(ownerPhone);
  strangerToken = await login(strangerPhone);
  syncRunId = (await prisma.constructionSyncRun.create({ data: { trigger: "manual", ok: true, finishedAt: new Date() } })).id;
  developerId = (await prisma.constructionDeveloper.create({ data: { nameNormalized: `ширкати ${tag}`, displayName: `Ширкати ${tag}` } })).id;
  // Ҷ в названии: ищется и по «Ч», и по «Дж».
  await project("jamol", { title: `ЖК Ҷамол ${tag}`, address: "кӯчаи Айнӣ 101", lat: BASE.lat, lng: BASE.lng });
  await project("far", { title: `ЖК Далёкий ${tag}`, lat: metersNorth(5000), qaror: `77-${runId % 1000}` });
  await project("near2", { title: `ЖК Соседний ${tag}`, lat: metersNorth(120) });
  await project("school", { title: `Мактаб ${tag}`, category: "educational" });
  await project("gone", { title: `ЖК Пропавший ${tag}`, removed: true });
});

afterAll(async () => {
  await prisma.constructionPropertyLink.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.constructionProject.deleteMany({ where: { developerId } });
  await prisma.constructionDeveloper.deleteMany({ where: { id: developerId } });
  await prisma.constructionSyncRun.deleteMany({ where: { id: syncRunId } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /construction-registry/projects — поиск по всему реестру", () => {
  it("закрыт авторизацией", async () => {
    expect((await request(app).get(`/api/v1/construction-registry/projects?q=${encodeURIComponent(tag)}`)).status).toBe(401);
  });

  it("таджикские буквы и русское «дж» находят одно и то же; только жилые и не пропавшие", async () => {
    for (const q of [`Чамол ${tag}`, `Джамол ${tag}`, `ҷамол ${tag}`]) {
      const res = await request(app).get(`/api/v1/construction-registry/projects?q=${encodeURIComponent(q)}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([projectIds.jamol]);
      expect(res.body.items[0]).toMatchObject({ developer: `Ширкати ${tag}`, color: "green", address: "кӯчаи Айнӣ 101" });
    }
    const all = await request(app).get(`/api/v1/construction-registry/projects?q=${encodeURIComponent(tag)}`).set("Authorization", `Bearer ${ownerToken}`);
    const ids = all.body.items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(projectIds.school);
    expect(ids).not.toContain(projectIds.gone);
    expect(ids.length).toBe(3);
  });

  it("номер решения целиком; с точкой — ближние выше; потолок 20", async () => {
    const byQaror = await request(app).get(`/api/v1/construction-registry/projects?q=77-${runId % 1000}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(byQaror.body.items[0].id).toBe(projectIds.far);
    const near = await request(app)
      .get(`/api/v1/construction-registry/projects?q=${encodeURIComponent(`ЖК ${tag}`)}&lat=${BASE.lat}&lng=${BASE.lng}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(near.body.items.map((i: { id: string }) => i.id)).toEqual([projectIds.jamol, projectIds.near2, projectIds.far]);
    expect(near.body.items[0].distanceM).toBeLessThan(5);
    expect((await request(app).get("/api/v1/construction-registry/projects?limit=50").set("Authorization", `Bearer ${ownerToken}`)).status).toBe(400);
    expect((await request(app).get(`/api/v1/construction-registry/projects?lat=${BASE.lat}`).set("Authorization", `Bearer ${ownerToken}`)).status).toBe(400);
  });
});

describe("POST /construction-registry/match-preview — до создания объекта", () => {
  const preview = (body: object) => request(app).post("/api/v1/construction-registry/match-preview").set("Authorization", `Bearer ${ownerToken}`).send(body);

  it("та же улица и дом рядом — auto; ничего не пишет в базу", async () => {
    const before = await prisma.constructionPropertyLink.count({ where: { projectId: projectIds.jamol } });
    const res = await preview({ lat: BASE.lat, lng: BASE.lng, address: "улица Айни, 101", isNewBuilding: true });
    expect(res.status).toBe(200);
    expect(res.body.level).toBe("auto");
    expect(res.body.best.id).toBe(projectIds.jamol);
    expect(res.body.alternatives.map((a: { id: string }) => a.id)).toContain(projectIds.near2);
    expect(await prisma.constructionPropertyLink.count({ where: { projectId: projectIds.jamol } })).toBe(before);
  });

  it("новостройка рядом без адреса — догадка suggest; далеко — none; без точки — noPoint", async () => {
    const guess = await preview({ lat: metersNorth(120), lng: BASE.lng, address: "", isNewBuilding: true });
    expect(guess.body.level).toBe("suggest");
    expect(guess.body.best).not.toBeNull();
    const far = await preview({ lat: metersNorth(2500), lng: BASE.lng, isNewBuilding: true });
    expect(far.body).toMatchObject({ level: "none", best: null });
    const none = await preview({ lat: null, lng: null });
    expect(none.body).toMatchObject({ noPoint: true, level: "none" });
  });
});

describe("выбор сотрудника вместе с объектом", () => {
  it("мастер: выбранный проект сохраняется ручной связью, автоматика её не затирает при смене точки", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        type: "APARTMENT",
        areaSqm: 55,
        rooms: 2,
        floor: 3,
        totalFloors: 9,
        windowCount: 3,
        price: 310000,
        currency: "TJS",
        districtId,
        address: `Тестовая выбора ${tag}, 5`,
        condition: "NEW_BUILDING",
        ownerContact: `+992938${String(runId).slice(-6)}`,
        intakeAgentId: ownerId,
        lat: BASE.lat,
        lng: BASE.lng,
        registry: { kind: "project", projectId: projectIds.far },
      });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const id = res.body.id as string;
    propertyIds.push(id);
    const link = await waitFor(() => linkOf(id), { label: "ручная связь после создания" });
    expect(link).toMatchObject({ projectId: projectIds.far, method: "MANUAL" });
    // Сменили точку прямо на проект «Ҷамол» — ручную связь автоматика не трогает.
    await prisma.property.update({ where: { id }, data: { address: "кӯчаи Айнӣ 101" } });
    expect(await autoLinkProperty(id, { notify: false })).toBe("manual");
    expect(await linkOf(id)).toMatchObject({ projectId: projectIds.far, method: "MANUAL" });
  });

  it("неверный выбор отвергается схемой (400), а не молча", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ type: "APARTMENT", areaSqm: 55, price: 1, currency: "TJS", districtId, address: "x", condition: "GOOD", registry: { kind: "project", projectId: "не-uuid" } });
    expect(res.status).toBe(400);
  });

  it("«нет в реестре»: связь снимается, проекты рядом отвергаются, автосвязь их не возвращает", async () => {
    const p = await property({ address: "кӯчаи Айнӣ 101" });
    expect(await autoLinkProperty(p.id, { notify: false })).toBe("linked");
    expect(await applyRegistryChoice(p.id, { kind: "none" }, ownerId)).toBe("not-in-registry");
    expect(await linkOf(p.id)).toBeNull();
    const rejected = await prisma.constructionPropertyLink.findMany({ where: { propertyId: p.id, state: "REJECTED" }, select: { projectId: true } });
    expect(rejected.map((r) => r.projectId).sort()).toEqual([projectIds.jamol, projectIds.near2].sort());
    expect(await autoLinkProperty(p.id, { notify: false })).toBe("none");
  });

  it("без выбора — та же автосвязь, что раньше", async () => {
    const p = await property({ address: "кӯчаи Айнӣ 101" });
    expect(await applyRegistryChoice(p.id, undefined, ownerId)).toBe("linked");
    expect(await linkOf(p.id)).toMatchObject({ projectId: projectIds.jamol, method: "AUTO" });
  });

  it("POST /property/:id/none: чужому агенту нельзя, ответственному можно", async () => {
    const p = await property({ address: "кӯчаи Айнӣ 101" });
    await autoLinkProperty(p.id, { notify: false });
    const denied = await request(app).post(`/api/v1/construction-registry/property/${p.id}/none`).set("Authorization", `Bearer ${strangerToken}`);
    expect(denied.status).toBe(403);
    expect(await linkOf(p.id)).not.toBeNull();
    const ok = await request(app).post(`/api/v1/construction-registry/property/${p.id}/none`).set("Authorization", `Bearer ${ownerToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.link).toBeNull();
    expect(ok.body.suggestions).toEqual([]);
  });
});

describe("Шабнам: link_property_to_registry", () => {
  const actor = (agentId: string): AssistantActionActor => ({ agentId, channel: "telegram", telegramPrivate: true, can: () => false });

  async function run(agentId: string, raw: object) {
    const args = linkPropertyRegistryExecutor.parseArgs(raw);
    const a = actor(agentId);
    const snapshotBefore = await linkPropertyRegistryExecutor.snapshot(args, a);
    const out = await linkPropertyRegistryExecutor.execute(args, a, { actionId: "t", snapshotBefore });
    return { args, a, snapshotBefore, out };
  }

  it("одно уверенное совпадение — ручная связь; откат возвращает прежнюю автосвязь", async () => {
    const p = await property({ address: "кӯчаи Айнӣ 101" });
    await autoLinkProperty(p.id, { notify: false });
    const { args, a, snapshotBefore, out } = await run(ownerId, { ref: String(p.shortId), project: `Далёкий ${tag}` });
    expect(await linkOf(p.id)).toMatchObject({ projectId: projectIds.far, method: "MANUAL" });
    await linkPropertyRegistryExecutor.undo!(args, a, { actionId: "t", snapshotBefore, snapshotAfter: {}, result: out.result });
    expect(await linkOf(p.id)).toMatchObject({ projectId: projectIds.jamol, method: "AUTO" });
    expect(await prisma.constructionPropertyLink.count({ where: { propertyId: p.id, projectId: projectIds.far } })).toBe(0);
  });

  it("несколько совпадений — отказ со списком вариантов, ничего не пишет", async () => {
    const p = await property({ address: "без улицы" });
    await expect(run(ownerId, { ref: String(p.shortId), project: `ЖК ${tag}` })).rejects.toMatchObject({ status: 409, code: "AMBIGUOUS_PROJECT" });
    try {
      await run(ownerId, { ref: String(p.shortId), project: `ЖК ${tag}` });
    } catch (err) {
      const candidates = (err as { extra: { candidates: { projectId: string }[] } }).extra.candidates;
      expect(candidates.length).toBe(3);
    }
    expect(await linkOf(p.id)).toBeNull();
  });

  it("чужой объект без права править чужие — 403", async () => {
    const p = await property({ address: "без улицы" });
    await expect(run(strangerId, { ref: String(p.shortId), project: `Далёкий ${tag}` })).rejects.toMatchObject({ status: 403 });
  });

  it("строка после создания подсказывает, как исправить словами", async () => {
    const p = await property({ address: "", lat: metersNorth(120) });
    const ru = await howToFixLine(p, "ru");
    expect(ru).toContain("Назовите застройщика или комплекс, привяжу.");
    expect(ru).toContain("Похоже на «");
    expect(ru).not.toContain("—");
    expect(await howToFixLine(p, "tg")).toContain("пайваст мекунам");
  });
});
