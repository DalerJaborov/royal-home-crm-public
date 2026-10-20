import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";

/**
 * Звонок коллеге через офисную АТС (07.08.2026).
 *
 * Проверяется главное: вызов уходит на внутренний номер коллеги штатным контекстом
 * FreePBX, а когда номера нет у одной из сторон — сотрудник получает объяснение, а не
 * 500 и не молчание.
 */

/**
 * Основание участка пула подбирается ПО БАЗЕ, а не наугад: четырёхзначное
 * случайное число вполне может быть уже закреплено за живым сотрудником, и
 * создание агента упирается в уникальность sipExtension на исправном коде.
 * См. helpers/extensionBase.ts.
 */
const runId = await reserveExtensionBase(3);
const fetchMock = vi.fn();
let callerId = "";
let calleeId = "";
let calleeNoExtId = "";
let callerToken = "";

const CALLER_EXT = `${runId}`;
const CALLEE_EXT = `${runId + 1}`;
/** Мобильный звонящего: полный местный номер и те же девять цифр, которыми его
 *  наберёт транк агентства (код страны 992 срезается). */
const CALLER_MOBILE = `+992915${String(runId).slice(-6).padStart(6, "0")}`;
const CALLER_MOBILE_DIGITS = `915${String(runId).slice(-6).padStart(6, "0")}`;
/** Мобильный коллеги — им станция набирает его, когда трубки нет на связи.
 *  Формат тот же, что у звонящего: настоящий местный девятизначный номер, у
 *  которого транк срезает код страны. */
const CALLEE_MOBILE = `+992916${String(runId).slice(-6).padStart(6, "0")}`;
const CALLEE_MOBILE_DIGITS = `916${String(runId).slice(-6).padStart(6, "0")}`;

beforeAll(async () => {
  const caller = await prisma.agent.create({
    data: { fullName: `Звонящий ${runId}`, phone: CALLER_MOBILE, role: "AGENT", passwordHash: "x", sipExtension: CALLER_EXT },
  });
  const callee = await prisma.agent.create({
    data: { fullName: `Коллега ${runId}`, phone: CALLEE_MOBILE, role: "AGENT", passwordHash: "x", sipExtension: CALLEE_EXT },
  });
  const calleeNoExt = await prisma.agent.create({
    data: { fullName: `Без номера ${runId}`, phone: `+99291${runId}3`, role: "AGENT", passwordHash: "x" },
  });
  callerId = caller.id;
  calleeId = callee.id;
  calleeNoExtId = calleeNoExt.id;
  callerToken = signAccessToken({ sub: caller.id, role: "AGENT" });

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      asteriskAriUrl: "http://ari.agent-call:8088",
      asteriskAriUsername: "royalhome-crm",
      asteriskAriPassword: encryptSecret("secret"),
    },
    update: {
      asteriskAriUrl: "http://ari.agent-call:8088",
      asteriskAriUsername: "royalhome-crm",
      asteriskAriPassword: encryptSecret("secret"),
    },
  });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [callerId, calleeId, calleeNoExtId] } } });
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } })
    .catch(() => {});
  await prisma.$disconnect();
});

function mockAri() {
  fetchMock.mockImplementation(async (url: string) =>
    String(url).includes("/ari/endpoints")
      ? ({
          ok: true,
          status: 200,
          json: async () => [
            { technology: "SIP", resource: CALLER_EXT, state: "online" },
            { technology: "SIP", resource: CALLEE_EXT, state: "online" },
          ],
        } as Response)
      : ({ ok: true, status: 200, json: async () => ({ id: "colleague-channel" }) } as Response)
  );
  vi.stubGlobal("fetch", fetchMock);
}

