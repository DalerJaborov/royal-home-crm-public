import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НЕЗНАКОМЫЙ ЗВОНОК — ДЕЖУРНОМУ ПО ОЧЕРЕДИ (владелец 20.08.2026, режим
 * Settings.incomingRoutingMode === "dedicated_operator"). Подробности решения —
 * в заголовке lib/telephony/dutyRosterRouting.ts.
 */

let dialplanPresent = true;
let redirectOk = true;
const amiSent: { action: string; fields: Record<string, string | number> }[] = [];

function getConfigPacket(withRouteContext: boolean): Record<string, string> {
  const packet: Record<string, string> = {
    response: "Success",
    "category-000000": "from-internal-custom",
    "line-000000-000000": "exten => 1000,1,Queue(1000,t)",
  };
  if (withRouteContext) {
    packet["category-000001"] = "royalhome-agent-route";
    packet["line-000001-000000"] = "exten => agent,1,NoOp(RoyalHome)";
    packet["line-000001-000001"] = "same => n,Queue(1000,t)";
  }
  return packet;
}

/**
 * redirectChannelToAgent шлёт Setvar/Redirect через withAmiConnection (одна
 * AMI-сессия на всю цепочку, 06.09.2026), а проверка диалплана — по-прежнему
 * напрямую через amiAction: у них разные сигнатуры (amiAction принимает creds
 * первым аргументом, send() из withAmiConnection — нет), поэтому за ответом
 * станции стоит общая функция `respond`, а не одна и та же на оба места.
 */
function respond(action: string, fields: Record<string, string | number> = {}): unknown {
  amiSent.push({ action, fields });
  if (action === "GetConfig") return { ok: true, packets: [getConfigPacket(dialplanPresent)] };
  if (action === "Redirect" && !redirectOk) return { ok: false, error: "No such channel" };
  return { ok: true, packets: [{ response: "Success" }] };
}

vi.mock("../src/lib/telephony/amiClient.js", () => ({
  loadAmiCredentials: async () => ({ host: "127.0.0.1", port: 5038, username: "crm", password: "x" }),
  amiAction: async (_creds: unknown, action: string, fields?: Record<string, string | number>) => respond(action, fields),
  // Проверка диалплана ходит на станцию через amiActionRetrying (20.09.2026,
  // dialplanContext.ts): повторять здесь нечего — станция отвечает
  // детерминированно, — но экспорт обязан существовать, иначе dialplanContext.ts
  // зовёт undefined и перевод срывается там, где на живой станции он проходит.
  amiActionRetrying: async (_creds: unknown, action: string, fields?: Record<string, string | number>) =>
    respond(action, fields),
  withAmiConnection: async (
    _creds: unknown,
    run: (send: (action: string, fields?: Record<string, string | number>) => Promise<unknown>) => Promise<unknown>
  ) => run((action, fields) => Promise.resolve(respond(action, fields))),
}));

vi.mock("../src/lib/telephony/ariClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/telephony/ariClient.js")>(
    "../src/lib/telephony/ariClient.js"
  );
  return { ...actual, loadAriCredentials: async () => ({ url: "http://pbx.test", username: "crm", password: "x" }) };
});

const { prisma } = await import("../src/db.js");
const { resetDialplanCache, ROUTE_CONTEXT, ROUTE_EXTEN } = await import("../src/lib/telephony/inboundRouting.js");
const { routeUnknownCallByDutyRoster } = await import("../src/lib/telephony/dutyRosterRouting.js");

const runId = Date.now();
const ext = "1940";
let agentId = "";
const agentMobile = `+9929${String(runId).slice(-8)}`;
const clientPhone = `+9927${String(runId + 1).slice(-8)}`;
let recordId = "";

let endpoints: { technology: string; resource: string; state: string }[] = [];

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).endsWith("/ari/endpoints")) {
      return { ok: true, status: 200, json: async () => endpoints } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });

  const agent = await prisma.agent.create({
    data: {
      fullName: `Дежурный ${runId}`,
      phone: agentMobile,
      role: "AGENT",
      passwordHash: "x",
      sipExtension: ext,
    },
  });
  agentId = agent.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.incomingCall.deleteMany({ where: { phone: clientPhone } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { incomingRoutingMode: "assigned_then_forward", incomingDutyAgentIds: [] },
  });
});

