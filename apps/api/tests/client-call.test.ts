import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";
import { encryptSecret } from "../src/crypto.js";
import { resetCalls } from "../src/lib/telephony/callTracker.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { recordAgentCallAttempt } from "../src/lib/telephony/agentNoPickupGuard.js";

/**
 * Звонок из карточки клиента (ARI Originate) — этап 4 телефонии. Реального Asterisk
 * нет (владелец без доступа к серверу), поэтому здесь мокается fetch, как в
 * ari-connection.test.ts — проверяем логику маршрута, а не сам Asterisk.
 */

const runId = Date.now();
const password = "testpass123";

let agentWithExtId: string;
let agentNoExtId: string;
let otherAgentId: string;
let securityAgentId: string;
let directorAgentId: string;
let tokenWithExt: string;
let tokenNoExt: string;
let tokenOther: string;
let securityToken: string;
let directorToken: string;
let clientId: string;
let trashedClientId: string;
let unacceptedClientId: string;

const fetchMock = vi.fn();

async function call(token: string, id: string, phone?: string) {
  return request(app)
    .post(`/api/v1/clients/${id}/call`)
    .set("Authorization", `Bearer ${token}`)
    .send(phone ? { phone } : {});
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const withExt = await prisma.agent.create({
    data: { fullName: "Агент с SIP", phone: `+992927${runId}`, role: "AGENT", passwordHash, sipExtension: `1${String(runId).slice(-2)}` },
  });
  agentWithExtId = withExt.id;
  const noExt = await prisma.agent.create({
    data: { fullName: "Агент без SIP", phone: `+992926${runId}`, role: "AGENT", passwordHash },
  });
  agentNoExtId = noExt.id;
  const other = await prisma.agent.create({
    data: { fullName: "Чужой агент", phone: `+992925${runId}`, role: "AGENT", passwordHash },
  });
  otherAgentId = other.id;
  // Служба безопасности (clients.viewAll, без clients.assign) и директор
  // (viewAll + assign) — для аудита 24.09.2026, №121: «видеть все» не должно
  // давать право звонить чужому клиенту, а звонок в Корзину должен получать
  // 409 у обоих. Токен через signAccessToken, а не логин — роль читается из
  // базы на каждый запрос (см. auth/middleware.ts), пароль этим агентам не нужен.
  const security = await prisma.agent.create({
    data: { fullName: "СБ для звонка", phone: `+992922${runId}`, role: "SECURITY", passwordHash: "x" },
  });
  securityAgentId = security.id;
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });
  const director = await prisma.agent.create({
    data: { fullName: "Директор для звонка", phone: `+992921${runId}`, role: "DIRECTOR", passwordHash: "x" },
  });
  directorAgentId = director.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });

  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент для звонка ${runId}`,
        phone: `+992924${runId}`,
        // WhatsApp-номер и запасной — для проверки звонка на дополнительный номер
        // (владелец 20.08.2026): основной номер иногда недоступен, а эти — рабочие.
        // Ровно 9 цифр после 992 — иначе isDialableTajikNumber отказал бы им самим,
        // это не про то, что проверяет этот файл.
        whatsappPhone: `+992${String(runId).slice(-9)}`,
        extraPhones: [`+992${String(runId - 1).slice(-9)}`],
        source: "PHONE_CALL",
        assignedAgentId: agentWithExtId,
        acceptedAt: new Date(),
      },
    })
  ).id;

  trashedClientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент в Корзине для звонка ${runId}`,
        phone: `+992919${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentWithExtId,
        acceptedAt: new Date(),
        deletedAt: new Date(),
      },
    })
  ).id;

  unacceptedClientId = (
    await prisma.client.create({
      data: {
        fullName: `Непринятый клиент для живого звонка ${runId}`,
        phone: `+992918${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentWithExtId,
        acceptedAt: null,
      },
    })
  ).id;

  for (const [phone, setToken] of [
    [withExt.phone, (t: string) => (tokenWithExt = t)],
    [noExt.phone, (t: string) => (tokenNoExt = t)],
    [other.phone, (t: string) => (tokenOther = t)],
  ] as const) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    setToken(res.body.accessToken);
  }
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: [clientId, trashedClientId, unacceptedClientId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [securityAgentId, directorAgentId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentWithExtId, agentNoExtId, otherAgentId] } } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null },
  }).catch(() => {});
  await prisma.$disconnect();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  // Успешный звонок занимает линию агента (второй звонок, не закончив первый,
  // сервер не разрешает — см. hasLiveCall). Без сброса следующая проверка в файле
  // получала бы 409 вместо своего ответа.
  resetCalls();
});

