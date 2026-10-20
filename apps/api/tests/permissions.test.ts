import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import {
  ASSIGNABLE_PERMISSIONS,
  LEAD_RECEIVING_ROLES,
  RATED_ROLES,
  ROLE_LABELS,
  ROLE_PRESET_SUMMARY,
  SALES_AGENT_ROLES,
  DIRECTOR_ONLY_PERMISSIONS,
  normalizeOverrides,
  PERMISSION_IDS,
  permissionOverridesSchema,
  resolvePermissions,
  ROLE_PRESETS,
} from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

const runId = Date.now();
const password = "testpass123";

let directorId: string;
let adminId: string;
let agentId: string;
/** Отдельная учётка для проверки мусора в колонке прав: её кэш доступа заведомо
 *  пуст, поэтому запись напрямую в БД читается сразу, без ожидания TTL. */
let rawWriteId: string;
let directorToken: string;
let adminToken: string;
let agentToken: string;
let rawWriteToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
  if (agent) grantElevation(agent.id);
  return res.body.accessToken as string;
}

/** Задать надстройки напрямую в БД — эмулирует и обход API (подделанную запись). */
async function setOverrides(id: string, overrides: unknown) {
  await prisma.agent.update({ where: { id }, data: { permissions: overrides as never } });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);

  const director = await prisma.agent.create({
    data: { fullName: "Права Директор", phone: `+992960${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const admin = await prisma.agent.create({
    data: { fullName: "Права Админ", phone: `+992961${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Права Агент", phone: `+992962${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  const rawWrite = await prisma.agent.create({
    data: { fullName: "Права Сырая-запись", phone: `+992963${runId}`, role: "ADMIN", passwordHash },
  });
  rawWriteId = rawWrite.id;

  directorToken = await login(director.phone);
  adminToken = await login(admin.phone);
  agentToken = await login(agent.phone);
  rawWriteToken = await login(rawWrite.phone);
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, adminId, agentId, rawWriteId] } } });
  await prisma.$disconnect();
});

