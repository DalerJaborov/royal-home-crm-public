import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runContactLinkSweepTick, SWEEP_LIMIT } from "../src/lib/contactLinkSweep.js";

/**
 * НОЧНОЙ ПОИСК ДВОЙНЫХ ДОСЬЕ ПО СЛАБЫМ ПРИЗНАКАМ.
 *
 * Проверяется ровно то, чем эта задача опасна, а опасна она тем, что работает
 * по признакам, которые ошибаются:
 *
 *  1. выключенный тумблер не заводит НИ ОДНОГО предложения — иначе «выключено»
 *     не значит ничего, а решение о смелости поиска за владельцем;
 *  2. одного имени НЕ ДОСТАТОЧНО: «Далер» и «Умед» в Душанбе носят разные люди,
 *     и пара по одному имени означала бы чужой бюджет в ответе бота;
 *  3. одного похожего хвоста номера тоже не достаточно — это сосед по полосе;
 *  4. задача только ПРЕДЛАГАЕТ: ни одно досье не слито, ничего не помечено
 *     `mergedIntoId`;
 *  5. повторный прогон не плодит вторую строку и не возвращает то, что человек
 *     уже отклонил;
 *  6. имя из профиля канала в признак не идёт — это подпись аккаунта, она
 *     повторяется у разных людей;
 *  7. предложений за ночь не больше предела: очередь разбирает человек.
 */

const runId = String(Date.now()).slice(-6);
/** Девять цифр, различаются ПЕРВЫМИ двумя — хвост из семи общий. */
const PHONE_A = `90${runId}123`.slice(0, 9);
const PHONE_B = `91${runId}123`.slice(0, 9);
/** Тот же вид, но хвост другой — по номеру такая пара сходиться не должна. */
const PHONE_C = `92${runId}999`.slice(0, 9);
const HANDLE = `handle_${runId}`;
const NAME = `Далер Сверка ${runId}`;

const created: string[] = [];

async function profile(input: {
  displayName?: string | null;
  nameSource?: string | null;
  category?: string;
  identities?: Array<{ kind: string; value: string; trust?: string }>;
}): Promise<string> {
  const row = await prisma.contactProfile.create({
    data: {
      displayName: input.displayName ?? null,
      nameSource: input.nameSource ?? "self",
      category: input.category ?? "UNKNOWN",
      identities: {
        create: (input.identities ?? []).map((i) => ({
          kind: i.kind,
          value: i.value,
          trust: i.trust ?? "TRANSPORT",
        })),
      },
    },
  });
  created.push(row.id);
  return row.id;
}

async function setSweep(enabled: boolean): Promise<void> {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", contactLinkSweepEnabled: enabled },
    update: { contactLinkSweepEnabled: enabled },
  });
}

async function candidatesFor(ids: string[]): Promise<Array<{ reason: string; status: string }>> {
  return prisma.contactLinkCandidate.findMany({
    where: { OR: [{ leftId: { in: ids } }, { rightId: { in: ids } }] },
    select: { reason: true, status: true },
  });
}

async function cleanup(): Promise<void> {
  if (created.length === 0) return;
  await prisma.contactLinkCandidate.deleteMany({
    where: { OR: [{ leftId: { in: created } }, { rightId: { in: created } }] },
  });
  await prisma.contactIdentity.deleteMany({ where: { profileId: { in: created } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: created } } });
  created.length = 0;
}

let sweepWasEnabled = false;

beforeAll(async () => {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { contactLinkSweepEnabled: true },
  });
  sweepWasEnabled = s?.contactLinkSweepEnabled ?? false;
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await setSweep(sweepWasEnabled);
});