describe("POST /clients/:id/call", () => {
  it("чужому клиенту звонить нельзя", async () => {
    const res = await call(tokenOther, clientId);
    expect(res.status).toBe(403);
  });

  // Аудит 24.09.2026, №121: право «видеть всех» (служба безопасности) проходило
  // canAccessAssignedAgent и звонило чужому клиенту от его имени — тот же приём,
  // что #801 закрыл для /message (foreignWriteDenied).
  it("СБ (право «видеть всех», без clients.assign) звонить чужому клиенту не может — 403", async () => {
    const res = await call(securityToken, clientId);
    expect(res.status).toBe(403);
  });

  // Клиент в Корзине — раньше маршрут не проверял deletedAt вовсе и звонил бы
  // дальше (директору доступ к карточке даёт clients.assign, foreignWriteDenied
  // его бы пропустил).
  it("клиент в Корзине — 409 даже директору", async () => {
    const res = await call(directorToken, trashedClientId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Корзин/);
  });

  it("без ARI-ключей в Настройках — понятная ошибка «телефония не настроена»", async () => {
    const res = await call(tokenWithExt, clientId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/телефония не настроена/i);
  });

  describe("с настроенными ARI-ключами", () => {
    beforeAll(async () => {
      await prisma.settings.upsert({
        where: { id: "singleton" },
        create: {
          id: "singleton",
          asteriskAriUrl: "http://ari.test:8088",
          asteriskAriUsername: "royalhome",
          asteriskAriPassword: encryptSecret("secret"),
        },
        update: {
          asteriskAriUrl: "http://ari.test:8088",
          asteriskAriUsername: "royalhome",
          asteriskAriPassword: encryptSecret("secret"),
        },
      });
    });

    it("у агента без SIP-номера — понятная ошибка, ARI не вызывается", async () => {
      vi.stubGlobal("fetch", fetchMock);
      const noExtClient = await prisma.client.create({
        data: {
          fullName: `Без SIP ${runId}`,
          phone: `+992923${runId}`,
          source: "PHONE_CALL",
          assignedAgentId: agentNoExtId,
          acceptedAt: new Date(),
        },
      });
      const res = await call(tokenNoExt, noExtClient.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/внутренний номер/i);
      expect(fetchMock).not.toHaveBeenCalled();
      // И директор видит это в журнале ошибок (28.09.2026, «Сурайё не смогла
      // дозвониться»): раньше отказ жил только в красной плашке у агента.
      const logged = await waitFor(() =>
        prisma.errorLog.findFirst({ where: { dedupKey: `no-sip-extension:${agentNoExtId}` } })
      );
      expect(logged?.source).toBe("telephony");
      await prisma.errorLog.deleteMany({ where: { dedupKey: `no-sip-extension:${agentNoExtId}` } });
      await prisma.client.deleteMany({ where: { id: noExtClient.id } });
    });

    it("успешный Originate возвращает channelId", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-1" }) } as Response);
      vi.stubGlobal("fetch", fetchMock);
      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(200);
      // dialing — номер, на который станция звонит самому агенту; проверяется
      // отдельно в client-call-flow.test.ts, здесь важен только факт успеха.
      expect(res.body).toMatchObject({ ok: true, channelId: "channel-1" });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("http://ari.test:8088/ari/channels?"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("звонок на WhatsApp-номер клиента (не основной) — тоже проходит", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-wa" }) } as Response);
      vi.stubGlobal("fetch", fetchMock);
      const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      const res = await call(tokenWithExt, clientId, client.whatsappPhone!);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, channelId: "channel-wa" });
    });

    it("звонок на запасной номер клиента — тоже проходит", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-extra" }) } as Response);
      vi.stubGlobal("fetch", fetchMock);
      const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      const res = await call(tokenWithExt, clientId, client.extraPhones[0]);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, channelId: "channel-extra" });
    });

    it("номер, не принадлежащий этой карточке — отказ ДО обращения к станции", async () => {
      vi.stubGlobal("fetch", fetchMock);
      const res = await call(tokenWithExt, clientId, "+992900111222");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/не принадлежит/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("международный номер клиента (не таджикский) — отказ, транк его не наберёт", async () => {
      await prisma.client.update({ where: { id: clientId }, data: { extraPhones: { push: "+79161234567" } } });
      vi.stubGlobal("fetch", fetchMock);
      const res = await call(tokenWithExt, clientId, "+79161234567");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/не таджикский/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("Asterisk отказал в звонке — ошибка Asterisk доходит до агента", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "Endpoint not found" } as Response);
      vi.stubGlobal("fetch", fetchMock);
      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/HTTP 500/);
    });

    /**
     * Владелец 29.09.2026: «таймер 15 минут должен отключаться — это вина станции,
     * а не агента». Отказ станции на нажатие «Позвонить» — попытка агента:
     * lastAgentAttemptAt, которая закрывает обязанность первого звонка
     * (services/leads/firstCall.ts, collectFirstCallFacts).
     */
    it("станция отказала (502) — попытка агента засчитана, таймер первого звонка гаснет", async () => {
      await prisma.client.update({ where: { id: clientId }, data: { lastAgentAttemptAt: null } });
      fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8088"));
      vi.stubGlobal("fetch", fetchMock);
      const res = await call(tokenWithExt, clientId);
      expect(res.status).toBe(502);
      const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { lastAgentAttemptAt: true } });
      expect(after.lastAgentAttemptAt).not.toBeNull();
    });

    it("чужая ошибка (нет SIP-номера, 409) — попыткой не считается", async () => {
      await prisma.client.update({ where: { id: clientId }, data: { lastAgentAttemptAt: null } });
      vi.stubGlobal("fetch", fetchMock);
      const res = await call(tokenNoExt, clientId);
      expect(res.status).not.toBe(502);
      const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { lastAgentAttemptAt: true } });
      expect(after.lastAgentAttemptAt).toBeNull();
    });

    /**
     * Троттлинг повторного набора после AGENT_NO_PICKUP (24.09.2026, найдено
     * ревью — см. lib/telephony/agentNoPickupGuard.ts). До этой правки кнопка
     * «Позвонить» тут же позволяла набрать ту же карточку заново, хотя станция
     * ещё не успела даже дозвониться агенту с прошлой попытки.
     */
    it("AGENT_NO_PICKUP только что был — повторный набор этой же карточки этим агентом отклонён 429", async () => {
      recordAgentCallAttempt(agentWithExtId, clientId, "AGENT_NO_PICKUP");
      vi.stubGlobal("fetch", fetchMock);

      const res = await call(tokenWithExt, clientId);

      expect(res.status).toBe(429);
      expect(res.body.error).toMatch(/Подождите \d+ с/);
      // Срок — в заголовке (28.09.2026): без него сайт брал остаток окна общего
      // лимитера («подождите 240 с») и прятал текст сервера за «Слишком много запросов».
      const retryAfter = Number(res.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(30);
      // Отказ — ДО обращения к станции, а не после.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("AGENT_NO_PICKUP был у ДРУГОГО агента — этому троттлинг не мешает", async () => {
      recordAgentCallAttempt(otherAgentId, clientId, "AGENT_NO_PICKUP");
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "channel-other-agent" }) } as Response);
      vi.stubGlobal("fetch", fetchMock);

      const res = await call(tokenWithExt, clientId);

      expect(res.status).toBe(200);
    });
  });
});

