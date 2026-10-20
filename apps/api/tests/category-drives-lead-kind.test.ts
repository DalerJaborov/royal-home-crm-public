import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { categoryForLeadKind, setContactCategory } from "../src/lib/contactProfiles.js";

/**
 * §10.4 плана (docs/contact-profile-and-bot-roles-20-09.md, 22.09.2026):
 * `categoryForLeadKind` — единственная точка, которая читает тумблер
 * `Settings.contactCategoryDrivesLeadKind`. Проверяется ровно то, чем эта
 * функция опасна:
 *
 *  1. выключенный тумблер — `undefined` ВСЕГДА, даже если у досье есть
 *     установленная категория (иначе «выключено» ничего бы не значило);
 *  2. включённый — отдаёт категорию, только если она не UNKNOWN;
 *  3. досье без записи (или удалённое) — undefined, не бросает.
 *
 * Сама подстановка категории в решение о типе карточки проверена в
 * `lead-kind-guards.test.ts` (`decideLeadKind`, чистая функция, без БД) —
 * здесь только чтение тумблера и досье.
 */

const runId = String(Date.now()).slice(-6);
const created: string[] = [];

async function profile(category: string): Promise<string> {
  const row = await prisma.contactProfile.create({
    data: { displayName: `Категория §10.4 ${runId}`, nameSource: "self", category: "UNKNOWN" },
  });
  created.push(row.id);
  if (category !== "UNKNOWN") {
    await setContactCategory({ profileId: row.id, category, source: "guard" });
  }
  return row.id;
}

async function setToggle(enabled: boolean): Promise<void> {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", contactCategoryDrivesLeadKind: enabled },
    update: { contactCategoryDrivesLeadKind: enabled },
  });
}

let wasEnabled = false;

beforeAll(async () => {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { contactCategoryDrivesLeadKind: true },
  });
  wasEnabled = s?.contactCategoryDrivesLeadKind ?? false;
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.contactProfile.deleteMany({ where: { id: { in: created } } });
  }
  await setToggle(wasEnabled);
});

describe("categoryForLeadKind — тумблер §10.4", () => {
  it("тумблер выключен — undefined, даже у досье с установленной категорией SELLER", async () => {
    await setToggle(false);
    const profileId = await profile("SELLER");
    expect(await categoryForLeadKind(profileId)).toBeUndefined();
  });

  it("тумблер включён — отдаёт установленную категорию", async () => {
    await setToggle(true);
    const profileId = await profile("BUYER");
    expect(await categoryForLeadKind(profileId)).toBe("BUYER");
  });

  it("тумблер включён, но категория UNKNOWN — undefined (досье ничего ещё не знает)", async () => {
    await setToggle(true);
    const profileId = await profile("UNKNOWN");
    expect(await categoryForLeadKind(profileId)).toBeUndefined();
  });

  it("profileId не передан — undefined, без обращения к БД", async () => {
    await setToggle(true);
    expect(await categoryForLeadKind(null)).toBeUndefined();
    expect(await categoryForLeadKind(undefined)).toBeUndefined();
  });

  it("несуществующее досье — undefined, не бросает", async () => {
    await setToggle(true);
    expect(await categoryForLeadKind("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });
});