describe("ночной поиск двойных досье", () => {
  it("тумблер выключен — ни одного предложения", async () => {
    await setSweep(false);
    const a = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_A }] });
    const b = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_B }] });

    const stats = await runContactLinkSweepTick();
    expect(stats.skipped).toBe(true);
    expect(stats.proposed).toBe(0);
    expect(await candidatesFor([a, b])).toHaveLength(0);
  });

  it("одно имя и похожий хвост номера — предложение, но не слияние", async () => {
    await setSweep(true);
    const a = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_A }] });
    const b = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_B }] });

    const stats = await runContactLinkSweepTick();
    expect(stats.proposed).toBeGreaterThanOrEqual(1);
    const found = await candidatesFor([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("NAME_AND_DIGITS");
    expect(found[0].status).toBe("PENDING");

    // Главное свойство: разбирает человек, задача ничего не слила.
    const rows = await prisma.contactProfile.findMany({
      where: { id: { in: [a, b] } },
      select: { mergedIntoId: true },
    });
    expect(rows.every((r) => r.mergedIntoId === null)).toBe(true);
  });

  it("одного имени НЕ достаточно: номера непохожие — пары нет", async () => {
    await setSweep(true);
    const a = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_A }] });
    const b = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_C }] });

    await runContactLinkSweepTick();
    expect(await candidatesFor([a, b])).toHaveLength(0);
  });

  it("одного похожего хвоста НЕ достаточно: имена разные — пары нет", async () => {
    await setSweep(true);
    const a = await profile({ displayName: `Умед ${runId}`, identities: [{ kind: "PHONE", value: PHONE_A }] });
    const b = await profile({ displayName: `Фируз ${runId}`, identities: [{ kind: "PHONE", value: PHONE_B }] });

    await runContactLinkSweepTick();
    expect(await candidatesFor([a, b])).toHaveLength(0);
  });

  it("имя из профиля канала в признак не идёт", async () => {
    await setSweep(true);
    const a = await profile({
      displayName: NAME,
      nameSource: "profile",
      identities: [{ kind: "PHONE", value: PHONE_A }],
    });
    const b = await profile({
      displayName: NAME,
      nameSource: "profile",
      identities: [{ kind: "PHONE", value: PHONE_B }],
    });

    await runContactLinkSweepTick();
    expect(await candidatesFor([a, b])).toHaveLength(0);
  });

  it("один ник в разных мессенджерах — предложение", async () => {
    await setSweep(true);
    const a = await profile({ identities: [{ kind: "TG_USERNAME", value: HANDLE, trust: "PROFILE" }] });
    const b = await profile({ identities: [{ kind: "IG_USERNAME", value: HANDLE, trust: "PROFILE" }] });

    await runContactLinkSweepTick();
    const found = await candidatesFor([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("USERNAME");
  });

  it("спам в пары не идёт вовсе", async () => {
    await setSweep(true);
    const a = await profile({
      displayName: NAME,
      category: "SPAM",
      identities: [{ kind: "PHONE", value: PHONE_A }],
    });
    const b = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_B }] });

    await runContactLinkSweepTick();
    expect(await candidatesFor([a, b])).toHaveLength(0);
  });

  it("повторная ночь не плодит вторую строку и не возвращает отклонённое", async () => {
    await setSweep(true);
    const a = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_A }] });
    const b = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_B }] });

    await runContactLinkSweepTick();
    const second = await runContactLinkSweepTick();
    expect(second.proposed).toBe(0);
    expect(await candidatesFor([a, b])).toHaveLength(1);

    // Человек сказал «разные люди» — следующая ночь не предлагает заново.
    await prisma.contactLinkCandidate.updateMany({
      where: { OR: [{ leftId: { in: [a, b] } }, { rightId: { in: [a, b] } }] },
      data: { status: "REJECTED", decidedAt: new Date() },
    });
    const third = await runContactLinkSweepTick();
    expect(third.proposed).toBe(0);
    const after = await candidatesFor([a, b]);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("REJECTED");
  });

  /**
   * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-06: известные пары занимали лимит ДО исключения.
   * Оба SQL-запроса резали выдачу по LIMIT 50 раньше, чем известные пары исключались, а
   * потом slice(0, 50) резал ещё раз до проверки known: 50 уже предложенных пар по нику
   * закрывали выдачу навсегда, и новая пара «имя + хвост номера» отрезалась каждую ночь.
   */
  it("50+ уже известных пар по нику не заслоняют новую пару по имени и хвосту номера", async () => {
    await setSweep(true);
    const future = new Date(Date.now() + 60 * 60 * 1000); // известные пары «свежее» новой: идут первыми
    const profileRows: Array<{ id: string; lastSeenAt: Date }> = [];
    const identityRows: Array<{ profileId: string; kind: string; value: string; trust: string }> = [];
    const candidateRows: Array<{ leftId: string; rightId: string; reason: string }> = [];
    for (let i = 0; i < SWEEP_LIMIT + 1; i += 1) {
      const tg = randomUUID();
      const ig = randomUUID();
      const handle = `known_${runId}_${i}`;
      profileRows.push({ id: tg, lastSeenAt: future }, { id: ig, lastSeenAt: future });
      identityRows.push(
        { profileId: tg, kind: "TG_USERNAME", value: handle, trust: "PROFILE" },
        { profileId: ig, kind: "IG_USERNAME", value: handle, trust: "PROFILE" }
      );
      const [leftId, rightId] = tg < ig ? [tg, ig] : [ig, tg];
      candidateRows.push({ leftId, rightId, reason: "USERNAME" });
      created.push(tg, ig);
    }
    await prisma.contactProfile.createMany({ data: profileRows });
    await prisma.contactIdentity.createMany({ data: identityRows });
    await prisma.contactLinkCandidate.createMany({ data: candidateRows });

    const a = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_A }] });
    const b = await profile({ displayName: NAME, identities: [{ kind: "PHONE", value: PHONE_B }] });

    await runContactLinkSweepTick();
    const found = await candidatesFor([a, b]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("NAME_AND_DIGITS");
  });

  it("предел за ночь — не «сколько найдётся»", () => {
    // Очередь разбирает человек: триста предложений в ней означают, что её не
    // разберут вовсе. Остаток найдётся следующей ночью.
    expect(SWEEP_LIMIT).toBeLessThanOrEqual(50);
  });
});