describe("Реестр прав (чистые функции)", () => {
  it("директор получает весь реестр и его нельзя урезать через granted/revoked", () => {
    const all = resolvePermissions("DIRECTOR", { granted: [], revoked: [...PERMISSION_IDS] });
    // Исключение properties.moderate сняли 29.08.2026 («Вернуть DIRECTOR право
    // одобрять готовый Reels-ролик», 6b39a687). Правило снова без единой бреши:
    // директора нельзя урезать вообще ничем.
    expect(all.size).toBe(PERMISSION_IDS.length);
    expect(all.has("properties.moderate")).toBe(true);
  });

  it("админ по пресету получает все выдаваемые права без исключений (решение владельца 22.08.2026 — полная видимость)", () => {
    const perms = resolvePermissions("ADMIN", { granted: [], revoked: [] });
    expect([...perms].sort()).toEqual([...ASSIGNABLE_PERMISSIONS].sort());
  });

  it("механизм directorOnly по-прежнему вычёркивает всё, что в нём помечено — сейчас список пуст (14.09.2026: последние 4 владельческих права сняты, ADMIN = DIRECTOR), но код обязан продолжать работать, если директор пометит что-то новое", () => {
    // Пустой DIRECTOR_ONLY_PERMISSIONS документирует решение владельца, а не
    // забытый список — если он снова не пуст, цикл ниже проверяет тот же
    // инвариант, что и раньше: ни одно directorOnly-право не проходит через
    // granted ни для одной роли, кроме DIRECTOR.
    const perms = resolvePermissions("ADMIN", { granted: [...DIRECTOR_ONLY_PERMISSIONS], revoked: [] });
    for (const id of DIRECTOR_ONLY_PERMISSIONS) {
      expect(perms.has(id)).toBe(false);
    }
    expect(DIRECTOR_ONLY_PERMISSIONS).toEqual([]);
  });

  it("revoked сильнее granted — снятая галочка не возвращается через granted", () => {
    const perms = resolvePermissions("ADMIN", { granted: ["finance.view"], revoked: ["finance.view"] });
    expect(perms.has("finance.view")).toBe(false);
  });

  it("normalizeOverrides не хранит то, что и так даёт роль", () => {
    // finance.view уже есть у ADMIN — в granted ему делать нечего.
    const normalized = normalizeOverrides("ADMIN", { granted: ["finance.view"], revoked: [] });
    expect(normalized.granted).toEqual([]);
    // archive.view у агента нет — это настоящая надстройка.
    const forAgent = normalizeOverrides("AGENT", { granted: ["archive.view"], revoked: [] });
    expect(forAgent.granted).toEqual(["archive.view"]);
  });

  it("у агента по умолчанию восемь прав — свои разговоры, вложения, чаты своих клиентов, заявки на удаление клиента/объекта, заявка на изменение опубликованного и канал обращения", () => {
    /**
     * Пресет агента был пустым с самого появления реестра: «работает только со
     * своими карточками — никаких прав сверх этого». 15.08.2026 владелец добавил
     * первое: записи и расшифровки СВОИХ звонков («его звонки он сам может и
     * видеть, и посмотреть расшифровку, или прослушать»). Чужие разговоры остались
     * за calls.transcripts — проверка на это лежит в call-transcripts-privacy.
     * 17.08.2026 владелец добавил второе — messages.viewAttachments: агент, который
     * сам звонит своему клиенту, должен слышать голосовое и видеть фото из
     * переписки, а не карточку с пометкой «доступно руководству». До этого правом
     * владели только админ и директор.
     *
     * 30.08.2026 владелец добавил третье — clients.requestDelete: «дать агентам
     * возможность направить клиента на удаление на моё рассмотрение». Право даёт
     * только ЗАЯВКУ: карточка остаётся на месте, удаляет её админ или директор по
     * clients.delete (routes/clients/deleteRequests.ts).
     *
     * 31.08.2026 — зеркально четвёртое, properties.requestDelete: то же самое для
     * карточки объекта (routes/properties/deleteRequests.ts).
     *
     * 07.09.2026 владелец добавил пятое — messages.viewOwn: «календарь убери,
     * вместо него чат был... переписки у всех агентов не работают, почини везде».
     * Это НЕ messages.view: то право открыло бы заодно комментарии под публикациями
     * и просьбы о звонке — работу руководства. Здесь только раздел переписок,
     * суженный сервером до клиентов, закреплённых за агентом, и только принятых
     * (routes/conversations.ts, тест inbox-agent-scope).
     *
     * 12.09.2026 владелец добавил шестое — clients.viewOrigin, ОТМЕНИВ собственный
     * запрет от 17.08.2026: «пусть любой агент видит, откуда пришёл клиент и в
     * каком мессенджере общаются». Право оставлено в системе (директор может снять
     * его точечно у конкретного сотрудника), но выдано всеми пресетами.
     *
     * 07.10.2026 — properties.requestChange: «после публикации агент карточку не
     * правит, а просит» (routes/properties/changeRequests.ts). Решают те, у кого
     * properties.delete.
     *
     * Список сверяется целиком, а не «содержит»: пресет агента — то место, куда
     * права попадают незаметно, и каждое новое обязано быть решением владельца.
     */
    const AGENT_PRESET = [
      "calls.ownTranscripts",
      "messages.viewAttachments",
      // 11.09.2026 владелец: документы своей сделки агент загружает сам —
      // deals.manageDocuments (сверка владения в routes/dealDocuments.ts).
      "deals.manageDocuments",
      "messages.viewOwn",
      "clients.requestDelete",
      "properties.requestDelete",
      "properties.requestChange",
      "clients.viewOrigin",
    ];
    expect(ROLE_PRESETS.AGENT).toEqual(AGENT_PRESET);
    expect([...resolvePermissions("AGENT", null)]).toEqual(AGENT_PRESET);
  });
});