beforeEach(async () => {
  amiSent.length = 0;
  dialplanPresent = true;
  redirectOk = true;
  resetDialplanCache();
  endpoints = [{ technology: "SIP", resource: ext, state: "online" }];
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      incomingRoutingMode: "dedicated_operator",
      incomingDutyAgentIds: [agentId],
      incomingRouteRingSeconds: 25,
      asteriskAgentDialMode: "auto",
    },
  });
  const call = await prisma.incomingCall.create({
    data: { channelId: `duty-${runId}-${Math.random()}`, phone: clientPhone, startedAt: new Date() },
  });
  recordId = call.id;
});

afterEach(async () => {
  await prisma.incomingCall.deleteMany({ where: { phone: clientPhone } });
});

function req(over: Partial<{ isAnswered: () => boolean }> = {}) {
  return {
    channelName: `SIP/out-${runId}`,
    phone: clientPhone,
    recordId,
    isAnswered: () => false,
    ...over,
  };
}

describe("незнакомый звонок дежурному по очереди", () => {
  it("режим выключен — не переводит и не трогает станцию", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRoutingMode: "assigned_then_forward" } });
    const outcome = await routeUnknownCallByDutyRoster(req());
    expect(outcome).toEqual({ routed: false, reason: "disabled" });
    expect(amiSent).toEqual([]);
  });

  it("CHANNEL-NEW-33: режим выключен — решение, уже записанное другим режимом, в журнале не затирается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRoutingMode: "assigned_then_forward" } });
    await prisma.incomingCall.update({ where: { id: recordId }, data: { routeDecision: "kpi_routed_mobile", routedToId: null } });
    await routeUnknownCallByDutyRoster(req());
    expect((await prisma.incomingCall.findUnique({ where: { id: recordId } }))?.routeDecision).toBe("kpi_routed_mobile");
  });

  it("список дежурных пуст — no_roster, станцию не трогаем", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingDutyAgentIds: [] } });
    const outcome = await routeUnknownCallByDutyRoster(req());
    expect(outcome).toEqual({ routed: false, reason: "no_roster" });
    expect(amiSent).toEqual([]);
  });

  it("дежурного уволили, из списка не убрали — agent_not_found, звонок не гуляет по списку", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingDutyAgentIds: ["ghost-agent-id"] } });
    const outcome = await routeUnknownCallByDutyRoster(req());
    expect(outcome).toEqual({ routed: false, reason: "agent_not_found" });
  });

  it("уже ответили — не переводит", async () => {
    const outcome = await routeUnknownCallByDutyRoster(req({ isAnswered: () => true }));
    expect(outcome).toEqual({ routed: false, reason: "already_answered" });
    expect(amiSent).toEqual([]);
  });

  it("нет диалплана на станции — не переводит", async () => {
    dialplanPresent = false;
    const outcome = await routeUnknownCallByDutyRoster(req());
    expect(outcome).toEqual({ routed: false, reason: "no_dialplan" });
  });

  it("счастливый путь — уводит на трубку дежурного и пишет решение в журнал", async () => {
    const outcome = await routeUnknownCallByDutyRoster(req());
    expect(outcome).toMatchObject({ routed: true, agentId, extension: ext, viaMobile: false });

    const redirect = amiSent.find((a) => a.action === "Redirect");
    expect(redirect?.fields).toMatchObject({ Context: ROUTE_CONTEXT, Exten: ROUTE_EXTEN, Priority: 1 });

    const record = await prisma.incomingCall.findUnique({ where: { id: recordId } });
    expect(record?.routeDecision).toBe("duty_routed");
    expect(record?.routedToId).toBe(agentId);
  });

  it("трубки нет на связи — уходит на мобильный, помечено в журнале отдельно", async () => {
    endpoints = [];
    const outcome = await routeUnknownCallByDutyRoster(req());
    expect(outcome).toMatchObject({ routed: true, viaMobile: true });
    const record = await prisma.incomingCall.findUnique({ where: { id: recordId } });
    expect(record?.routeDecision).toBe("duty_routed_mobile");
  });

  it("станция отказала в переводе — redirect_failed", async () => {
    redirectOk = false;
    const outcome = await routeUnknownCallByDutyRoster(req());
    expect(outcome).toEqual({ routed: false, reason: "redirect_failed" });
    const record = await prisma.incomingCall.findUnique({ where: { id: recordId } });
    expect(record?.routeDecision).toBe("duty_redirect_failed");
  });
});
