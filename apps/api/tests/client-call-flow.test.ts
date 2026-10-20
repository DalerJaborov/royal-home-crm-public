import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { reserveExtensionBase } from "./helpers/extensionBase.js";
import { encryptSecret } from "../src/crypto.js";
import { activeCallFor, getCall, resetCalls } from "../src/lib/telephony/callTracker.js";

/**
 * Этап 1 (телефония, план zippy-puzzling-locket.md) — сквозная проверка «нажал
 * Позвонить → CRM ушла в ARI Originate → взаимодействие зарегистрировано» БЕЗ
 * реального Asterisk: fetch мокается, как в ari-connection.test.ts/client-call.test.ts.
 *
 * client-call.test.ts уже проверяет права доступа и базовые коды ответа — здесь
 * фокус на том, что именно уходит в ARI (URL/метод/параметры Originate) и что роут
 * делает после успеха: берёт звонок под наблюдение (lib/telephony/callTracker.ts,
 * состояние показывается агенту на экране вызова) и заводит Interaction(type: CALL)
 * — след в хронологии клиента. Исход разговора дописывает туда же обработчик событий
 * АТС, когда звонок закончится (см. call-tracking.test.ts).
 */

const runId = Date.now();
// Внутренние номера — из свободного участка пула (helpers/extensionBase.ts), а не из
// двух последних цифр времени: те при параллельном прогоне сталкивались (№201).
const extBase = await reserveExtensionBase(2);
const ext1 = String(extBase);
const ext2 = String(extBase + 1);
const password = "testpass123";

let agentWithExtId: string;
/** Телефон агента — полноценный местный номер (+992 и девять цифр), иначе проверка
 *  набора теряет смысл: АТС агентства принимает именно девять цифр без кода страны,
 *  и срез кода должен быть виден в тесте. */
const agentMobile = `+992921${String(runId).slice(-6)}`;
const agentMobileDigits = `921${String(runId).slice(-6)}`;
let agentId2: string;
let clientId: string;
let tokenWithExt: string;
let token2: string;

const fetchMock = vi.fn();

async function call(token: string, id: string) {
  return request(app).post(`/api/v1/clients/${id}/call`).set("Authorization", `Bearer ${token}`).send({});
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const withExt = await prisma.agent.create({
    data: {
      fullName: "Агент со сквозным звонком",
      phone: agentMobile,
      role: "AGENT",
      passwordHash,
      sipExtension: ext1,
    },
  });
  agentWithExtId = withExt.id;
  const agent2 = await prisma.agent.create({
    data: {
      fullName: "Второй агент сквозного теста",
      phone: `+992929${runId}`,
      role: "AGENT",
      passwordHash,
      sipExtension: ext2,
    },
  });
  agentId2 = agent2.id;

  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент сквозного звонка ${runId}`,
        phone: `+992922${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentWithExtId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  for (const [phone, setToken] of [
    [withExt.phone, (t: string) => (tokenWithExt = t)],
    [agent2.phone, (t: string) => (token2 = t)],
  ] as const) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    setToken(res.body.accessToken);
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      asteriskAriUrl: "http://ari.flow-test:8088",
      asteriskAriUsername: "royalhome",
      asteriskAriPassword: encryptSecret("secret"),
    },
    update: {
      asteriskAriUrl: "http://ari.flow-test:8088",
      asteriskAriUsername: "royalhome",
      asteriskAriPassword: encryptSecret("secret"),
    },
  });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentWithExtId, agentId2] } } });
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } })
    .catch(() => {});
  await prisma.$disconnect();
});

afterEach(async () => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  resetCalls();
  await prisma.interaction.deleteMany({ where: { clientId } });
});

