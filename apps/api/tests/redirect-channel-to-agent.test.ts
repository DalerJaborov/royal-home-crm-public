import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ЮНИТ-ТЕСТ НА redirectChannelToAgent НАПРЯМУЮ, В ОБХОД ВСЕХ ТРЁХ ВЫЗЫВАЮЩИХ
 * (attemptRoute/routeUnknownCallByKpiQueue/routeUnknownCallByDutyRoster).
 *
 * ЖИВОЙ БАГ 03.09.2026 (коммит 475d5a9a). Перед циклом Setvar стояла проверка
 * `if (!input.isAnswered()) return { ok:false, reason:"channel_gone_before_setvar" }` —
 * задумана была как «канал умер, пока мы готовились» (клиент положил трубку), а
 * реально ловила КАЖДЫЙ живой непринятый звонок: isAnswered() — это
 * `bridgedAt || endedAt`, и у звонка, который ещё звонит, оба поля пустые, то
 * есть isAnswered()===false ровно в тот момент, когда перевод и нужен. Проверка
 * инвертирована: «ещё не ответили» перепутано с «канал исчез». Все три пути
 * перевода (агенту, по очереди KPI, дежурному) молча отказывали в переводе
 * каждому обычному звонку — поймано только полным прогоном тестов, 14 упавших
 * сценариев в inbound-routing/kpi-queue-routing/duty-roster-routing.test.ts.
 *
 * Исправление: проверка перед Setvar убрана целиком (она была только
 * оптимизацией — не гонять Setvar на явно мёртвый канал, — а не единственной
 * защитой). Настоящая защита остаётся: isAnswered() проверяется ЕЩЁ РАЗ прямо
 * перед Redirect, и именно её стерегут тесты ниже.
 */

const amiSent: { action: string; fields: Record<string, string | number> }[] = [];
let redirectOk = true;
let setvarOk = true;

// redirectChannelToAgent шлёт Setvar/Redirect через withAmiConnection (одна
// AMI-сессия на всю цепочку, 06.09.2026), поэтому поддельная станция отвечает
// send() из withAmiConnection, а не amiAction (эта функция им больше не вызывается).
async function respond(
  action: string,
  fields: Record<string, string | number> = {}
): Promise<{ ok: boolean; error?: string }> {
  amiSent.push({ action, fields });
  if (action === "Setvar" && !setvarOk) return { ok: false, error: "No such channel" };
  if (action === "Redirect" && !redirectOk) return { ok: false, error: "No such channel" };
  return { ok: true };
}

vi.mock("../src/lib/telephony/amiClient.js", () => ({
  loadAmiCredentials: async () => ({ host: "127.0.0.1", port: 5038, username: "crm", password: "x" }),
  amiAction: async (_creds: unknown, action: string, fields?: Record<string, string | number>) => respond(action, fields),
  withAmiConnection: async (
    _creds: unknown,
    run: (send: (action: string, fields?: Record<string, string | number>) => Promise<unknown>) => Promise<unknown>
  ) => run(respond),
}));

const loggedErrors: string[] = [];
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string) => {
    loggedErrors.push(message);
  },
}));

const { redirectChannelToAgent } = await import("../src/lib/telephony/inboundRouting.js");

function baseInput(over: Partial<{ isAnswered: () => boolean }> = {}) {
  return {
    channelName: "SIP/out-00000012",
    extension: "1901",
    dialTarget: "SIP/1901",
    viaMobile: false,
    ringSeconds: 25,
    fallback: "voicemail" as const,
    isAnswered: () => false,
    logLabel: "тестовый перевод",
    failLabel: "тестовый перевод не удался",
    ...over,
  };
}

beforeEach(() => {
  amiSent.length = 0;
  loggedErrors.length = 0;
  redirectOk = true;
  setvarOk = true;
});

describe("redirectChannelToAgent", () => {
  it("живой непринятый звонок (isAnswered всегда false) доходит до Redirect — регрессия 475d5a9a", async () => {
    const result = await redirectChannelToAgent(baseInput({ isAnswered: () => false }));

    expect(result).toEqual({ ok: true });
    const actions = amiSent.map((a) => a.action);
    expect(actions).toContain("Setvar");
    expect(actions).toContain("Redirect");
  });

  it("к моменту финальной проверки трубку уже сняли — Setvar уходит, Redirect нет", async () => {
    // isAnswered проверяется РОВНО ОДИН РАЗ — прямо перед Redirect (единственная
    // оставшаяся защита после того, как убрали инвертированную проверку перед
    // Setvar). true здесь имитирует «пока слали Setvar, агент/клиент уже
    // разговаривают» — переводить такой звонок нельзя, он оборвёт разговор.
    const result = await redirectChannelToAgent(baseInput({ isAnswered: () => true }));

    expect(result).toEqual({ ok: false, reason: "already_answered" });
    expect(amiSent.some((a) => a.action === "Setvar")).toBe(true);
    expect(amiSent.some((a) => a.action === "Redirect")).toBe(false);
  });

  it("станция отказала на Setvar — редирект не идёт, ошибка в журнале", async () => {
    setvarOk = false;
    const result = await redirectChannelToAgent(baseInput());

    expect(result).toEqual({ ok: false, reason: "redirect_failed" });
    expect(amiSent.some((a) => a.action === "Redirect")).toBe(false);
    expect(loggedErrors).toHaveLength(1);
  });

  it("станция отказала на Redirect — звонок остаётся, ошибка в журнале", async () => {
    redirectOk = false;
    const result = await redirectChannelToAgent(baseInput());

    expect(result).toEqual({ ok: false, reason: "redirect_failed" });
    expect(loggedErrors).toHaveLength(1);
  });
});
