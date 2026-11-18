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
  await prisma.errorLog.deleteMany({ where: { dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY } });
});

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY } });
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.$disconnect();
});

describe("офисный аппарат", () => {
  it("не на связи в рабочее время две проверки подряд — одна тревога с временем; третья не дублирует", async () => {
    expect((await watchOfficeDeskPhone(at("10:00"), deps)).alarmed).toBe(false);
    expect(await openAlarms()).toHaveLength(0);
    expect((await watchOfficeDeskPhone(at("10:15"), deps)).alarmed).toBe(true);
    const [alarm] = await openAlarms();
    expect(alarm?.message).toBe(
      "Офисный аппарат 2020 не на связи с 10:00 — незнакомые звонки и звонки из WhatsApp сейчас никто не примет. Включите трубку и проверьте Wi-Fi в офисе."
    );
    await watchOfficeDeskPhone(at("10:30"), deps);
    expect(await openAlarms()).toHaveLength(1);
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
    await watchOfficeDeskPhone(at("10:00"), deps);
    await watchOfficeDeskPhone(at("10:15"), deps);
    expect(await openAlarms()).toHaveLength(1);
    endpointState = "online";
    expect((await watchOfficeDeskPhone(at("10:30"), deps)).online).toBe(true);
    expect(await openAlarms()).toHaveLength(0);
  });

  it("одно моргание не тревога; станция не ответила — не судит; приём на очередь — молчит", async () => {
    await watchOfficeDeskPhone(at("10:00"), deps);
    endpointState = "online";
    await watchOfficeDeskPhone(at("10:15"), deps);
    endpointState = "offline";
    await watchOfficeDeskPhone(at("10:30"), deps);
    expect(await openAlarms()).toHaveLength(0);

    const broken = {
      ...deps,
      listEndpoints: async () => {
        throw new Error("туннель");
      },
    };
    expect((await watchOfficeDeskPhone(at("10:45"), broken)).skipped).toBe("station_unreachable");

    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingPrimaryTarget: "queue" } });
    try {
      expect((await watchOfficeDeskPhone(at("11:00"), deps)).skipped).toBe("not_extension");
      expect((await watchOfficeDeskPhone(at("11:15"), deps)).skipped).toBe("not_extension");
      expect(await openAlarms()).toHaveLength(0);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { incomingPrimaryTarget: "extension" } });
    }
  });
});
