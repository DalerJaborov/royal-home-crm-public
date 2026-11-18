import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * СТОРОЖ «ЗВОНКИ WHATSAPP НЕ ДОХОДЯТ ДО СТАНЦИИ» (18.11.2026, lib/whatsappCallingHealth.ts).
 * Graph подменён функцией: ни сети, ни настоящего маркера.
 */

vi.mock("../src/messengers/meta.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/messengers/meta.js")>();
  return {
    ...real,
    isMetaChannelEnabled: vi.fn(async () => true),
    loadCredentials: vi.fn(async () => ({ ...(await real.loadCredentials()), waPhoneId: "wa-phone-calling-test", waToken: "test-wa-token" })),
  };
});
vi.mock("../src/messengers/accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/accounts.js")>()),
  resolveIncomingAccount: vi.fn(async () => ({ id: null, title: "Основной", token: "test-wa-token" })),
}));

const { prisma } = await import("../src/db.js");
const { runWhatsappCallingHealthCheck, WA_CALLING_SIP_ALARM_KEY, WA_CALLING_CHECK_ALARM_KEY } = await import(
  "../src/lib/whatsappCallingHealth.js"
);

type Reply = { status?: number; body: unknown } | Error;
function graph(settings: Reply, health?: Reply) {
  const calls: { url: string; token: string }[] = [];
  const get = vi.fn(async (url: string, token: string) => {
    calls.push({ url, token });
    const reply = url.includes("/settings") ? settings : health;
    if (!reply) throw new Error(`неожиданный запрос ${url}`);
    if (reply instanceof Error) throw reply;
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body };
  });
  return { get, calls };
}
const enabled = { body: { calling: { status: "ENABLED", sip: { status: "ENABLED", servers: [{ hostname: "sip.example.test" }] } } } };
const healthOf = (can: string, extra: Record<string, unknown> = {}) => ({
  body: {
    health_status: {
      can_send_message: "AVAILABLE",
      entities: [
        { entity_type: "PHONE_NUMBER", id: "1", can_receive_call_sip: can, ...extra },
        { entity_type: "APP", id: "2", can_receive_call_sip: "AVAILABLE" },
      ],
    },
  },
});
const keys = [WA_CALLING_SIP_ALARM_KEY, WA_CALLING_CHECK_ALARM_KEY];
const open = (dedupKey: string) => prisma.errorLog.findMany({ where: { source: "meta", dedupKey, resolvedAt: null } });

beforeEach(async () => {
  await prisma.errorLog.deleteMany({ where: { dedupKey: { in: keys } } });
});
afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { dedupKey: { in: keys } } });
  await prisma.$disconnect();
});

describe("сторож звонков WhatsApp через SIP", () => {
  it("звонки включены, номер заблокирован — тревога с кодом и описанием Meta; маркер только заголовком", async () => {
    const { get, calls } = graph(
      enabled,
      healthOf("BLOCKED", {
        errors: [{ error_code: 141010, error_description: "Calling is not enabled for this phone number", possible_solution: "Enable calling in settings" }],
      })
    );
    const res = await runWhatsappCallingHealthCheck(get);
    expect(res).toMatchObject({ alarmed: true, sipAvailability: "BLOCKED", checkFailed: false });
    const [row] = await open(WA_CALLING_SIP_ALARM_KEY);
    expect(row?.message).toContain("заблокированы");
    expect(row?.message).toContain("код 141010");
    expect(row?.message).toContain("Calling is not enabled");
    expect(row?.message).not.toContain("test-wa-token");
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringMatching(/\/wa-phone-calling-test\/settings$/),
      expect.stringMatching(/\/wa-phone-calling-test\?fields=health_status$/),
    ]);
    expect(calls.every((c) => !c.url.includes("test-wa-token") && c.token === "test-wa-token")).toBe(true);
    // Повтор через час — без второй строки.
    await runWhatsappCallingHealthCheck(get);
    expect(await open(WA_CALLING_SIP_ALARM_KEY)).toHaveLength(1);
  });

  it("снова AVAILABLE — тревога закрывается", async () => {
    await runWhatsappCallingHealthCheck(graph(enabled, healthOf("LIMITED", { additional_info: ["Низкое качество звонков"] })).get);
    const [limited] = await open(WA_CALLING_SIP_ALARM_KEY);
    expect(limited?.message).toContain("ограничены");
    expect(limited?.message).toContain("Низкое качество звонков");
    const res = await runWhatsappCallingHealthCheck(graph(enabled, healthOf("AVAILABLE")).get);
    expect(res).toMatchObject({ alarmed: false, sipAvailability: "AVAILABLE" });
    expect(await open(WA_CALLING_SIP_ALARM_KEY)).toHaveLength(0);
  });

  it("звонки или SIP выключены — запроса о состоянии нет и тревоги нет", async () => {
    for (const body of [{ calling: { status: "DISABLED" } }, { calling: { status: "ENABLED", sip: { status: "DISABLED" } } }, {}]) {
      const { get, calls } = graph({ body });
      expect((await runWhatsappCallingHealthCheck(get)).skipped).toBe("calling_off");
      expect(calls).toHaveLength(1);
    }
    expect(await open(WA_CALLING_SIP_ALARM_KEY)).toHaveLength(0);
  });

  it("сам запрос не прошёл — своя тревога, одна; удачный ответ её гасит", async () => {
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    expect((await runWhatsappCallingHealthCheck(graph(timeout).get)).checkFailed).toBe(true);
    await runWhatsappCallingHealthCheck(graph({ status: 400, body: { error: { code: 190, message: "Invalid OAuth access token" } } }).get);
    const rows = await open(WA_CALLING_CHECK_ALARM_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toContain("за 20 с");
    await runWhatsappCallingHealthCheck(graph({ body: { calling: { status: "DISABLED" } } }).get);
    expect(await open(WA_CALLING_CHECK_ALARM_KEY)).toHaveLength(0);
  });
});
