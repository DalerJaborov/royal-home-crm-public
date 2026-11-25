import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * РЕЕСТР СТРОЕК: ПЕРЕСЧЁТ АВТОСВЯЗИ, ОПОВЕЩЕНИЕ И ЗНАЧОК В СПИСКЕ (25.11.2026, с находками ревью PR #434).
 *  - AUTO-связь пересчитывается: признаки ушли — снимается, нашёлся другой проект — переезжает, точку стёрли — снимается;
 *    ручную связь автоматика не трогает.
 *  - Связь с жёлтым/красным — одно сообщение ответственному агенту; не автору сохранения; пакетный пересчёт после забора не
 *    шлёт ничего; про одну связь не чаще раза в сутки (и смена цвета тоже); рубильник выключен — ни одного.
 *  - GET /properties отдаёт registry; «проверить» только у новостроек Душанбе; в группе Шабнам без буквы оценки.
 * Адреса придуманы по образцу, не выгрузка.
 */
const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { autoLinkPropertyById } = await import("../src/lib/constructionRegistry/autoLinkOnSave.js");
const { autoLinkAllProperties, linkPropertyManually } = await import("../src/lib/constructionRegistry/link.js");
const { notifyStatusChanges } = await import("../src/lib/constructionRegistry/sync.js");
const { registryNotesFor, tajikRegistryLine } = await import("../src/ai/assistant/tools/registryBrief.js");

const runId = String(Date.now()).slice(-8);
const LAT = 38.5612;
const LNG = 68.7841;
const password = "testpass123";
let agentId = "";
let otherAgentId = "";
let districtId = "";
let propertyId = "";
let outsideId = "";
let developerId = "";
let redProjectId = "";
let greenProjectId = "";
let syncRunId = "";
let token = "";
let prev = { enabled: true, notify: true };

async function setSwitches(enabled: boolean, notify: boolean) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { constructionRegistryEnabled: enabled, constructionRegistryNotify: notify },
    create: { id: "singleton", constructionRegistryEnabled: enabled, constructionRegistryNotify: notify },
  });
}

const notesForAgent = () => prisma.notification.count({ where: { agentId, tag: { startsWith: `construction-registry-` } } });
const linkOf = () => prisma.constructionPropertyLink.findFirst({ where: { propertyId, state: "LINKED" } });
const resetLinks = async () => {
  await prisma.constructionPropertyLink.deleteMany({ where: { propertyId } });
  await prisma.notification.deleteMany({ where: { agentId } });
};

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { constructionRegistryEnabled: true, constructionRegistryNotify: true } });
  prev = { enabled: s?.constructionRegistryEnabled ?? true, notify: s?.constructionRegistryNotify ?? true };
  await setSwitches(true, true);
  districtId = (await prisma.district.create({ data: { name: `Район пересчёта ${runId}`, city: "Душанбе" } })).id;
  const hash = await bcrypt.hash(password, 10);
  agentId = (await prisma.agent.create({ data: { fullName: "Агент пересчёта", phone: `+992975${runId}`, role: "AGENT", passwordHash: hash } })).id;
  otherAgentId = (await prisma.agent.create({ data: { fullName: "Коллега пересчёта", phone: `+992974${runId}`, role: "AGENT", passwordHash: hash } })).id;
  developerId = (await prisma.constructionDeveloper.create({ data: { nameNormalized: `пересчёт ${runId}`, displayName: `Застройщик ${runId}` } })).id;
  const project = (sourceId: string, address: string, colorStatus: "RED" | "GREEN", dLat: number) =>
    prisma.constructionProject.create({
      data: {
        sourceId: `${sourceId}-${runId}`, qaror: `${runId}-2024`, title: "Бинои истиқоматӣ", customer: `Застройщик ${runId}`, developerId,
        lat: LAT + dLat, lng: LNG, category: "residential", colorStatus, sourceUrl: "https://www.memor.pro/sokhtmon/test/", listHash: "t", address,
      },
    });
  // Красный «№№40, 42» в 30 м, зелёный «№50» в 120 м; третий проект далеко — чтобы у застройщика была буква оценки.
  redProjectId = (await project("red", "кӯчаи Тестоваяи Нав №№40, 42", "RED", 0.00027)).id;
  greenProjectId = (await project("green", "кӯчаи Тестоваяи Нав №50", "GREEN", 0.00108)).id;
  await project("far", "кӯчаи Дигар №1", "GREEN", 0.05);
  syncRunId = (await prisma.constructionSyncRun.create({ data: { trigger: "manual", ok: true, finishedAt: new Date() } })).id;
  const base = { type: "APARTMENT" as const, areaSqm: 70, price: 60000, currency: "USD" as const, districtId, condition: "NEW_BUILDING" as const, status: "AVAILABLE" as const, intakeAgentId: agentId, createdById: agentId, assignedAgentId: agentId };
  propertyId = (await prisma.property.create({ data: { ...base, title: `Новостройка пересчёта ${runId}`, address: "улица Тестоваяи Нав, 42", lat: LAT, lng: LNG } })).id;
  // Вне Душанбе (Вахдат): реестр душанбинский, «проверить» здесь не показываем.
  outsideId = (await prisma.property.create({ data: { ...base, title: `Новостройка за городом ${runId}`, address: "Вахдат", lat: 38.556, lng: 69.02 } })).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone: `+992975${runId}`, password })).body.accessToken as string;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.constructionPropertyLink.deleteMany({ where: { propertyId: { in: [propertyId, outsideId] } } });
  await prisma.constructionStatusChange.deleteMany({ where: { project: { developerId } } });
  await prisma.constructionSyncRun.deleteMany({ where: { id: syncRunId } });
  await prisma.constructionProject.deleteMany({ where: { developerId } });
  await prisma.constructionDeveloper.deleteMany({ where: { id: developerId } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, outsideId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await setSwitches(prev.enabled, prev.notify);
});

