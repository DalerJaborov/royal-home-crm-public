import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * РЕЕСТР СТРОЕК — ТОЛЬКО ДЛЯ НАС (решение владельца 20.11.2026): данные реестра не попадают в публичные ответы, синхронизацию
 * с сайтом, клиентского бота и рекламу. Охрана в двух слоях:
 *  1) СТАТИКА: к таблицам реестра и их коду обращаются только свои файлы (белый список). Любой новый файл, который потянется
 *     к реестру (бот, сайт, реклама, публичный маршрут), краснит этот тест, и об утечке придётся говорить осознанно.
 *  2) ПОВЕДЕНИЕ: у объекта есть связь с проектом реестра, а публичная ссылка и каталог Meta про это молчат.
 */
const SRC = path.resolve(__dirname, "../src");
const SHARED_SRC = path.resolve(__dirname, "../../../packages/shared/src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(path.resolve(__dirname, "../../.."), f).replace(/\\/g, "/");

/** Файлы, которым ЗАЛОЖЕНО работать с реестром (всё внутреннее для сотрудников). */
const ALLOWED = new Set([
  "apps/api/src/lib/constructionRegistry/parse.ts",
  "apps/api/src/lib/constructionRegistry/view.ts",
  "apps/api/src/lib/constructionRegistry/sync.ts",
  "apps/api/src/lib/constructionRegistry/link.ts",
  "apps/api/src/routes/constructionRegistry.ts",
  "apps/api/src/app.ts", // подключение маршрута сотрудников
  "apps/api/src/cron.ts", // еженедельный забор
  "apps/api/src/ai/assistant/tools/registryReadTool.ts", // внутренняя помощница Шабнам (только сотрудники, только личка)
  "packages/shared/src/constructionRegistry.ts",
  "packages/shared/src/index.ts",
]);

/** Внутренний помощник сотрудников (Шабнам): единственное место в ai/, которому реестр разрешён. */
const INTERNAL_ASSISTANT_TOOL = "apps/api/src/ai/assistant/tools/registryReadTool.ts";

/** Всё, что выдаёт реестр: таблицы Prisma, модуль, имена общих типов. */
const REGISTRY_REFERENCE =
  /constructionProject|constructionDeveloper|constructionPropertyLink|constructionStatusChange|constructionSyncRun|constructionLinks|constructionRegistry|ConstructionProject|ConstructionPropertyLink|ConstructionDeveloper|ConstructionStatusChange|ConstructionSyncRun|REGISTRY_COLOR_LABEL|RegistryColor|RegistryProjectDto/;

describe("реестр строек: охрана от утечки (статика)", () => {
  const files = [...walk(SRC), ...walk(SHARED_SRC)];

  it("к реестру обращаются только его собственные файлы", () => {
    const strangers = files
      .filter((f) => !ALLOWED.has(rel(f)))
      .filter((f) => REGISTRY_REFERENCE.test(readFileSync(f, "utf8")))
      .map(rel);
    // routes/settings.ts и useSettings знают только имена двух рубильников (constructionRegistryEnabled/Notify) — это не данные.
    const real = strangers.filter((f) => {
      const text = readFileSync(path.resolve(__dirname, "../../..", f), "utf8");
      const stripped = text.replace(/constructionRegistry(Enabled|Notify)/g, "");
      return REGISTRY_REFERENCE.test(stripped);
    });
    expect(real, `Файлы, которые не должны знать про реестр строек: ${real.join(", ")}`).toEqual([]);
  });

  it("публичные и клиентские слои реестра не касаются вовсе (сайт, бот, реклама, каталог, публичные маршруты)", () => {
    const outward = files.filter((f) => {
      const r = rel(f);
      if (r === INTERNAL_ASSISTANT_TOOL) return false;
      return (
        /apps\/api\/src\/(ai|messengers|telegram)\//.test(r) ||
        /apps\/api\/src\/lib\/(site|customer|public|ads|meta|social|publication|propertyPublic)/i.test(r) ||
        /apps\/api\/src\/routes\/(publicFeed|propertyShare|ownerReportPublic|ads|marketing|siteNotifications|webhooks|leadMagnets)/.test(r) ||
        /packages\/shared\/src\/(customer|site|ads|publicComment)/.test(r)
      );
    });
    expect(outward.length).toBeGreaterThan(30); // сторож не должен «молча» опустеть из-за смены папок
    const leaking = outward.filter((f) => REGISTRY_REFERENCE.test(readFileSync(f, "utf8"))).map(rel);
    expect(leaking).toEqual([]);
  });

  it("инструмент Шабнам скрыт в общей группе Telegram и недоступен вне личного чата", () => {
    const bot = readFileSync(path.resolve(SRC, "telegram/assistantBot.ts"), "utf8");
    const hidden = /GROUP_HIDDEN_TOOLS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(bot)?.[1] ?? "";
    expect(hidden).toContain('"get_construction_registry"');
    const tool = readFileSync(path.resolve(SRC, "ai/assistant/tools/registryReadTool.ts"), "utf8");
    expect(tool).toContain('"telegram-group"');
  });

  it("ни одно поле реестра не добавлено в модель Property (публичные выборки собирают поля именно с неё)", () => {
    const schema = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    const property = /\nmodel Property \{([\s\S]*?)\n\}\n/.exec(schema)?.[1] ?? "";
    expect(property.length).toBeGreaterThan(1000);
    // Единственное, что Property знает про реестр, — обратная связь Prisma на таблицу связей (без данных).
    const mentions = property.split("\n").filter((l) => /onstruction|registry|Registry/.test(l));
    expect(mentions.map((l) => l.trim())).toEqual(["constructionLinks ConstructionPropertyLink[]"]);
  });

  it("все маршруты реестра закрыты авторизацией", () => {
    const route = readFileSync(path.join(SRC, "routes/constructionRegistry.ts"), "utf8");
    const handlers = route.match(/constructionRegistryRouter\.(get|post|put|patch|delete)\(/g) ?? [];
    const guarded = route.match(/constructionRegistryRouter\.(get|post|put|patch|delete)\([^,]+,\s*requireAuth/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(6);
    expect(guarded.length).toBe(handlers.length);
  });
});

describe("реестр строек: охрана от утечки (поведение)", () => {
  const runId = Date.now();
  const password = "testpass123";
  const CUSTOMER = `Секретный Застройщик ${runId}`;
  let agentId = "";
  let districtId = "";
  let propertyId = "";
  let projectId = "";
  let developerId = "";
  let clientId = "";
  let syncRunId = "";
  let agentToken = "";
  let appRef: import("express").Express;
  let prismaRef: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    appRef = (await import("../src/app.js")).app;
    prismaRef = (await import("../src/db.js")).prisma;
    const passwordHash = await bcrypt.hash(password, 10);
    const district = await prismaRef.district.create({ data: { name: `Район реестра ${runId}`, city: "Душанбе" } });
    districtId = district.id;
    const agent = await prismaRef.agent.create({
      data: { fullName: "Агент реестра", phone: `+992976${runId}`, role: "AGENT", passwordHash },
    });
    agentId = agent.id;
    const client = await prismaRef.client.create({ data: { fullName: "Клиент реестра", phone: `+992977${runId}`, source: "PHONE_CALL", assignedAgentId: agentId } });
    clientId = client.id;
    const property = await prismaRef.property.create({
      data: {
        title: `Новостройка реестра ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 50000,
        currency: "TJS",
        districtId,
        address: "Тестовая реестра, 1",
        condition: "NEW_BUILDING",
        status: "AVAILABLE",
        intakeAgentId: agentId,
        createdById: agentId,
        assignedAgentId: agentId,
        lat: 38.5556,
        lng: 68.7575,
        publishedOnSite: true,
      },
    });
    propertyId = property.id;
    // Реестр «загружался»: без удачного забора сервер честно отвечает «ещё не загружен» и связи не показывает.
    syncRunId = (await prismaRef.constructionSyncRun.create({ data: { trigger: "manual", ok: true, finishedAt: new Date() } })).id;
    const developer = await prismaRef.constructionDeveloper.create({ data: { nameNormalized: `секретный застройщик ${runId}`, displayName: CUSTOMER } });
    developerId = developer.id;
    const project = await prismaRef.constructionProject.create({
      data: {
        sourceId: `private-${runId}`,
        qaror: "1-2020",
        title: "Секретный проект реестра",
        customer: CUSTOMER,
        developerId,
        lat: 38.5556,
        lng: 68.7575,
        category: "residential",
        colorStatus: "RED",
        sourceUrl: "https://www.memor.pro/sokhtmon/1-2020/",
        listHash: "x",
      },
    });
    projectId = project.id;
    await prismaRef.constructionPropertyLink.create({
      data: { propertyId, projectId, state: "LINKED", method: "AUTO", confidence: 90, reasons: ["секретная причина совпадения"] },
    });
    const res = await request(appRef).post("/api/v1/auth/login").send({ phone: `+992976${runId}`, password });
    agentToken = res.body.accessToken as string;
  });

  afterAll(async () => {
    await prismaRef.propertyShareLink.deleteMany({ where: { propertyId } });
    await prismaRef.constructionSyncRun.deleteMany({ where: { id: syncRunId } });
    await prismaRef.constructionPropertyLink.deleteMany({ where: { propertyId } });
    await prismaRef.constructionProject.deleteMany({ where: { id: projectId } });
    await prismaRef.constructionDeveloper.deleteMany({ where: { id: developerId } });
    await prismaRef.property.deleteMany({ where: { id: propertyId } });
    await prismaRef.client.deleteMany({ where: { id: clientId } });
    await prismaRef.agent.deleteMany({ where: { id: agentId } });
    await prismaRef.district.deleteMany({ where: { id: districtId } });
  });

  const leaks = (raw: string) => [CUSTOMER, "Секретный проект реестра", "секретная причина", "memor.pro", "construction", "colorStatus", "Сарраёсати"].filter((s) => raw.includes(s));

  it("публичная ссылка на объект молчит про реестр", async () => {
    const created = await request(appRef).post(`/api/v1/properties/${propertyId}/share-links`).set("Authorization", `Bearer ${agentToken}`).send({ clientId });
    expect(created.status).toBeLessThan(300);
    const pub = await request(appRef).get(`/api/v1/l/${created.body.token}`);
    expect(pub.status).toBe(200);
    expect(leaks(JSON.stringify(pub.body))).toEqual([]);
  });

  it("каталог Meta молчит про реестр", async () => {
    const { loadCatalogProperties } = await import("../src/lib/metaCatalogFeed.js");
    const rows = await loadCatalogProperties();
    expect(leaks(JSON.stringify(rows))).toEqual([]);
  });

  it("без входа реестр не отдаётся, со входом — отдаётся сотруднику", async () => {
    const anon = await request(appRef).get(`/api/v1/construction-registry/property/${propertyId}`);
    expect(anon.status).toBe(401);
    expect((await request(appRef).get("/api/v1/construction-registry/map")).status).toBe(401);
    const staff = await request(appRef).get(`/api/v1/construction-registry/property/${propertyId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(staff.status).toBe(200);
    expect(staff.body.link.project.customer).toBe(CUSTOMER);
    expect(staff.body.link.developer.rating.total).toBe(1);
  });
});