describe("сквозной путь: Позвонить → ARI Originate → регистрация звонка", () => {
  it("уходит корректный Originate: телефон агента, номер клиента, штатный контекст АТС", async () => {
    // Два ответа подряд: сначала CRM спрашивает у АТС список внутренних номеров
    // (оттуда берётся технология канала — на АТС агентства живёт chan_sip, а не
    // chan_pjsip), затем создаёт канал.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/ari/endpoints")
        ? ({
            ok: true,
            status: 200,
            json: async () => [{ technology: "SIP", resource: ext1, state: "online" }],
          } as Response)
        : ({ ok: true, status: 200, json: async () => ({ id: "flow-channel-1" }) } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(tokenWithExt, clientId);

    expect(res.status).toBe(200);
    // В ответе есть и номер, на который станция звонит самому агенту: без него
    // агент не понимал, куда пошёл вызов, и «звонок не идёт» выглядел загадкой
    // (07.08.2026 первый живой звонок ушёл на выдуманный номер из тестовых данных).
    expect(res.body).toMatchObject({
      ok: true,
      channelId: "flow-channel-1",
      dialing: { to: agentMobile, mode: "mobile" },
    });

    const originateCallArgs = fetchMock.mock.calls.find(([u]) => String(u).includes("/ari/channels"));
    expect(originateCallArgs, "запрос на создание канала не ушёл").toBeDefined();
    const [calledUrl, calledInit] = originateCallArgs as [string, RequestInit];
    expect(calledInit.method).toBe("POST");
    expect((calledInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("royalhome:secret").toString("base64")}`
    );
    const url = new URL(calledUrl);
    expect(url.origin + url.pathname).toBe("http://ari.flow-test:8088/ari/channels");
    const params = url.searchParams;
    // Софтфонов у агентства пока нет, поэтому режим по умолчанию — звонок агенту на
    // мобильный, Local-каналом через тот же штатный контекст (имя транка в CRM не
    // хранится: маршрут выбирает сама FreePBX).
    // Суффикс /n обязателен: без него Asterisk «оптимизирует» Local-канал и рвёт
    // уже установленный разговор через десяток секунд — ровно это наблюдалось на
    // первых живых звонках 07.08.2026.
    expect(params.get("endpoint")).toBe(`Local/${agentMobileDigits}@from-internal/n`);
    // Канал агента уходит в штатный контекст FreePBX с номером клиента как набранным —
    // так же, как если бы агент набрал его на своём телефоне. Свой контекст и
    // Stasis-приложение на АТС не заводятся: рукописный диалплан стирается при
    // «Apply Config» в панели.
    expect(params.get("context")).toBe("from-internal");
    expect(params.get("extension")).toBe(`992922${runId}`);
    expect(params.get("app")).toBeNull();
    // На трубке агента высвечивается имя клиента, а не собственный внутренний номер:
    // агент берёт трубку, уже зная, с кем сейчас будет говорить. Наружу это имя не
    // уходит — исходящий маршрут АТС подменяет определитель на номер агентства.
    expect(params.get("callerId")).toBe(`"Клиент сквозного звонка ${runId}" <${ext1}>`);

    // Канал регистрируется в короткоживущем кэше на будущее (см. ariEvents.ts),
    // пока реальный WebSocket ARI не подключён.
    expect(getCall("flow-channel-1")).toMatchObject({ clientId, agentId: agentWithExtId, state: "ringing_agent" });

    // И одновременно — след в хронологии клиента: без исхода, исход допишется
    // позже отдельной записью через обязательное окно «Итог разговора».
    const interactions = await prisma.interaction.findMany({ where: { clientId, type: "CALL" } });
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ agentId: agentWithExtId, notes: "Звонок инициирован из CRM", outcome: null });
  });

  it("когда софтфоны розданы, режим extension звонит на внутренний номер, а не на мобильный", async () => {
    // Тот же путь, другой режим в Настройках: плечо до агента становится бесплатным,
    // всё остальное (контекст, номер клиента, определитель) не меняется — иначе
    // переключение режима тихо ломало бы сам звонок.
    await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "extension" } });
    try {
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("/ari/endpoints")
          ? ({
              ok: true,
              status: 200,
              json: async () => [{ technology: "SIP", resource: ext1, state: "online" }],
            } as Response)
          : ({ ok: true, status: 200, json: async () => ({ id: "flow-channel-ext" }) } as Response)
      );
      vi.stubGlobal("fetch", fetchMock);

      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(200);

      const originate = fetchMock.mock.calls.find(([u]) => String(u).includes("/ari/channels"));
      const params = new URL((originate as [string, RequestInit])[0]).searchParams;
      // Local через диалплан, а не SIP/… напрямую: у сотрудника может быть два
      // устройства (софтфон и трубка в браузере CRM), их список знает станция.
      expect(params.get("endpoint")).toBe(`Local/${ext1}@from-internal/n`);
      expect(params.get("context")).toBe("from-internal");
      expect(params.get("extension")).toBe(`992922${runId}`);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "mobile" } });
    }
  });

  /**
   * РЕЖИМ «АВТО» (владелец 11.08.2026: «опять работает с переадресацией на исходящие
   * вызовы?»). В режиме mobile оба плеча уходят наружу через транк: в журнале станции
   * один разговор выглядит как два платных вызова, а сотруднику звонит номер
   * собственного агентства — то есть как переадресация. «Авто» спрашивает станцию,
   * на связи ли аппарат, и выбирает бесплатное внутреннее плечо, когда это возможно.
   */
  it("режим auto: аппарат на связи — звоним на внутренний, плечо до сотрудника бесплатное", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "auto" } });
    try {
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("/ari/endpoints")
          ? ({
              ok: true,
              status: 200,
              json: async () => [{ technology: "SIP", resource: ext1, state: "online" }],
            } as Response)
          : ({ ok: true, status: 200, json: async () => ({ id: "flow-channel-auto-on" }) } as Response)
      );
      vi.stubGlobal("fetch", fetchMock);

      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(200);
      expect(res.body.dialing).toMatchObject({ mode: "extension" });

      const originate = fetchMock.mock.calls.find(([u]) => String(u).includes("/ari/channels"));
      const params = new URL((originate as [string, RequestInit])[0]).searchParams;
      expect(params.get("endpoint")).toBe(`Local/${ext1}@from-internal/n`);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "mobile" } });
    }
  });

  /**
   * Софтфон выключен, но открыта CRM — сотрудник ДОСТУПЕН: его браузерная трубка
   * (`rh-web-<номер>`) зарегистрирована на станции. Пока «авто» проверял только
   * софтфон, звонок уходил на мобильный: платное плечо и ожидание там, где браузер
   * зазвонил бы мгновенно.
   */
  it("режим auto: софтфон выключен, но браузерная трубка на связи — звоним на внутренний", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "auto" } });
    try {
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("/ari/endpoints")
          ? ({
              ok: true,
              status: 200,
              json: async () => [
                { technology: "SIP", resource: ext1, state: "unknown" },
                { technology: "PJSIP", resource: `rh-web-${ext1}`, state: "online" },
              ],
            } as Response)
          : ({ ok: true, status: 200, json: async () => ({ id: "flow-channel-auto-web" }) } as Response)
      );
      vi.stubGlobal("fetch", fetchMock);

      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(200);
      expect(res.body.dialing).toMatchObject({ mode: "extension" });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "mobile" } });
    }
  });

  it("режим auto: аппарата нет на связи — падаем на мобильный, а не оставляем без звонка", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "auto" } });
    try {
      fetchMock.mockImplementation(async (url: string) =>
        String(url).includes("/ari/endpoints")
          ? ({
              ok: true,
              status: 200,
              // unknown у chan_sip = «заведён, но ни разу не регистрировался», то есть
              // трубки нет. Звонить туда — гарантированный недозвон.
              json: async () => [{ technology: "SIP", resource: ext1, state: "unknown" }],
            } as Response)
          : ({ ok: true, status: 200, json: async () => ({ id: "flow-channel-auto-off" }) } as Response)
      );
      vi.stubGlobal("fetch", fetchMock);

      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(200);
      expect(res.body.dialing).toMatchObject({ to: agentMobile, mode: "mobile" });

      const originate = fetchMock.mock.calls.find(([u]) => String(u).includes("/ari/channels"));
      const params = new URL((originate as [string, RequestInit])[0]).searchParams;
      expect(params.get("endpoint")).toBe(`Local/${agentMobileDigits}@from-internal/n`);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "mobile" } });
    }
  });

  it("агент без sipExtension получает понятную ошибку, а не 500, и ARI не трогается", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const clientForAgent2 = await prisma.client.create({
      data: {
        fullName: `Клиент без SIP-агента ${runId}`,
        phone: `+992928${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId2,
        acceptedAt: new Date(),
      },
    });
    await prisma.agent.update({ where: { id: agentId2 }, data: { sipExtension: null } });

    const res = await call(token2, clientForAgent2.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/внутренний номер/i);
    expect(fetchMock).not.toHaveBeenCalled();

    await prisma.client.deleteMany({ where: { id: clientForAgent2.id } });
  });

  it("телефония не настроена (нет ARI-ключей) — понятный ответ 409, ARI не трогается", async () => {
    vi.stubGlobal("fetch", fetchMock);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null },
    });
    try {
      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/телефония не настроена/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: {
          asteriskAriUrl: "http://ari.flow-test:8088",
          asteriskAriUsername: "royalhome",
          asteriskAriPassword: encryptSecret("secret"),
        },
      });
    }
  });

  it("ARI ответил 401 (неверные креды на сервере) — ошибка доходит до агента понятным текстом", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "" } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(tokenWithExt, clientId);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/неверный логин или пароль/i);
    expect(activeCallFor(agentWithExtId), "неудачный звонок не должен занимать линию агента").toBeUndefined();
  });

  it("ARI ответил 500 — тело ответа Asterisk доходит до агента, а не голый 500", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "Endpoint PJSIP/999 not found" } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(tokenWithExt, clientId);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/HTTP 500/);
    expect(res.body.error).toMatch(/Endpoint PJSIP\/999 not found/);
    expect(activeCallFor(agentWithExtId), "неудачный звонок не должен занимать линию агента").toBeUndefined();
  });

  it("сеть недоступна (ECONNREFUSED) — ошибка соединения доходит до агента", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 217.11.178.238:8088"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(tokenWithExt, clientId);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/не удалось соединиться/i);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });
});