describe("properties.viewAll разбито на viewOwners/editForeign (слой 3, удалено в слое 4, 08.09.2026)", () => {
  it("без старого id новые права не появляются сами по себе", () => {
    const perms = resolvePermissions("AGENT", null);
    expect(perms.has("properties.viewOwners")).toBe(false);
    expect(perms.has("properties.editForeign")).toBe(false);
  });

  it("properties.viewAll удалено из реестра — щит сотрудника не предлагает его новым назначением", () => {
    expect(ASSIGNABLE_PERMISSIONS).not.toContain("properties.viewAll");
    expect(ASSIGNABLE_PERMISSIONS).toContain("properties.viewOwners");
    expect(ASSIGNABLE_PERMISSIONS).toContain("properties.editForeign");
  });

  it("устаревший id из старого клиента отбрасывается схемой мягко, не 400-ит запрос (шаг 6 слоя 4)", () => {
    const parsed = permissionOverridesSchema.safeParse({
      granted: ["properties.viewAll", "properties.viewOwners"],
      revoked: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.granted).toEqual(["properties.viewOwners"]);
    }
  });

  it("SECURITY по пресету видит контакты собственника, но не правит чужую карточку (roles-check.md §2.1)", () => {
    const security = resolvePermissions("SECURITY", null);
    expect(security.has("properties.viewOwners")).toBe(true);
    expect(security.has("properties.editForeign")).toBe(false);
  });

  it("EDITOR по пресету правит чужую карточку/файлы для монтажа, но не видит контакты собственника (roles-check.md §2.2)", () => {
    const editor = resolvePermissions("EDITOR", null);
    expect(editor.has("properties.viewOwners")).toBe(false);
    expect(editor.has("properties.editForeign")).toBe(true);
  });

  it("DIRECTOR/ADMIN/MANAGER/MARKETING по пресету получают оба права — прежний объём доступа не сузился", () => {
    for (const role of ["DIRECTOR", "ADMIN", "MANAGER", "MARKETING"] as const) {
      const perms = resolvePermissions(role, null);
      expect(perms.has("properties.viewOwners")).toBe(true);
      expect(perms.has("properties.editForeign")).toBe(true);
    }
  });

  it("AGENT по пресету по-прежнему не имеет ни одного из двух прав (не менялось)", () => {
    const perms = resolvePermissions("AGENT", null);
    expect(perms.has("properties.viewOwners")).toBe(false);
    expect(perms.has("properties.editForeign")).toBe(false);
  });
});

/**
 * «Экран маркетолога» из «Логики 2.0»: источники / часы обращений / CPL / ROI
 * живут на /sources, а он гейтится `reports.view`. Пресет MARKETING этого права
 * не имел вовсе — экран был построен и недоступен тому единственному, для кого
 * он делался.
 */
describe("Маркетологу открыт экран источников, но не руководящая аналитика", () => {
  it("MARKETING по пресету получает reports.view", () => {
    expect(resolvePermissions("MARKETING", null).has("reports.view")).toBe(true);
  });

  it("MARKETING по-прежнему БЕЗ dashboard.analytics и без денег", () => {
    const perms = resolvePermissions("MARKETING", null);
    // dashboard.analytics в этой CRM — маркер «руководящая часть»: им же открыты
    // «Контроль руководителя», «Пульс компании» и правка месячных отчётов.
    // Маркетологу нужны только часы обращений, а не рабочее место руководителя.
    expect(perms.has("dashboard.analytics")).toBe(false);
    expect(perms.has("finance.view")).toBe(false);
    expect(perms.has("clients.viewAll")).toBe(false);
  });
});

