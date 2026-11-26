import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelVolumeVerdict,
  isChannelWatchDay,
  isChannelWatchHour,
  WATCH_MIN_AVERAGE,
  WATCHED_CHANNELS,
} from "../src/lib/channelVolumeWatch.js";

const channelOn: Record<string, boolean> = { INSTAGRAM: true, FACEBOOK: true };
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  isMetaChannelEnabled: async (channel: string) => channelOn[channel] ?? false,
}));

const AVG = WATCH_MIN_AVERAGE; // столько новых диалогов в окне за каждые из 7 прошлых суток
const TOTAL = 7 * AVG;

/** Живой случай 22.11.2026: Instagram 10–18 новых диалогов в день, в тот день — 2; Facebook 5–8, в тот день — 0. */
describe("channelVolumeVerdict", () => {
  it("тревога: ноль сейчас, ноль и в прошлом запуске, обычно не меньше порога", () => {
    expect(channelVolumeVerdict(0, TOTAL, 0).alert).toBe(true);
  });

  it("средняя ниже порога: тихо (мелкий канал, где и обычно мало)", () => {
    expect(channelVolumeVerdict(0, 7 * (AVG - 1), 0).alert).toBe(false);
    expect(channelVolumeVerdict(0, 7 * 3, 0).alert).toBe(false);
  });

  it("хотя бы один новый диалог: тихо, даже при резком падении", () => {
    expect(channelVolumeVerdict(1, 7 * 20, 0).alert).toBe(false);
    expect(channelVolumeVerdict(2, 7 * 10, 0).alert).toBe(false);
  });

  it("в окне прошлого запуска что-то было: это первый тик нуля, тревоги ещё нет", () => {
    expect(channelVolumeVerdict(0, TOTAL, 1).alert).toBe(false);
  });

  it("возвращает среднее за сутки", () => {
    expect(channelVolumeVerdict(0, 35).average).toBe(5);
  });
});

describe("WATCHED_CHANNELS: WhatsApp сторожит lib/whatsappWebhookWatch.ts", () => {
  it("только Instagram и Facebook", () => {
    expect([...WATCHED_CHANNELS]).toEqual(["INSTAGRAM", "FACEBOOK"]);
  });
});

describe("isChannelWatchHour: только днём по Душанбе", () => {
  it("полдень по Душанбе (07:00 UTC): смотрим", () => {
    expect(isChannelWatchHour(new Date("2026-11-24T07:00:00Z"))).toBe(true);
  });

  it("ночь по Душанбе (22:00 UTC = 03:00): молчим", () => {
    expect(isChannelWatchHour(new Date("2026-11-23T22:00:00Z"))).toBe(false);
  });

  it("граница 22:00 по Душанбе (17:00 UTC): уже не смотрим", () => {
    expect(isChannelWatchHour(new Date("2026-11-24T17:00:00Z"))).toBe(false);
  });
});

describe("isChannelWatchDay: только будни по Душанбе", () => {
  it("вторник: смотрим", () => {
    expect(isChannelWatchDay(new Date("2026-11-24T07:00:00Z"))).toBe(true);
  });

  it("суббота и воскресенье (по Душанбе): молчим", () => {
    expect(isChannelWatchDay(new Date("2026-11-28T07:00:00Z"))).toBe(false);
    expect(isChannelWatchDay(new Date("2026-11-29T07:00:00Z"))).toBe(false);
  });

  it("воскресенье 20:00 UTC это уже понедельник 01:00 по Душанбе: день будний", () => {
    expect(isChannelWatchDay(new Date("2026-11-29T20:00:00Z"))).toBe(true);
  });
});