describe("автосвязь: пересчёт и оповещение", () => {
  it("сохранил коллега: улица и дом 42 в 30 м — связь с красным и ОДНО сообщение ответственному", async () => {
    expect(await autoLinkPropertyById(propertyId, otherAgentId)).toBe("linked");
    const link = await linkOf();
    expect(link?.projectId).toBe(redProjectId);
    expect(link?.method).toBe("AUTO");
    expect(link?.notifiedAt).not.toBeNull();
    expect(await notesForAgent()).toBe(1);
    expect(await autoLinkPropertyById(propertyId, otherAgentId)).toBe("kept");
    const n = await prisma.notification.findFirst({ where: { agentId, tag: `construction-registry-link-${propertyId}` }, select: { count: true, title: true } });
    expect(n?.count).toBe(1);
    expect(n?.title).not.toContain("—");
  });

  it("смена цвета в те же сутки — второго сообщения нет", async () => {
    await prisma.constructionStatusChange.create({ data: { projectId: redProjectId, fromColor: "RED", toColor: "YELLOW" } });
    await notifyStatusChanges();
    expect(await notesForAgent()).toBe(1);
  });

  it("сохранил сам ответственный — связь есть, сообщения в ленту нет (он видит это сам)", async () => {
    await resetLinks();
    expect(await autoLinkPropertyById(propertyId, agentId)).toBe("linked");
    expect((await linkOf())?.notifiedAt).not.toBeNull();
    expect(await notesForAgent()).toBe(0);
  });

  it("пакетный пересчёт после забора: связь ставится, событие отмечено, сообщений нет", async () => {
    await resetLinks();
    await autoLinkAllProperties();
    const link = await linkOf();
    expect(link?.projectId).toBe(redProjectId);
    expect(link?.notifiedAt).not.toBeNull();
    expect(await notesForAgent()).toBe(0);
  });

  it("сменили дом на 50 — связь переезжает на зелёный проект (адрес подтверждён в 120 м)", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { address: "улица Тестоваяи Нав, 50" } });
    expect(await autoLinkPropertyById(propertyId, agentId)).toBe("moved");
    expect((await linkOf())?.projectId).toBe(greenProjectId);
    expect(await prisma.constructionPropertyLink.count({ where: { propertyId, projectId: redProjectId } })).toBe(0);
  });

  it("сменили адрес, точку стёрли — AUTO-связь снимается и дверью, и недельным пересчётом", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { address: "улица Тестоваяи Нав, 42", lat: null, lng: null } });
    expect(await autoLinkPropertyById(propertyId, agentId)).toBe("dropped");
    expect(await linkOf()).toBeNull();
    // Связь, оставшаяся от прежней версии без двери, снимается пересчётом после забора.
    await prisma.constructionPropertyLink.create({ data: { propertyId, projectId: redProjectId, state: "LINKED", method: "AUTO", confidence: 70, reasons: [] } });
    await autoLinkAllProperties();
    expect(await linkOf()).toBeNull();
    await prisma.property.update({ where: { id: propertyId }, data: { lat: LAT, lng: LNG } });
  });

  it("адрес без улицы — признаков нет, AUTO-связь снимается", async () => {
    await autoLinkPropertyById(propertyId, agentId);
    await prisma.property.update({ where: { id: propertyId }, data: { address: "ориентир: рядом с парком" } });
    expect(await autoLinkPropertyById(propertyId, agentId)).toBe("dropped");
    expect(await linkOf()).toBeNull();
  });

  it("ручную связь автоматика не трогает, даже без точки", async () => {
    await linkPropertyManually(propertyId, redProjectId, agentId);
    expect(await autoLinkPropertyById(propertyId, null)).toBe("manual");
    await prisma.property.update({ where: { id: propertyId }, data: { lat: null, lng: null } });
    expect(await autoLinkPropertyById(propertyId, null)).toBe("manual");
    expect((await linkOf())?.method).toBe("MANUAL");
    await prisma.property.update({ where: { id: propertyId }, data: { lat: LAT, lng: LNG } });
  });

  it("рубильник уведомлений выключен — связь ставится, сообщения нет", async () => {
    await resetLinks();
    await prisma.property.update({ where: { id: propertyId }, data: { address: "улица Тестоваяи Нав, 40" } });
    await setSwitches(true, false);
    expect(await autoLinkPropertyById(propertyId, otherAgentId)).toBe("linked");
    expect(await notesForAgent()).toBe(0);
    await setSwitches(true, true);
  });

  it("рубильник реестра выключен — дверь не делает ничего", async () => {
    await setSwitches(false, true);
    expect(await autoLinkPropertyById(propertyId, otherAgentId)).toBeNull();
    await setSwitches(true, true);
  });
});