/**
 * Аудит 24.09.2026, №121 (продолжение): та же дыра стояла в «живом голосовом
 * звонке» (бот звонит клиенту от имени CRM) и в ручном наборе номера — оба
 * маршрута того же файла, что и /call выше. Здесь проверяется только доступ:
 * до обращения к телефонии дело не доходит, поэтому ARI-настройки для этих
 * тестов не нужны.
 */
describe("POST /clients/:id/live-voice-call", () => {
  async function liveVoiceCall(token: string, id: string) {
    return request(app)
      .post(`/api/v1/clients/${id}/live-voice-call`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
  }

  it("СБ (право «видеть всех», без clients.assign) звонить чужому клиенту не может — 403", async () => {
    const res = await liveVoiceCall(securityToken, clientId);
    expect(res.status).toBe(403);
  });

  it("клиент в Корзине — 409 даже директору", async () => {
    const res = await liveVoiceCall(directorToken, trashedClientId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Корзин/);
  });

  it("рядовой агент — 403: робот доступен только руководителю", async () => {
    const res = await liveVoiceCall(tokenWithExt, unacceptedClientId);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/руководител/i);
  });
});

describe("POST /clients/dial — тот же класс, что у /call", () => {
  it("СБ набирает номер чужого клиента — 403, а не тихий звонок от его имени", async () => {
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const res = await request(app)
      .post("/api/v1/clients/dial")
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ phone: client.phone });
    expect(res.status).toBe(403);
  });
});
