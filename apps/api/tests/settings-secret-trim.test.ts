import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { decryptSecretSafe } from "../src/crypto.js";

/**
 * Пробел на краях ключей/секретов в PATCH /settings (17.09.2026) — владелец вставил
 * Client secret TikTok с ведущим пробелом, TikTok ответил «Client key or secret is
 * incorrect». Причина: settingsUpdateSchema принимал строку как есть и шифровал/
 * сохранял её с пробелом, decryptSecretSafe его тоже не трогает. Проверяем ВЕСЬ
 * класс — не только TikTok, но и рядом стоящие YouTube/Meta/Asterisk поля,
 * зашифрованные и незашифрованные (см. CLAUDE.md: «нашёл баг — ищи весь класс»).
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let saved: Record<string, unknown> = {};

const TOUCHED = [
  "tiktokClientKey",
  "tiktokClientSecret",
  "youtubeClientId",
  "youtubeClientSecret",
  "metaAppId",
  "metaAppSecret",
  "asteriskAriUrl",
  "asteriskAriUsername",
  "asteriskAriPassword",
] as const;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ секретов", phone: `+992937${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(TOUCHED.map((k) => [k, (current as Record<string, unknown>)[k]]));
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("PATCH /settings обрезает пробелы у ключей/секретов", () => {
  it("tiktokClientKey (не секрет, ...rest напрямую) — пробел обрезан", async () => {
    const res = await patch({ tiktokClientKey: "  aw1234567890  " }); // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    expect(res.status).toBe(200);
    expect(res.body.tiktokClientKey).toBe("aw1234567890");
    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { tiktokClientKey: true } });
    expect(fresh?.tiktokClientKey).toBe("aw1234567890");
  });

  it("tiktokClientSecret (зашифрован) — пробел обрезан ДО шифрования", async () => {
    const res = await patch({ tiktokClientSecret: " secret-value-1 " });
    expect(res.status).toBe(200);
    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { tiktokClientSecret: true } });
    expect(decryptSecretSafe(fresh?.tiktokClientSecret ?? null)).toBe("secret-value-1");
  });

  it("youtubeClientId/youtubeClientSecret — тот же класс бага, та же починка", async () => {
    const res = await patch({ youtubeClientId: " yt-id-1 ", youtubeClientSecret: " yt-secret-1 " });
    expect(res.status).toBe(200);
    expect(res.body.youtubeClientId).toBe("yt-id-1");
    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { youtubeClientId: true, youtubeClientSecret: true },
    });
    expect(fresh?.youtubeClientId).toBe("yt-id-1");
    expect(decryptSecretSafe(fresh?.youtubeClientSecret ?? null)).toBe("yt-secret-1");
  });

  it("metaAppId/metaAppSecret — тот же класс", async () => {
    const res = await patch({ metaAppId: " meta-id-1 ", metaAppSecret: " meta-secret-1 " });
    expect(res.status).toBe(200);
    expect(res.body.metaAppId).toBe("meta-id-1");
    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaAppId: true, metaAppSecret: true },
    });
    expect(fresh?.metaAppId).toBe("meta-id-1");
    expect(decryptSecretSafe(fresh?.metaAppSecret ?? null)).toBe("meta-secret-1");
  });

  it("asteriskAriUrl/Username/Password — тот же класс, включая URL", async () => {
    const res = await patch({
      asteriskAriUrl: " http://10.0.0.1:8088 ",
      asteriskAriUsername: " ari-user ",
      asteriskAriPassword: " ari-pass ",
    });
    expect(res.status).toBe(200);
    expect(res.body.asteriskAriUrl).toBe("http://10.0.0.1:8088");
    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { asteriskAriUrl: true, asteriskAriUsername: true, asteriskAriPassword: true },
    });
    expect(fresh?.asteriskAriUrl).toBe("http://10.0.0.1:8088");
    expect(fresh?.asteriskAriUsername).toBe("ari-user");
    expect(decryptSecretSafe(fresh?.asteriskAriPassword ?? null)).toBe("ari-pass");
  });

  it("пустая строка (после обрезки пробелов тоже пустая) по-прежнему очищает значение", async () => {
    await patch({ tiktokClientSecret: "keep-me-then-clear" });
    const res = await patch({ tiktokClientSecret: "   " });
    expect(res.status).toBe(200);
    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { tiktokClientSecret: true } });
    expect(fresh?.tiktokClientSecret).toBeNull();
  });
});
