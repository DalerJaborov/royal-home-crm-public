import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { encryptSecret, decryptSecretSafe } from "../src/crypto.js";
import { loadCredentials } from "../src/messengers/meta.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";

/**
 * ОДИН ИСТОЧНИК ТОКЕНА INSTAGRAM (ОБ-000113, владелец 21.09.2026).
 *
 * До этой правки `loadCredentials().igToken` читал ТОЛЬКО `Settings.metaIgToken`,
 * а лента/переписка/аккаунты (messengers/accounts.ts) — маркер аккаунта по
 * умолчанию из MessengerAccount. Разъехались — публикация в Instagram молча не
 * удалась, хотя переписка тем же токеном работала. Проверяем: MessengerAccount
 * побеждает, Settings — запасной путь, второй аккаунт (isDefault=false) никогда
 * не подменяет основной, а PATCH /settings обновляет оба места разом.
 */

const runId = Date.now();
const password = "testpass123";
const IG_EXTERNAL = `ig-source-${runId}-main`;
const IG_EXTERNAL_SECOND = `ig-source-${runId}-info`;

let adminId: string;
let adminToken: string;
let savedSettings: { metaIgToken: string | null };

async function clearAccounts() {
  await prisma.messengerAccount.deleteMany({
    where: { externalId: { in: [IG_EXTERNAL, IG_EXTERNAL_SECOND] } },
  });
  resetAccountsCache();
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ токена IG", phone: `+992938${runId}`.slice(0, 13), role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = { metaIgToken: current.metaIgToken };
  await clearAccounts();
});

/** Сосед по базе (tests/lead-magnet-flow.test.ts) на время своих тестов заводит
 *  СВОЙ Instagram-аккаунт по умолчанию и удаляет его после каждого теста; пока он
 *  жив, loadCredentials честно отдаёт его токен, а не наш (25.09.2026, красный
 *  только в полном прогоне). Ждём, пока чужой «по умолчанию» уйдёт, — не трогая
 *  чужие строки. */
async function waitForNoForeignDefault(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const foreign = await prisma.messengerAccount.count({
      where: { channel: "INSTAGRAM", isDefault: true, externalId: { notIn: [IG_EXTERNAL, IG_EXTERNAL_SECOND] } },
    });
    if (foreign === 0) return;
    if (Date.now() > deadline) throw new Error(`чужой Instagram-аккаунт по умолчанию не исчез за 60 с (${foreign} шт.)`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeEach(async () => {
  await waitForNoForeignDefault();
  resetAccountsCache();
});
afterEach(clearAccounts);

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("loadCredentials — источник токена Instagram", () => {
  it("аккаунт по умолчанию побеждает Settings.metaIgToken", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgToken: encryptSecret("settings-token-stale") } });
    await prisma.messengerAccount.create({
      data: {
        channel: "INSTAGRAM",
        externalId: IG_EXTERNAL,
        title: "Royal Home",
        token: encryptSecret("account-token-fresh"),
        enabled: true,
        isDefault: true,
      },
    });
    resetAccountsCache();

    const creds = await loadCredentials();
    expect(creds.igToken).toBe("account-token-fresh");
  });

  it("нет аккаунта по умолчанию — откат на Settings.metaIgToken", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgToken: encryptSecret("settings-token-only") } });
    resetAccountsCache();

    const creds = await loadCredentials();
    expect(creds.igToken).toBe("settings-token-only");
  });

  it("второй аккаунт (isDefault=false) не подменяет основной", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgToken: encryptSecret("settings-token-stale") } });
    await prisma.messengerAccount.create({
      data: {
        channel: "INSTAGRAM",
        externalId: IG_EXTERNAL,
        title: "Royal Home",
        token: encryptSecret("main-account-token"),
        enabled: true,
        isDefault: true,
      },
    });
    await prisma.messengerAccount.create({
      data: {
        channel: "INSTAGRAM",
        externalId: IG_EXTERNAL_SECOND,
        title: "Royal Home Info",
        token: encryptSecret("second-account-token"),
        enabled: true,
        isDefault: false,
      },
    });
    resetAccountsCache();

    const creds = await loadCredentials();
    expect(creds.igToken).toBe("main-account-token");
    expect(creds.igToken).not.toBe("second-account-token");
  });

  it("аккаунт по умолчанию выключен (enabled=false) — откат на Settings", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaIgToken: encryptSecret("settings-token-fallback") } });
    await prisma.messengerAccount.create({
      data: {
        channel: "INSTAGRAM",
        externalId: IG_EXTERNAL,
        title: "Royal Home",
        token: encryptSecret("disabled-account-token"),
        enabled: false,
        isDefault: true,
      },
    });
    resetAccountsCache();

    const creds = await loadCredentials();
    expect(creds.igToken).toBe("settings-token-fallback");
  });
});

describe("PATCH /settings — маркер Instagram уходит в тот же источник, что и лента", () => {
  it("обновляет token заведённого аккаунта по умолчанию, а не только Settings", async () => {
    const account = await prisma.messengerAccount.create({
      data: {
        channel: "INSTAGRAM",
        externalId: IG_EXTERNAL,
        title: "Royal Home",
        token: encryptSecret("old-account-token"),
        enabled: true,
        isDefault: true,
      },
    });
    resetAccountsCache();

    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ metaIgToken: "new-token-from-settings-screen" });
    expect(res.status).toBe(200);

    const updatedAccount = await prisma.messengerAccount.findUnique({ where: { id: account.id } });
    expect(decryptSecretSafe(updatedAccount?.token ?? null)).toBe("new-token-from-settings-screen");

    const creds = await loadCredentials();
    expect(creds.igToken).toBe("new-token-from-settings-screen");
  });
});
