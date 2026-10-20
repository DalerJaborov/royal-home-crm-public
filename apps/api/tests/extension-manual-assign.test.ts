import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";

/**
 * Внутренний номер, вписанный руками (16.08.2026).
 *
 * Правило: автовыдача берёт номер из пула и ошибиться не может, а поле «Внутр. номер
 * (SIP)» принимало что угодно. Опечатка сохранялась молча — звонки сотруднику просто
 * не доходили, и причина была не видна нигде; чужой номер можно было забрать, сломав
 * связь сразу двоим.
 *
 * Отдельно закреплено то, чего мы НЕ блокируем: молчащая АТС не должна мешать
 * директору править карточку, и очистка номера остаётся законным действием.
 */

/**
 * Основание участка пула подбирается ПО БАЗЕ, а не наугад: четырёхзначное
 * случайное число вполне может быть уже закреплено за живым сотрудником — и
 * тогда «свободный» номер этого файла свободным не окажется. См.
 * helpers/extensionBase.ts.
 */
const runId = await reserveExtensionBase(5);
/** Номера станции этого прогона: свои у каждого запуска, чтобы тесты не мешали друг другу. */
const EXT_TAKEN = `${runId}`;
const EXT_FREE = `${runId + 1}`;
const EXT_UNKNOWN = `${runId + 2}`;
/** Заведён на станции и ни за кем не числится — им проверяются подсказки «свободны: …». */
const EXT_SPARE = `${runId + 4}`;
/** Резервный номер — автоматически не раздаётся, но вручную назначать можно:
 *  на живой станции 1001 закреплён за оператором входящих. */
const EXT_RESERVED = "1001";

const fetchMock = vi.fn();
let directorId = "";
let directorToken = "";
let holderId = "";
let holderName = "";
let targetId = "";
const extraAgentIds: string[] = [];
/** Кто держал 1001 в базе стенда до прогона — на время тестов номер освобождаем и в
 *  конце возвращаем: иначе проверка «резервный можно назначить вручную» упиралась бы
 *  в чужую запись из сида. */
const reservedHolderIds: string[] = [];

function endpointsResponse(resources: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => resources.map((r) => ({ technology: "SIP", resource: r, state: "unknown" })),
  } as Response;
}

/** Станция отвечает: на ней заведены занятый, свободный и резервный номера. */
function mockPbx(resources: string[] = [EXT_TAKEN, EXT_FREE, EXT_RESERVED, EXT_SPARE]) {
  fetchMock.mockResolvedValue(endpointsResponse(resources));
  vi.stubGlobal("fetch", fetchMock);
}

/** Станция не отвечает (выключена, нет сети). */
function mockPbxDown() {
  fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
  vi.stubGlobal("fetch", fetchMock);
}

/** Одиночный обрыв: первый запрос сорвался, второй прошёл. Ровно это и происходит
 *  со связью через туннель — см. listEndpointsRetrying в ariClient. */
function mockPbxFlaky(resources: string[] = [EXT_TAKEN, EXT_FREE, EXT_RESERVED, EXT_SPARE]) {
  fetchMock.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue(endpointsResponse(resources));
  vi.stubGlobal("fetch", fetchMock);
}

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: { fullName: `Директор ${runId}`, phone: `+99290${runId}01`, role: "DIRECTOR", passwordHash: "x" },
  });
  holderName = `Держатель номера ${runId}`;
  const holder = await prisma.agent.create({
    data: { fullName: holderName, phone: `+99290${runId}02`, role: "AGENT", passwordHash: "x", sipExtension: EXT_TAKEN },
  });
  const target = await prisma.agent.create({
    data: { fullName: `Правимый ${runId}`, phone: `+99290${runId}03`, role: "AGENT", passwordHash: "x", sipExtension: EXT_FREE },
  });
  directorId = director.id;
  holderId = holder.id;
  targetId = target.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });

  const reservedHolders = await prisma.agent.findMany({ where: { sipExtension: EXT_RESERVED }, select: { id: true } });
  reservedHolderIds.push(...reservedHolders.map((a) => a.id));
  if (reservedHolderIds.length) {
    await prisma.agent.updateMany({ where: { id: { in: reservedHolderIds } }, data: { sipExtension: null } });
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      asteriskAriUrl: "http://ari.manual-ext:8088",
      asteriskAriUsername: "royalhome-crm",
      asteriskAriPassword: encryptSecret("secret"),
    },
    update: {
      asteriskAriUrl: "http://ari.manual-ext:8088",
      asteriskAriUsername: "royalhome-crm",
      asteriskAriPassword: encryptSecret("secret"),
    },
  });
});