/**
 * ADMIN РАВЕН DIRECTOR ЦЕЛИКОМ (14.09.2026, явное решение владельца — задан
 * прямой вопрос про самоповышение админов друг друга и подтверждён ответ «да,
 * убрать»). До этой правки `permissions.manage` было directorOnly ИМЕННО ради
 * защиты от конкретной дыры (см. старый комментарий здесь и в
 * routes/agents.ts::forbiddenRoleGrant): «обладатель обычной галочки
 * `agents.manage` ставил себе ADMIN... Второй путь — завести себе новую
 * ADMIN-учётку». Теперь это ОСОЗНАННО разрешено: ADMIN — не сотрудник с
 * ограниченным набором прав, а второй владельческий аккаунт. Единственное,
 * что по-прежнему нельзя — тронуть учётку самого DIRECTOR (роль DIRECTOR не
 * выдаётся никем, кроме директора, её нельзя снять/удалить — см.
 * forbiddenDirectorTarget) и настроить права самого DIRECTOR.
 */
describe("ADMIN наравне с DIRECTOR — раздача прав, роли, вторые ADMIN-учётки", () => {
  it("админ читает чужие права", async () => {
    const res = await request(app)
      .get(`/api/v1/agents/${agentId}/permissions`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("админ выдаёт права и себе, и другому", async () => {
    for (const target of [adminId, agentId]) {
      const res = await request(app)
        .put(`/api/v1/agents/${target}/permissions`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ granted: ["finance.view"], revoked: [] });
      expect(res.status).toBe(200);
      await setOverrides(target, null); // не оставляем хвост надстроек другим тестам
    }
  });

  it("агент без permissions.manage по-прежнему не может выдать права даже себе", async () => {
    const res = await request(app)
      .put(`/api/v1/agents/${agentId}/permissions`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ granted: ["finance.view"], revoked: [] });
    expect(res.status).toBe(403);
  });

  it("директор выдаёт бывшие владельческие права как любые другие — их больше не отбрасывает", async () => {
    const res = await request(app)
      .put(`/api/v1/agents/${agentId}/permissions`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ granted: ["archive.view", "permissions.manage", "siteAdmin.reset"], revoked: [] });
    expect(res.status).toBe(200);
    expect(res.body.overrides.granted.sort()).toEqual(["archive.view", "permissions.manage", "siteAdmin.reset"].sort());
    await setOverrides(agentId, null); // не оставляем хвост надстроек другим тестам
  });

  it("права самого директора по-прежнему не настраиваются — учётка владельца защищена отдельно от этого права", async () => {
    const res = await request(app)
      .put(`/api/v1/agents/${directorId}/permissions`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ granted: [], revoked: ["finance.view"] });
    expect(res.status).toBe(400);
  });

  it("админ поднимает СЕБЕ роль до ADMIN через PATCH (уже ADMIN — операция без эффекта, но больше не 403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${adminId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "ADMIN" });
    expect(res.status).toBe(200);
  });

  it("админ повышает другого сотрудника до ADMIN", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "ADMIN" });
    expect(res.status).toBe(200);
    const after = await prisma.agent.findUnique({ where: { id: agentId }, select: { role: true } });
    expect(after?.role).toBe("ADMIN");
    // Возвращаем agentId обратно в AGENT — остальные тесты файла держат его
    // как рядового сотрудника.
    await prisma.agent.update({ where: { id: agentId }, data: { role: "AGENT" } });
  });

  it("админ заводит вторую ADMIN-учётку", async () => {
    const res = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: "Права Обход", phone: `+992964${runId}`, role: "ADMIN", password });
    expect(res.status).toBe(201);
    await prisma.agent.deleteMany({ where: { id: res.body.id } });
  });

  it("но роль DIRECTOR завести или выдать через POST/PATCH по-прежнему нельзя никому, кроме директора", async () => {
    const createAsAdmin = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: "Права Директор-обход", phone: `+992966${runId}`, role: "DIRECTOR", password });
    expect(createAsAdmin.status).toBe(403);

    const patchAsAdmin = await request(app)
      .patch(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "DIRECTOR" });
    expect(patchAsAdmin.status).toBe(403);
  });

  it("но обычного сотрудника админ заводит и правит как раньше", async () => {
    const created = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: "Права Обычный", phone: `+992965${runId}`, role: "AGENT", password });
    expect(created.status).toBe(201);
    const patched = await request(app)
      .patch(`/api/v1/agents/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "MANAGER" });
    expect(patched.status).toBe(200);
    await prisma.agent.deleteMany({ where: { id: created.body.id } });
  });
});

describe("Выданное право действительно открывает раздел", () => {
  it("агент без права не видит Корзину объектов, с правом — видит", async () => {
    await setOverrides(agentId, null);
    const before = await request(app).get("/api/v1/properties/trash").set("Authorization", `Bearer ${agentToken}`);
    expect(before.status).toBe(403);

    await request(app)
      .put(`/api/v1/agents/${agentId}/permissions`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ granted: ["archive.view"], revoked: [] })
      .expect(200);

    const after = await request(app).get("/api/v1/properties/trash").set("Authorization", `Bearer ${agentToken}`);
    expect(after.status).toBe(200);
  });

  it("выдача просмотра не даёт права изменять — удалить объект агент всё равно не может", async () => {
    const res = await request(app)
      .delete("/api/v1/properties/999999")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });
});

describe("Снятое право действует сразу, без перелогина", () => {
  it("у админа отбирают финансы — тот же токен немедленно получает отказ", async () => {
    const before = await request(app).get("/api/v1/expenses").set("Authorization", `Bearer ${adminToken}`);
    expect(before.status).toBe(200);

    await request(app)
      .put(`/api/v1/agents/${adminId}/permissions`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ granted: [], revoked: ["finance.view"] })
      .expect(200);

    const after = await request(app).get("/api/v1/expenses").set("Authorization", `Bearer ${adminToken}`);
    expect(after.status).toBe(403);
  });

  it("отключение учётки немедленно закрывает доступ по старому токену", async () => {
    await request(app)
      .patch(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ isActive: false })
      .expect(200);

    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);

    await request(app)
      .patch(`/api/v1/agents/${agentId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ isActive: true })
      .expect(200);
  });
});

