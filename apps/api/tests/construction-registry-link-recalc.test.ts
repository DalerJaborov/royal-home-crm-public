import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * РЕЕСТР СТРОЕК: ПЕРЕСЧЁТ АВТОСВЯЗИ, ОПОВЕЩЕНИЕ И ЗНАЧОК В СПИСКЕ (25.11.2026).
 *  - AUTO-связь пересчитывается при смене адреса: признаки ушли — связь снимается, нашёлся другой проект — переезжает;
 *    ручную связь автоматика не трогает.
 *  - Связь с жёлтым/красным проектом — одно сообщение ответственному агенту; повтор не шлётся; рубильник выключен — ни одного.
 *  - GET /properties отдаёт сотруднику поле registry; публичная ссылка про реестр молчит (охрана — construction-registry-private).
 * Адреса придуманы по образцу, не выгрузка.
 */
const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { autoLinkPropertyById } = await import("../src/lib/constructionRegistry/autoLinkOnSave.js");
const { linkPropertyManually } = await import("../src/lib/constructionRegistry/link.js");

const runId = String(Date.now()).slice(-8);
const LAT = 38.5612;
const LNG = 68.7841;
const password = "testpass123";
let agentId = "";
let districtId = "";
let propertyId = "";
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

const notesForAgent = () => prisma.notification.count({ where: { agentId, tag: `construction-registry-link-${propertyId}` } });
const linkOf = () => prisma.constructionPropertyLink.findFirst({ where: { propertyId, state: "LINKED" } });

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { constructionRegistryEnabled: true, constructionRegistryNotify: true } });
  prev = { enabled: s?.constructionRegistryEnabled ?? true, notify: s?.constructionRegistryNotify ?? true };
  await setSwitches(true, true);
  districtId = (await prisma.district.create({ data: { name: `Район пересчёта ${runId}`, city: "Душанбе" } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент пересчёта", phone: `+992975${runId}`, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })
  ).id;
  developerId = (await prisma.constructionDeveloper.create({ data: { nameNormalized: `пересчёт ${runId}`, displayName: `Застройщик ${runId}` } })).id;
  const project = (sourceId: string, address: string, colorStatus: "RED" | "GREEN", dLat: number) =>
    prisma.constructionProject.create({
      data: {
        sourceId: `${sourceId}-${runId}`, qaror: `${runId}-2024`, title: "Бинои истиқоматӣ", customer: `Застройщик ${runId}`, developerId,
        lat: LAT + dLat, lng: LNG, category: "residential", colorStatus, sourceUrl: "https://www.memor.pro/sokhtmon/test/", listHash: "t", address,
      },
    });
  // Красный — «кӯчаи Тестовая №№40, 42» в 30 м; зелёный — «кӯчаи Тестовая №50» в 120 м.
  redProjectId = (await project("red", "кӯчаи Тестоваяи Нав №№40, 42", "RED", 0.00027)).id;
  greenProjectId = (await project("green", "кӯчаи Тестоваяи Нав №50", "GREEN", 0.00108)).id;
  syncRunId = (await prisma.constructionSyncRun.create({ data: { trigger: "manual", ok: true, finishedAt: new Date() } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Новостройка пересчёта ${runId}`, type: "APARTMENT", areaSqm: 70, price: 60000, currency: "USD", districtId,
        address: "улица Тестоваяи Нав, 42", condition: "NEW_BUILDING", status: "AVAILABLE", lat: LAT, lng: LNG,
        intakeAgentId: agentId, createdById: agentId, assignedAgentId: agentId,
      },
    })
  ).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone: `+992975${runId}`, password })).body.accessToken as string;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.constructionPropertyLink.deleteMany({ where: { propertyId } });
  await prisma.constructionSyncRun.deleteMany({ where: { id: syncRunId } });
  await prisma.constructionProject.deleteMany({ where: { developerId } });
  await prisma.constructionDeveloper.deleteMany({ where: { id: developerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await setSwitches(prev.enabled, prev.notify);
});

describe("автосвязь: пересчёт и оповещение", () => {
  it("улица и дом 42 в 30 м — связь с красным проектом и ОДНО сообщение агенту", async () => {
    expect(await autoLinkPropertyById(propertyId)).toBe("linked");
    const link = await linkOf();
    expect(link?.projectId).toBe(redProjectId);
    expect(link?.method).toBe("AUTO");
    expect(link?.notifiedAt).not.toBeNull();
    expect(await notesForAgent()).toBe(1);
    // Повторная правка без изменений — связь та же, сообщения нового нет.
    expect(await autoLinkPropertyById(propertyId)).toBe("kept");
    const n = await prisma.notification.findFirst({ where: { agentId, tag: `construction-registry-link-${propertyId}` }, select: { count: true } });
    expect(n?.count ?? 1).toBe(1);
  });

  it("сменили дом на 50 — связь переезжает на зелёный проект (адрес подтверждён в 120 м)", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { address: "улица Тестоваяи Нав, 50" } });
    expect(await autoLinkPropertyById(propertyId)).toBe("moved");
    expect((await linkOf())?.projectId).toBe(greenProjectId);
    // Прежняя AUTO-связь не стала «отвергнутой агентом»: красный проект снова может быть предложением.
    expect(await prisma.constructionPropertyLink.count({ where: { propertyId, projectId: redProjectId } })).toBe(0);
  });

  it("адрес без улицы — признаков нет, AUTO-связь снимается", async () => {
    await prisma.property.update({ where: { id: propertyId }, data: { address: "ориентир: рядом с парком" } });
    expect(await autoLinkPropertyById(propertyId)).toBe("dropped");
    expect(await linkOf()).toBeNull();
  });

  it("ручную связь автоматика не трогает; агенту, связавшему сам, сообщение не шлём", async () => {
    const before = await notesForAgent();
    await linkPropertyManually(propertyId, redProjectId, agentId);
    expect(await autoLinkPropertyById(propertyId)).toBe("manual");
    const link = await linkOf();
    expect(link?.method).toBe("MANUAL");
    expect(link?.projectId).toBe(redProjectId);
    expect(await notesForAgent()).toBe(before);
  });

  it("рубильник уведомлений выключен — связь ставится, сообщения нет", async () => {
    await prisma.constructionPropertyLink.deleteMany({ where: { propertyId } });
    await prisma.notification.deleteMany({ where: { agentId } });
    await prisma.property.update({ where: { id: propertyId }, data: { address: "улица Тестоваяи Нав, 40" } });
    await setSwitches(true, false);
    expect(await autoLinkPropertyById(propertyId)).toBe("linked");
    expect(await notesForAgent()).toBe(0);
    await setSwitches(true, true);
  });

  it("рубильник реестра выключен — автосвязь не делает ничего", async () => {
    await setSwitches(false, true);
    expect(await autoLinkPropertyById(propertyId)).toBeNull();
    await setSwitches(true, true);
  });
});

describe("значок в списке объектов", () => {
  it("GET /properties отдаёт сотруднику registry: красный, буква застройщика по фактам", async () => {
    const res = await request(app).get(`/api/v1/properties?search=${encodeURIComponent(`пересчёта ${runId}`)}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const item = (res.body.items as { id: string; registry: unknown }[]).find((p) => p.id === propertyId);
    expect(item, "объект в выдаче").toBeTruthy();
    expect(item!.registry).toEqual({ status: "red", letter: null });
  });

  it("новостройка без связи — «проверить» (status none)", async () => {
    await prisma.constructionPropertyLink.deleteMany({ where: { propertyId } });
    const res = await request(app).get(`/api/v1/properties?search=${encodeURIComponent(`пересчёта ${runId}`)}`).set("Authorization", `Bearer ${token}`);
    const item = (res.body.items as { id: string; registry: unknown }[]).find((p) => p.id === propertyId);
    expect(item!.registry).toEqual({ status: "none", letter: null });
  });
});