afterEach(async () => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  // Правимому возвращаем исходный номер: тесты идут подряд по одной записи.
  await prisma.agent.update({ where: { id: targetId }, data: { sipExtension: EXT_FREE } });
  if (extraAgentIds.length) {
    await prisma.agent.deleteMany({ where: { id: { in: extraAgentIds.splice(0) } } });
  }
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, holderId, targetId] } } });
  if (reservedHolderIds.length) {
    await prisma.agent.updateMany({ where: { id: { in: reservedHolderIds } }, data: { sipExtension: EXT_RESERVED } });
  }
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } })
    .catch(() => {});
  await prisma.$disconnect();
});

function patchTarget(body: Record<string, unknown>, id = targetId) {
  grantElevation(directorId);
  return request(app).patch(`/api/v1/agents/${id}`).set("Authorization", `Bearer ${directorToken}`).send(body);
}

describe("Внутренний номер вручную — правка карточки", () => {
  it("номера нет на АТС — отказ, и в тексте перечислены свободные", async () => {
    mockPbx();

    const res = await patchTarget({ sipExtension: EXT_UNKNOWN });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`На АТС нет внутреннего номера ${EXT_UNKNOWN}`);
    expect(res.body.error).toContain(`Свободны: ${EXT_SPARE}`);
    const after = await prisma.agent.findUnique({ where: { id: targetId }, select: { sipExtension: true } });
    expect(after?.sipExtension).toBe(EXT_FREE);
  });

  it("номер занят коллегой — отказ с его именем, чтобы было к кому идти", async () => {
    mockPbx();

    const res = await patchTarget({ sipExtension: EXT_TAKEN });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(holderName);
    const after = await prisma.agent.findUnique({ where: { id: targetId }, select: { sipExtension: true } });
    expect(after?.sipExtension).toBe(EXT_FREE);
  });

  it("сохранение карточки со СВОИМ же номером проходит: это не конфликт", async () => {
    mockPbx();

    const res = await patchTarget({ fullName: `Правимый ${runId}`, sipExtension: EXT_FREE });

    expect(res.status).toBe(200);
    expect(res.body.sipExtension).toBe(EXT_FREE);
  });

  it("номер можно очистить: null допустим и не проверяется", async () => {
    mockPbx();

    const res = await patchTarget({ sipExtension: null });

    expect(res.status).toBe(200);
    expect(res.body.sipExtension).toBeNull();
    const after = await prisma.agent.findUnique({ where: { id: targetId }, select: { sipExtension: true } });
    expect(after?.sipExtension).toBeNull();
  });

  it("АТС недоступна — сохраняем с предупреждением, а не блокируем правку", async () => {
    mockPbxDown();

    const res = await patchTarget({ sipExtension: EXT_UNKNOWN });

    expect(res.status).toBe(200);
    expect(res.body.sipExtension).toBe(EXT_UNKNOWN);
    expect(res.body.extensionNote).toContain("АТС недоступна");
    const after = await prisma.agent.findUnique({ where: { id: targetId }, select: { sipExtension: true } });
    expect(after?.sipExtension).toBe(EXT_UNKNOWN);
  });

  it("занятость коллегой ловится и при мёртвой АТС — эта проверка идёт по своей базе", async () => {
    mockPbxDown();

    const res = await patchTarget({ sipExtension: EXT_TAKEN });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(holderName);
  });

  it("связь со станцией сорвалась один раз — вторая попытка спасает, и предупреждения нет", async () => {
    // Жалоба владельца 20.09.2026: «ставлю настройки, обновляется и пропадает всё,
    // и вот такие ошибки». Один сорванный запрос печатал «АТС недоступна» поверх
    // только что сохранённого номера, хотя станция была жива.
    mockPbxFlaky();

    const res = await patchTarget({ sipExtension: EXT_SPARE });

    expect(res.status).toBe(200);
    expect(res.body.sipExtension).toBe(EXT_SPARE);
    expect(res.body.extensionNote).toBeUndefined();
  });

  it("признак «принимает незнакомые звонки» виден в списке сотрудников после сохранения", async () => {
    // Поле сохранялось, но в select списка не попадало — карточка после обновления
    // снова показывала «Нет», и настройка выглядела не применившейся.
    mockPbx();
    const saved = await patchTarget({ takesUnknownCalls: true });
    expect(saved.status).toBe(200);
    expect(saved.body.takesUnknownCalls).toBe(true);

    const list = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${directorToken}`);
    expect(list.status).toBe(200);
    const me = (list.body as { id: string; takesUnknownCalls?: boolean }[]).find((a) => a.id === targetId);
    expect(me?.takesUnknownCalls).toBe(true);

    await prisma.agent.update({ where: { id: targetId }, data: { takesUnknownCalls: false } });
  });

  it("АТС молчит — про трубки не судим: phoneOnline пуст, а не «не подключена»", async () => {
    // До 20.09.2026 здесь стояло молчаливое false, и один обрыв связи печатал
    // директору девять строк «трубка не подключена» про исправные телефоны.
    mockPbxDown();

    const list = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${directorToken}`);

    expect(list.status).toBe(200);
    const me = (list.body as { id: string; phoneOnline: boolean | null }[]).find((a) => a.id === targetId);
    expect(me?.phoneOnline).toBeNull();
  });

  it("резервный номер (1001) директор назначает вручную — на станции он у оператора", async () => {
    mockPbx();

    const res = await patchTarget({ sipExtension: EXT_RESERVED });

    expect(res.status).toBe(200);
    expect(res.body.sipExtension).toBe(EXT_RESERVED);
  });
});