describe("Подделанная запись в базе не повышает права", () => {
  /**
   * ДО 14.09.2026 ЭТОТ ТЕСТ ПРОВЕРЯЛ ДРУГОЕ: `permissions.manage`/`siteAdmin.reset`
   * были directorOnly, и даже раскопанная в базе (напрямую, в обход API) запись
   * с ними в granted не давала admin'у прав — resolvePermissions вычёркивала
   * directorOnly-права безусловно. Теперь оба права обычные ASSIGNABLE — ADMIN
   * получает их уже из ПРЕСЕТА РОЛИ, без всякой надстройки в БД (см. описание
   * "ADMIN наравне с DIRECTOR" выше). Раскопанная запись ничего не меняет,
   * потому что праву и так неоткуда быть отобранным. Реальная защита от
   * подделанной directorOnly-записи проверяется чистой функцией выше
   * ("механизм directorOnly по-прежнему вычёркивает...") — там же и стоит
   * искать эту гарантию, если директор снова пометит что-то directorOnly.
   */
  it("админ имеет доступ к чужим правам уже из пресета роли — раскопанная запись в БД тут не при чём", async () => {
    await setOverrides(adminId, { granted: ["permissions.manage", "siteAdmin.reset"], revoked: [] });
    const res = await request(app)
      .get(`/api/v1/agents/${agentId}/permissions`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    await setOverrides(adminId, null);
  });

  it("мусор в колонке прав не роняет запрос и трактуется как «нет надстроек»", async () => {
    await setOverrides(rawWriteId, { granted: ["такого.права.нет", 42, null], revoked: "не массив" });
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${rawWriteToken}`);
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual(expect.arrayContaining(["finance.view"]));
  });
});

describe("calls.hearRecording — прослушивание записи отдельно от чтения (04.09.2026)", () => {
  /**
   * Владелец сузил решение 15.08.2026 («агент слышит и читает свой разговор»):
   * слушать теперь может только DIRECTOR/ADMIN, SECURITY и MARKETING — читать
   * расшифровку и совет по-прежнему может любой держатель calls.transcripts/
   * calls.ownTranscripts (не тронуто). См. lib/callTranscripts.ts.
   */
  it("DIRECTOR получает calls.hearRecording в полном наборе прав", () => {
    expect(resolvePermissions("DIRECTOR").has("calls.hearRecording")).toBe(true);
  });

  it("ADMIN получает calls.hearRecording — как и любое другое выдаваемое право (пресет = все ASSIGNABLE_PERMISSIONS)", () => {
    expect(resolvePermissions("ADMIN").has("calls.hearRecording")).toBe(true);
  });

  it("SECURITY получает calls.hearRecording вместе с calls.transcripts — полный доступ к любому разговору", () => {
    const perms = resolvePermissions("SECURITY");
    expect(perms.has("calls.hearRecording")).toBe(true);
    expect(perms.has("calls.transcripts")).toBe(true);
  });

  it("MARKETING получает calls.hearRecording вместе с calls.transcripts", () => {
    const perms = resolvePermissions("MARKETING");
    expect(perms.has("calls.hearRecording")).toBe(true);
    expect(perms.has("calls.transcripts")).toBe(true);
  });

  it("AGENT НЕ получает calls.hearRecording, хотя calls.ownTranscripts (чтение своих) остаётся", () => {
    const perms = resolvePermissions("AGENT");
    expect(perms.has("calls.hearRecording")).toBe(false);
    expect(perms.has("calls.ownTranscripts")).toBe(true);
  });

  it("MANAGER тоже НЕ получает calls.hearRecording — владелец назвал только три роли, MANAGER среди них нет", () => {
    const perms = resolvePermissions("MANAGER");
    expect(perms.has("calls.hearRecording")).toBe(false);
    expect(perms.has("calls.ownTranscripts")).toBe(true);
  });

  it("EDITOR не получает ни calls.ownTranscripts, ни calls.hearRecording — работа с видео объектов, не со звонками", () => {
    const perms = resolvePermissions("EDITOR");
    expect(perms.has("calls.hearRecording")).toBe(false);
    expect(perms.has("calls.ownTranscripts")).toBe(false);
  });

  it("directorOnly-права по-прежнему нельзя выдать calls.hearRecording в обход — оно НЕ directorOnly и раздаётся галочкой", () => {
    expect(DIRECTOR_ONLY_PERMISSIONS).not.toContain("calls.hearRecording");
    expect(ASSIGNABLE_PERMISSIONS).toContain("calls.hearRecording");
  });
});

/**
 * Сброс второго фактора (POST /agents/:id/2fa/reset) — ночная проверка 24.09.2026.
 * `agents.reset2fa` лежит в пресете ADMIN, а маршрут был единственной мутацией
 * учётки без forbiddenDirectorTarget: админ мог снять 2FA с директора. Заодно
 * сброс теперь гасит сессии цели, как смена пароля/отключение учётки.
 */
describe("Сброс 2FA — учётка директора защищена, сессии цели гаснут", () => {
  let targetId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const phone = `+992967${runId}`;
    await prisma.agent.deleteMany({ where: { phone } });
    targetId = (
      await prisma.agent.create({ data: { fullName: "Права Цель-2FA", phone, role: "AGENT", passwordHash } })
    ).id;
    // Сначала входим (появляется сессия), потом включаем 2FA прямо в базе —
    // иначе вход потребовал бы код и сессии бы не было.
    await login(phone);
    await prisma.agent.update({ where: { id: targetId }, data: { totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP" } });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: targetId } });
  });

  it("ADMIN не может сбросить 2FA директору — 403, как у остальных мутаций учётки", async () => {
    const res = await request(app)
      .post(`/api/v1/agents/${directorId}/2fa/reset`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it("директор сбрасывает 2FA сотруднику — фактор снят, живых сессий у цели не осталось", async () => {
    const before = await prisma.session.count({ where: { agentId: targetId, revokedAt: null } });
    expect(before).toBeGreaterThan(0);
    const res = await request(app)
      .post(`/api/v1/agents/${targetId}/2fa/reset`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totpEnabled).toBe(false);
    const after = await prisma.agent.findUnique({ where: { id: targetId }, select: { totpEnabled: true, totpSecret: true } });
    expect(after?.totpEnabled).toBe(false);
    expect(after?.totpSecret).toBeNull();
    expect(await prisma.session.count({ where: { agentId: targetId, revokedAt: null } })).toBe(0);
  });
});

describe("роли SHAREHOLDER и HEAD_OF_SALES — пресеты и константы (10.10.2026)", () => {
  const shareholder = new Set<string>(ROLE_PRESETS.SHAREHOLDER);
  const rop = new Set<string>(ROLE_PRESETS.HEAD_OF_SALES);

  it("пресет акционера — ровно спецификация, ничего лишнего", () => {
    expect([...ROLE_PRESETS.SHAREHOLDER].sort()).toEqual(
      [
        "dashboard.analytics", "finance.view", "reports.view", "insights.view", "clients.viewAll",
        "deals.viewAll", "otherInquiries.view", "messages.view", "team.viewFull", "vacancies.view",
        "archive.view", "siteChanges.view", "auditLog.view", "clients.viewOrigin",
      ].sort(),
    );
  });

  it("акционер: нет телефонов, контактов собственников, записей, вложений, настроек и ни одного *.manage", () => {
    for (const id of [
      "clients.viewPhone", "properties.viewOwners", "clients.assign", "deals.complete", "deals.setCommission",
      "messages.viewAttachments", "calls.hearRecording", "settings.view", "permissions.manage", "import.run",
    ]) {
      expect(shareholder.has(id), id).toBe(false);
    }
    expect(ROLE_PRESETS.SHAREHOLDER.filter((id) => /\.manage$/.test(id))).toEqual([]);
  });

  it("РОП: управляет продажами, но без денег компании, настроек и сотрудников", () => {
    for (const id of [
      "clients.viewAll", "clients.viewPhone", "clients.assign", "deals.complete", "deals.setCommission", "reports.view",
    ]) {
      expect(rop.has(id), id).toBe(true);
    }
    for (const id of [
      "finance.view", "finance.manage", "settings.view", "settings.manage", "agents.manage",
      "permissions.manage", "auditLog.view",
    ]) {
      expect(rop.has(id), id).toBe(false);
    }
  });

  it("РОП включает весь пресет агента", () => {
    for (const id of ROLE_PRESETS.AGENT) expect(rop.has(id), id).toBe(true);
  });

  it("подписи и описания пресетов заданы для обеих ролей", () => {
    expect(ROLE_LABELS.SHAREHOLDER).toBe("Акционер");
    expect(ROLE_LABELS.HEAD_OF_SALES).toBe("РОП");
    expect(ROLE_PRESET_SUMMARY.SHAREHOLDER).toBeTruthy();
    expect(ROLE_PRESET_SUMMARY.HEAD_OF_SALES).toBeTruthy();
  });

  it("константы ролей: лиды и рейтинг только у агента, вести клиентов может и РОП", () => {
    expect([...SALES_AGENT_ROLES]).toEqual(["AGENT", "HEAD_OF_SALES"]);
    expect([...LEAD_RECEIVING_ROLES]).toEqual(["AGENT"]);
    expect([...RATED_ROLES]).toEqual(["AGENT"]);
  });
});