describe("значок в списке и строка Шабнам", () => {
  const listItem = async (id: string) => {
    const res = await request(app).get(`/api/v1/properties?search=${encodeURIComponent(runId)}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body.items as { id: string; registry: unknown }[]).find((p) => p.id === id);
  };

  it("GET /properties отдаёт сотруднику registry: красный и буква застройщика по фактам", async () => {
    const item = await listItem(propertyId);
    expect(item, "объект в выдаче").toBeTruthy();
    expect(item!.registry).toMatchObject({ status: "red" });
    expect((item!.registry as { letter: string | null }).letter).not.toBeNull();
  });

  it("в группе Шабнам буквы оценки нет, в личке есть", async () => {
    const p = { id: propertyId, condition: "NEW_BUILDING" };
    const privateNote = (await registryNotesFor([p], { surface: "telegram-private" })).get(propertyId);
    const groupNote = (await registryNotesFor([p], { surface: "telegram-group" })).get(propertyId);
    expect(privateNote?.registry).toContain("оценка застройщика");
    expect(groupNote?.registry).not.toContain("оценка застройщика");
    expect(groupNote?.registryWarning).toBeTruthy();
  });

  it("новостройка Душанбе без связи — «проверить»; вне Душанбе — поля нет", async () => {
    await resetLinks();
    expect((await listItem(propertyId))!.registry).toEqual({ status: "none", letter: null });
    expect((await listItem(outsideId))!.registry).toBeNull();
  });
});

describe("тексты", () => {
  it("таджикская строка с датой реестра и «огоҳ кунед», без длинного тире", () => {
    const red = tajikRegistryLine("red", "21.11.2026");
    expect(red).toContain("21.11.2026");
    expect(red).toContain("огоҳ кунед");
    expect(red).not.toContain("—");
    expect(tajikRegistryLine("green", null)).not.toContain("{date}");
  });
  it("раздел промта: без зашитой даты и без длинного тире", async () => {
    const { ASSISTANT_REGISTRY_GUIDE } = await import("../src/ai/assistant/promptSections.js");
    expect(ASSISTANT_REGISTRY_GUIDE).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
    expect(ASSISTANT_REGISTRY_GUIDE).not.toContain("—");
    expect(ASSISTANT_REGISTRY_GUIDE).toContain("огоҳ кунед");
  });
  it("строки статуса в shared без длинного тире", () => {
    const shared = readFileSync(path.resolve(__dirname, "../../../packages/shared/src/constructionRegistry.ts"), "utf8");
    const fn = /export function registryBriefLine[\s\S]*?\n}\n/.exec(shared)?.[0] ?? "";
    expect(fn.length).toBeGreaterThan(50);
    expect(fn).not.toContain("—");
  });
});
