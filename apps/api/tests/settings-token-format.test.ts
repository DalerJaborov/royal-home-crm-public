import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { decryptSecretSafe } from "../src/crypto.js";

/**
 * ФОРМАТ КЛЮЧЕЙ И МАРКЕРОВ В НАСТРОЙКАХ (22.09.2026, docs/TASKS.md «Осталось по
 * этой теме» от 20.09).
 *
 * Раньше CRM принимала в эти поля что угодно и молчала: ссылку вместо маркера,
 * маркер Facebook Login в поле переписки Instagram, маркер Instagram в поле
 * удаления. Узнавали об этом часами позже по мёртвой переписке — живой случай
 * 20.09, девять ошибок `Cannot parse access token` подряд.
 *
 * Проверяем обе стороны правила: заведомо неверное отвергается с внятным
 * текстом, а правильное и «очистить поле» проходят как раньше. Значение маркера
 * в ответ не попадает — это отдельная проверка ниже.
 */

const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
let saved: Record<string, unknown> = {};

const TOUCHED = ["metaIgToken", "metaIgManageToken", "metaPageToken", "tiktokClientSecret"] as const;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ форматов", phone: `+992936${runId}`, role: "ADMIN", passwordHash },
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

describe("PATCH /settings проверяет формат ключей и маркеров", () => {
  it("маркер Facebook Login в поле переписки Instagram — отказ с подсказкой, где ему место", async () => {
    const res = await patch({ metaIgToken: "EAAXlivetokenvalue1234567890" });
    expect(res.status).toBe(400);
    // Подсказка должна лежать именно в `error`: веб показывает человеку только
    // его (apps/web/src/lib/api.ts), `details` не читает никто.
    expect(res.body.error).toMatch(/EAA/);
    expect(res.body.error).toMatch(/Маркер удаления Instagram/);
    // Само значение наружу не уходит.
    expect(JSON.stringify(res.body)).not.toContain("livetokenvalue1234567890");
  });

  it("маркер Instagram в поле удаления — отказ, обе формы начала (IGAA и IGQ)", async () => {
    for (const value of ["IGAAsomethingsomething1234", "IGQVJXsomethingsomething12"]) {
      const res = await patch({ metaIgManageToken: value });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/graph\.facebook\.com|EAA/);
    }
  });

  it("ссылка вместо ключа — отказ", async () => {
    const res = await patch({ metaPageToken: "https://developers.facebook.com/tools/explorer/" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/ссылка/i);
  });

  it("«Bearer …» и лишний перенос строки — отказ, каждому своя подсказка", async () => {
    const bearer = await patch({ metaPageToken: "Bearer EAAtokenvalue123" });
    expect(bearer.status).toBe(400);
    expect(JSON.stringify(bearer.body)).toMatch(/Bearer/);

    const broken = await patch({ tiktokClientSecret: "aw12345\n67890" });
    expect(broken.status).toBe(400);
    expect(JSON.stringify(broken.body)).toMatch(/пробел|перенос/i);
  });

  it("маска сохранённого ключа (••••1234) обратно не принимается", async () => {
    const res = await patch({ tiktokClientSecret: "••••7890" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/маска/i);
  });

  it("правильные маркеры проходят и сохраняются", async () => {
    const res = await patch({
      metaIgToken: "IGAAcorrectvalue0001",
      metaIgManageToken: "EAAcorrectvalue0002",
    });
    expect(res.status).toBe(200);
    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaIgToken: true, metaIgManageToken: true },
    });
    expect(decryptSecretSafe(fresh?.metaIgToken ?? null)).toBe("IGAAcorrectvalue0001");
    expect(decryptSecretSafe(fresh?.metaIgManageToken ?? null)).toBe("EAAcorrectvalue0002");
  });

  it("пустая строка по-прежнему очищает поле, а не спотыкается о проверку", async () => {
    const res = await patch({ metaIgManageToken: "   " });
    expect(res.status).toBe(200);
    const fresh = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaIgManageToken: true },
    });
    expect(fresh?.metaIgManageToken).toBeNull();
  });
});