describe("runChannelVolumeWatchTick: на базе", () => {
  const prefix = `chw-${Date.now()}`;
  const at = new Date("2026-11-24T07:00:00Z"); // вторник, полдень по Душанбе
  const TAGS = ["channel-volume-INSTAGRAM", "channel-volume-FACEBOOK"];

  /** По `perDay` диалогов в окне «последние 8 часов» каждых из 7 прошлых суток, начиная с вчера. */
  async function seedBaseline(channel: string, perDay: number) {
    const { prisma } = await import("../src/db.js");
    const rows = [];
    for (let day = 1; day <= 7; day += 1) {
      for (let i = 0; i < perDay; i += 1) {
        rows.push({
          channel,
          subscriberId: `${prefix}-${channel}-${day}-${i}`,
          createdAt: new Date(at.getTime() - day * 86400000 - ((i % 6) + 1) * 3600000 + 1800000),
        });
      }
    }
    await prisma.botConversation.createMany({ data: rows });
  }

  async function seedOne(channel: string, hoursAgo: number) {
    const { prisma } = await import("../src/db.js");
    await prisma.botConversation.create({
      data: { channel, subscriberId: `${prefix}-${channel}-now-${hoursAgo}`, createdAt: new Date(at.getTime() - hoursAgo * 3600000) },
    });
  }

  async function tick(when = at) {
    const { runChannelVolumeWatchTick } = await import("../src/lib/channelVolumeWatch.js");
    return runChannelVolumeWatchTick(when);
  }

  async function clean() {
    const { prisma } = await import("../src/db.js");
    await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: prefix } } });
    await prisma.messengerAccount.deleteMany({ where: { externalId: { startsWith: prefix } } });
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: TAGS } } });
  }

  beforeAll(clean);
  beforeEach(async () => {
    channelOn.INSTAGRAM = true;
    channelOn.FACEBOOK = true;
    await clean();
  });
  afterAll(clean);

  it("канал с обычным потоком замолчал: одна тревога, повтор в то же окно не дублирует", async () => {
    const { prisma } = await import("../src/db.js");
    await seedBaseline("INSTAGRAM", AVG);
    const first = await tick();
    expect(first.alerted).toContain("INSTAGRAM");
    const second = await tick(new Date(at.getTime() + 3600000));
    expect(second.alerted).not.toContain("INSTAGRAM");
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: "channel-volume-INSTAGRAM" } })).toBe(1);
  });

  it("другой канал не задет: тревога только по замолчавшему", async () => {
    await seedBaseline("INSTAGRAM", AVG);
    await seedBaseline("FACEBOOK", AVG);
    await seedOne("FACEBOOK", 1);
    expect((await tick()).alerted).toEqual(["INSTAGRAM"]);
  });

  it("канал выключен или не настроен: тихо", async () => {
    await seedBaseline("INSTAGRAM", AVG);
    channelOn.INSTAGRAM = false;
    expect((await tick()).alerted).toEqual([]);
  });

  it("средняя ниже порога: тихо", async () => {
    await seedBaseline("INSTAGRAM", AVG - 2);
    expect((await tick()).alerted).toEqual([]);
  });

  it("один тик нуля: тревоги нет, второй подряд: есть", async () => {
    await seedBaseline("INSTAGRAM", AVG);
    // 8,5 ч назад: в окне прошлого запуска (от 1 до 9 ч), но уже не в текущем окне (до 8 ч).
    await seedOne("INSTAGRAM", 8.5);
    expect((await tick()).alerted).toEqual([]);
    // Через час диалог вышел и из окна прошлого запуска: два нуля подряд.
    expect((await tick(new Date(at.getTime() + 3600000))).alerted).toContain("INSTAGRAM");
  });

  it("Instagram: все включённые аккаунты закрыты Meta (accessLostAt): тихо; есть живой: тревога", async () => {
    const { prisma } = await import("../src/db.js");
    await seedBaseline("INSTAGRAM", AVG);
    await prisma.messengerAccount.create({
      data: { channel: "INSTAGRAM", externalId: `${prefix}-a`, title: "chw a", token: "x", enabled: true, accessLostAt: new Date(at.getTime() - 86400000) },
    });
    expect((await tick()).alerted).toEqual([]);
    await prisma.messengerAccount.create({
      data: { channel: "INSTAGRAM", externalId: `${prefix}-b`, title: "chw b", token: "x", enabled: true },
    });
    expect((await tick()).alerted).toContain("INSTAGRAM");
  });

  it("ночью по Душанбе тихо", async () => {
    expect((await tick(new Date("2026-11-23T22:00:00Z"))).alerted).toEqual([]);
  });

  it("в субботу по Душанбе тихо", async () => {
    expect((await tick(new Date("2026-11-28T07:00:00Z"))).alerted).toEqual([]);
  });

  it("первый час дня (10:40 по Душанбе): прошлого запуска не было, тихо", async () => {
    await seedBaseline("INSTAGRAM", AVG);
    expect((await tick(new Date("2026-11-24T05:40:00Z"))).alerted).toEqual([]);
  });
});