describe("Внутренний номер вручную — заведение сотрудника", () => {
  it("несуществующий номер не заводит сотрудника вовсе", async () => {
    mockPbx();
    grantElevation(directorId);

    const res = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({
        fullName: `Новичок ${runId}`,
        phone: `+99290${runId}04`,
        role: "AGENT",
        password: "verysecret1",
        sipExtension: EXT_UNKNOWN,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("На АТС нет внутреннего номера");
    const created = await prisma.agent.findUnique({ where: { phone: `+99290${runId}04` } });
    expect(created).toBeNull();
  });

  it("свободный номер вписывается руками и автовыдача не вмешивается", async () => {
    // На станции есть ещё один свободный номер — берём именно тот, что указал директор.
    const extraFree = `${runId + 3}`;
    mockPbx([EXT_TAKEN, EXT_FREE, extraFree]);
    grantElevation(directorId);

    const res = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({
        fullName: `Новичок2 ${runId}`,
        phone: `+99290${runId}05`,
        role: "AGENT",
        password: "verysecret1",
        sipExtension: extraFree,
      });

    expect(res.status).toBe(201);
    expect(res.body.sipExtension).toBe(extraFree);
    extraAgentIds.push(res.body.id);
  });
});

describe("Подсказка свободных номеров", () => {
  it("отдаёт свободные без резервных и без занятых", async () => {
    // EXT_FREE закреплён за «правимым», поэтому свободным здесь выступает EXT_SPARE.
    mockPbx();

    const res = await request(app).get("/api/v1/agents/extensions/free").set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.free).toContain(EXT_SPARE);
    expect(res.body.free).not.toContain(EXT_FREE);
    expect(res.body.free).not.toContain(EXT_TAKEN);
    expect(res.body.free).not.toContain(EXT_RESERVED);
  });

  it("АТС молчит — экран не падает, причина названа", async () => {
    mockPbxDown();

    const res = await request(app).get("/api/v1/agents/extensions/free").set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.free).toEqual([]);
    expect(res.body.problem).toBe("АТС недоступна");
  });
});
