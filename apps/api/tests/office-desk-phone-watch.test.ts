import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * ОФИСНЫЙ АППАРАТ НЕ НА СВЯЗИ В РАБОЧЕЕ ВРЕМЯ (18.11.2026, lib/telephony/officeDeskPhoneWatch.ts).
 * 18.11 аппарат 2020, на который заведены все незнакомые звонки и звонки из WhatsApp,
 * не зарегистрировался за весь день — и никто этого не увидел.
 */

const { prisma } = await import("../src/db.js");
const { watchOfficeDeskPhone, resetOfficeDeskWatch, OFFICE_DESK_OFFLINE_ALARM_KEY } = await import(
  "../src/lib/telephony/officeDeskPhoneWatch.js"
);

const creds = { url: "http://station.test", username: "test", password: "stand-password", app: "test" };
let endpointState: "online" | "offline" = "offline";
const deps = {
  loadCreds: async () => creds as never,
  listEndpoints: async () =>
    [
      { technology: "PJSIP", resource: "2020", state: endpointState, channel_ids: [] },
      { technology: "PJSIP", resource: "1001", state: "online", channel_ids: [] },
    ] as never,
};
/** 16.11.2026 — понедельник; время по Душанбе (UTC+5). */
const at = (hhmm: string, day = "2026-11-16") => new Date(`${day}T${hhmm}:00+05:00`);
const openAlarms = () =>
  prisma.errorLog.findMany({ where: { source: "telephony", dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY, resolvedAt: null } });

let saved: Record<string, unknown> | null = null;

beforeAll(async () => {
  saved = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { incomingPrimaryTarget: true, incomingPrimaryExtension: true, workHoursStart: true, workHoursEnd: true, companyDaysOff: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { incomingPrimaryTarget: "extension", incomingPrimaryExtension: "2020", workHoursStart: "09:30", workHoursEnd: "18:00", companyDaysOff: [0] },
  });
});

beforeEach(async () => {
  resetOfficeDeskWatch();
  endpointState = "offline";
  await prisma.notification.deleteMany({ where: { tag: TAG } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: TAG } });
  await prisma.errorLog.deleteMany({ where: { dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY } });
});

const TAG = "incoming-primary-unreachable-2020";
const runId = Math.floor(Math.random() * 900000) + 100000;
const agentIds: string[] = [];

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: TAG } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: TAG } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.errorLog.deleteMany({ where: { dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY } });
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.$disconnect();
});