describe("Звонок коллеге", () => {
  it("звонит на внутренний номер коллеги через штатный контекст АТС", async () => {
    mockAri();

    const res = await request(app).post(`/api/v1/agents/${calleeId}/call`).set("Authorization", `Bearer ${callerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, extension: CALLEE_EXT });

    const originate = fetchMock.mock.calls.find(([u]) => String(u).includes("/ari/channels"));
    expect(originate, "запрос на создание канала не ушёл").toBeDefined();
    const params = new URL((originate as [string, RequestInit])[0]).searchParams;
    // Сначала звонит телефон звонящего. Софтфонов у агентства пока нет, поэтому по
    // умолчанию станция звонит ему на мобильный из карточки — иначе кнопка была бы
    // мёртвой у всех, у кого трубка не настроена.
    expect(params.get("endpoint")).toBe(`Local/${CALLER_MOBILE_DIGITS}@from-internal/n`);
    // …а после ответа станция набирает коллегу так же, как если бы номер набрали руками.
    expect(params.get("context")).toBe("from-internal");
    expect(params.get("extension")).toBe(CALLEE_EXT);
    // На трубке звонящего видно, кому он звонит, — иначе он поднимает её, не понимая,
    // с кем сейчас соединят.
    expect(params.get("callerId")).toBe(`"Коллега ${runId}" <${CALLER_EXT}>`);
  });

  /**
   * Владелец 16.08.2026: «если они недоступны, без инета в CRM, то звонок идёт на их
   * мобильный — чтобы все всегда были в сети».
   *
   * До этой правки коллеге набирался ТОЛЬКО внутренний номер: закрыт браузер, нет
   * интернета, выключен софтфон — и звонок уходил в мёртвую трубку, а звонящий
   * слушал гудки. Мобильный подставлялся лишь звонящему и лишь в жёстком режиме
   * "mobile".
   */
  it("коллега не в сети — звонок уходит на его мобильный, а не в мёртвую трубку", async () => {
    // Трубка звонящего на связи, трубки коллеги в списке станции нет вовсе.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/ari/endpoints")
        ? ({
            ok: true,
            status: 200,
            json: async () => [{ technology: "SIP", resource: CALLER_EXT, state: "online" }],
          } as Response)
        : ({ ok: true, status: 200, json: async () => ({ id: "colleague-channel" }) } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).post(`/api/v1/agents/${calleeId}/call`).set("Authorization", `Bearer ${callerToken}`);

    expect(res.status).toBe(200);
    const originate = fetchMock.mock.calls.find(([u]) => String(u).includes("/ari/channels"));
    const params = new URL((originate as [string, RequestInit])[0]).searchParams;
    // Станция набирает мобильный коллеги (те же девять цифр, что уходят в транк),
    // а НЕ его внутренний номер, который сейчас никто не слышит.
    expect(params.get("extension")).toBe(CALLEE_MOBILE_DIGITS);
    expect(params.get("extension")).not.toBe(CALLEE_EXT);
  });

  /**
   * Обратная сторона того же правила: пока коллега в сети, звоним ему на ВНУТРЕННИЙ.
   * Внутреннее плечо бесплатное, мобильное идёт через транк за деньги — мобильный
   * обязан оставаться запасным путём, а не превращаться в основной.
   */
  it("коллега в сети — звоним на внутренний, не тратя деньги на мобильный", async () => {
    mockAri(); // в этом моке трубки обоих на связи

    const res = await request(app).post(`/api/v1/agents/${calleeId}/call`).set("Authorization", `Bearer ${callerToken}`);

    expect(res.status).toBe(200);
    const originate = fetchMock.mock.calls.find(([u]) => String(u).includes("/ari/channels"));
    const params = new URL((originate as [string, RequestInit])[0]).searchParams;
    expect(params.get("extension")).toBe(CALLEE_EXT);
  });

  it("у коллеги нет внутреннего номера — понятный отказ с именем, а не 500", async () => {
    mockAri();

    const res = await request(app).post(`/api/v1/agents/${calleeNoExtId}/call`).set("Authorization", `Bearer ${callerToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("нет внутреннего номера");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/ari/channels"))).toBe(false);
  });

  /**
   * Уволенному звонить нельзя. В базе живут учётки с выдуманными телефонами из
   * тестовых данных, и оператор связи отвечает на них автоинформатором — для CRM
   * это состоявшийся разговор с записью и платной расшифровкой.
   */
  it("сотрудник больше не работает — отказ, и станцию не беспокоим", async () => {
    mockAri();
    const fired = await prisma.agent.create({
      data: {
        fullName: `Уволенный ${runId}`,
        phone: `+99291${runId}4`,
        role: "AGENT",
        passwordHash: "x",
        sipExtension: `${runId + 2}`,
        isActive: false,
      },
    });

    const res = await request(app).post(`/api/v1/agents/${fired.id}/call`).set("Authorization", `Bearer ${callerToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("больше не работает");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/ari/channels"))).toBe(false);

    await prisma.agent.delete({ where: { id: fired.id } });
  });

  it("несуществующий сотрудник — 404, и до АТС дело не доходит", async () => {
    mockAri();

    const res = await request(app)
      .post("/api/v1/agents/00000000-0000-0000-0000-000000000000/call")
      .set("Authorization", `Bearer ${callerToken}`);

    expect(res.status).toBe(404);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/ari/channels"))).toBe(false);
  });
});
