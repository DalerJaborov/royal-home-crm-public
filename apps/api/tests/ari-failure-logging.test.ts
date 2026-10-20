import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { resolveChannelTech } from "../src/lib/telephony/ariClient.js";
import { resolveDialTarget } from "../src/lib/telephony/inboundRouting.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * 22.09.2026, разбор «отказ не доходит до журнала»: `resolveChannelTech` (п.2) и
 * `resolveDialTarget` (п.4) откатывались на безопасное поведение молча — `catch {}`
 * без единой строки в журнале. Здесь стерегут ровно два свойства разом:
 *  1) откат (технология "SIP"/`null`-цель) остаётся прежним — звонок не срывается;
 *  2) отказ станции теперь виден в ErrorLog понятной причиной.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => fetchMock.mockReset());
afterAll(() => vi.unstubAllGlobals());

const creds = { url: "http://ari-failure-logging-test:8088", username: "royalhome", password: "secret" };

describe("resolveChannelTech — отказ станции", () => {
  it("откатывается на SIP и пишет в журнал, а не молчит", async () => {
    // Маркер — свой на каждый прогон: десятиминутная дедупликация logSystemError
    // (см. lib/systemError.ts) иначе схлопывает повторный локальный прогон этого
    // теста с записью от прошлого прогона той же секции — тест должен стеречь
    // «пишет в журнал», а не гоняться с собственным дедупом.
    const marker = randomUUID();
    fetchMock.mockRejectedValue(new Error(`АТС не ответила: timeout (${marker})`));

    const tech = await resolveChannelTech(creds, "1099");
    // Поведение прежнее: без кэша откат на "SIP", звонок не срывается.
    expect(tech).toBe("SIP");

    const row = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { source: "telephony", message: { contains: marker } },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись об отказе resolveChannelTech в журнале" }
    );
    expect(row?.message).toContain("технология канала не определена");
    expect(row?.message).toContain("SIP");
  });
});

describe("resolveDialTarget — станция не ответила на справочный запрос", () => {
  beforeAll(async () => {
    // Режим "extension": resolveAgentDialTarget сразу отдаёт agentMobile=null без
    // сети, и resolveDialTarget идёт за списком аппаратов сама — именно тот путь,
    // где раньше стоял голый catch {}.
    await prisma.settings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", asteriskAgentDialMode: "extension" },
      update: { asteriskAgentDialMode: "extension" },
    });
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "mobile" } }).catch(() => {});
  });

  it("возвращает null (звонок остаётся в очереди) и пишет причину в журнал", async () => {
    const marker = randomUUID();
    fetchMock.mockRejectedValue(new Error(`ECONNRESET (${marker})`));

    const target = await resolveDialTarget(creds, "1099", null);
    // Поведение прежнее: догадка стоит клиенту тишины — оставляем звонок очереди.
    expect(target).toBeNull();

    const row = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { source: "telephony", message: { contains: marker } },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись об отказе resolveDialTarget в журнале" }
    );
    expect(row?.message).toContain("Куда звонить агенту на входящем");
    expect(row?.message).toContain("очеред");
  });
});