describe("офисный аппарат", () => {
  it("не на связи в рабочее время две проверки подряд — одна тревога с временем; третья не дублирует", async () => {
    expect((await watchOfficeDeskPhone(at("11:00"), deps)).alarmed).toBe(false);
    expect(await openAlarms()).toHaveLength(0);
    expect((await watchOfficeDeskPhone(at("11:15"), deps)).alarmed).toBe(true);
    const [alarm] = await openAlarms();
    expect(alarm?.message).toBe(
      "Офисный аппарат 2020 не на связи с 11:00 — незнакомые звонки и звонки из WhatsApp сейчас никто не примет. Включите трубку и проверьте Wi-Fi в офисе."
    );
    await watchOfficeDeskPhone(at("11:30"), deps);
    expect(await openAlarms()).toHaveLength(1);
  });

  it("утром 45 минут отсрочки: выключен с начала дня — тревога только после неё, время — с первой проверки", async () => {
    expect((await watchOfficeDeskPhone(at("09:30"), deps)).skipped).toBe("morning_grace");
    expect((await watchOfficeDeskPhone(at("10:00"), deps)).skipped).toBe("morning_grace");
    expect((await watchOfficeDeskPhone(at("10:15"), deps)).alarmed).toBe(false);
    expect(await openAlarms()).toHaveLength(0);
    expect((await watchOfficeDeskPhone(at("10:30"), deps)).alarmed).toBe(true);
    expect((await openAlarms())[0]?.message).toContain("не на связи с 09:30");
  });

  it("включили в отсрочку — тревоги нет", async () => {
    await watchOfficeDeskPhone(at("09:30"), deps);
    endpointState = "online";
    await watchOfficeDeskPhone(at("09:45"), deps);
    await watchOfficeDeskPhone(at("10:30"), deps);
    expect(await openAlarms()).toHaveLength(0);
  });

  it("ночью и в общий выходной — не судит", async () => {
    await watchOfficeDeskPhone(at("22:00"), deps);
    expect((await watchOfficeDeskPhone(at("22:15"), deps)).skipped).toBe("off_hours");
    // 15.11.2026 — воскресенье (companyDaysOff: [0]).
    await watchOfficeDeskPhone(at("11:00", "2026-11-15"), deps);
    await watchOfficeDeskPhone(at("11:15", "2026-11-15"), deps);
    expect(await openAlarms()).toHaveLength(0);
  });

  it("снова на связи — тревога закрывается сама", async () => {
    await watchOfficeDeskPhone(at("11:00"), deps);
    await watchOfficeDeskPhone(at("11:15"), deps);
    expect(await openAlarms()).toHaveLength(1);
    endpointState = "online";
    expect((await watchOfficeDeskPhone(at("11:30"), deps)).online).toBe(true);
    expect(await openAlarms()).toHaveLength(0);
  });

  it("одно моргание не тревога; станция не ответила — не судит; приём на очередь — молчит", async () => {
    await watchOfficeDeskPhone(at("11:00"), deps);
    endpointState = "online";
    await watchOfficeDeskPhone(at("11:15"), deps);
    endpointState = "offline";
    await watchOfficeDeskPhone(at("11:30"), deps);
    expect(await openAlarms()).toHaveLength(0);

    const broken = {
      ...deps,
      listEndpoints: async () => {
        throw new Error("туннель");
      },
    };
    expect((await watchOfficeDeskPhone(at("11:45"), broken)).skipped).toBe("station_unreachable");

    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingPrimaryTarget: "queue" } });
    try {
      expect((await watchOfficeDeskPhone(at("12:00"), deps)).skipped).toBe("not_extension");
      expect((await watchOfficeDeskPhone(at("12:15"), deps)).skipped).toBe("not_extension");
      expect(await openAlarms()).toHaveLength(0);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { incomingPrimaryTarget: "extension" } });
    }
  });
});

describe("офисный аппарат — единственный хозяин тревоги «аппарат приёма выключен» (18.11.2026)", () => {
  it("выключен и мобильного плеча нет — журнал и уведомление директору, не чаще раза в сутки", async () => {
    const director = await prisma.agent.create({
      data: { fullName: `Директор аппарата-${runId}`, phone: `+992940${runId}`, role: "DIRECTOR", passwordHash: "x", isActive: true },
    });
    agentIds.push(director.id);
    await watchOfficeDeskPhone(at("11:00"), deps);
    await watchOfficeDeskPhone(at("11:15"), deps);
    const note = await prisma.notification.findFirst({ where: { tag: TAG, agentId: director.id } });
    expect(note?.body).toContain("Офисный аппарат 2020 не на связи");
    expect(note?.body).toContain("если не ответили");
    // Закрылась и открылась снова в тот же день — второго уведомления нет.
    endpointState = "online";
    await watchOfficeDeskPhone(at("11:30"), deps);
    endpointState = "offline";
    await watchOfficeDeskPhone(at("11:45"), deps);
    await watchOfficeDeskPhone(at("12:00"), deps);
    expect(await prisma.notification.count({ where: { tag: TAG, agentId: director.id } })).toBe(1);
  });

  it("у аппарата есть владелец с наборным мобильным — выключенная трубка не тревога", async () => {
    const owner = await prisma.agent.create({
      data: { fullName: `Владелец 2020-${runId}`, phone: `+992950${runId}`, role: "AGENT", sipExtension: "2020", passwordHash: "x", isActive: true },
    });
    agentIds.push(owner.id);
    try {
      expect((await watchOfficeDeskPhone(at("11:00"), deps)).skipped).toBe("mobile_leg");
      expect((await watchOfficeDeskPhone(at("11:15"), deps)).skipped).toBe("mobile_leg");
      expect(await openAlarms()).toHaveLength(0);
    } finally {
      await prisma.agent.delete({ where: { id: owner.id } });
      agentIds.splice(agentIds.indexOf(owner.id), 1);
    }
  });
});
