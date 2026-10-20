import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Аудит 04.10.2026, WEB-PAGES13: тумблер кампании воронки слал в PATCH весь
 * свой (возможно, устаревший) снимок и тихо откатывал чужие правки текстов и
 * адресов. Теперь для тумблера есть отдельный маршрут, меняющий ТОЛЬКО enabled.
 */
const runId = Date.now();
const password = "testpass123";

let adminId: string;
let adminToken: string;
const campaignIds: string[] = [];

async function makeCampaign(overrides: Record<string, unknown> = {}) {
  const c = await prisma.leadMagnetCampaign.create({
    data: {
      name: `Тест-воронка-${runId}-${campaignIds.length}`,
      enabled: true,
      keywords: ["чеклист"],
      postUrl: "https://instagram.com/p/AAA/",
      inviteText: "Привет, вот приглашение",
      followText: "Подпишитесь",
      notFollowingText: "Не вижу подписки",
      deliveredText: "Держите файл",
      ...overrides,
    },
  });
  campaignIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Тест Админ воронки", phone: `+992970${String(runId).slice(-9)}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(res.status).toBe(200);
  grantElevation(adminId);
  adminToken = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.leadMagnetCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await deleteAgentsWithTraces([adminId]);
  await prisma.$disconnect();
});

describe("PATCH /lead-magnets/:id/enabled", () => {
  it("выключает кампанию и не откатывает правки, сделанные другим оператором", async () => {
    const campaign = await makeCampaign();
    // Оператор B успел поменять публикацию и тексты, пока у оператора A открыт старый снимок.
    await prisma.leadMagnetCampaign.update({
      where: { id: campaign.id },
      data: { postUrl: "https://instagram.com/p/BBB/", inviteText: "Новый текст от B", keywords: ["гайд"] },
    });

    const res = await request(app)
      .patch(`/api/v1/lead-magnets/${campaign.id}/enabled`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);

    const after = await prisma.leadMagnetCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.enabled).toBe(false);
    expect(after.postUrl).toBe("https://instagram.com/p/BBB/");
    expect(after.inviteText).toBe("Новый текст от B");
    expect(after.keywords).toEqual(["гайд"]);
  });

  it("включение пустой кампании без ключевого слова отклоняется, как и полным PATCH", async () => {
    const campaign = await makeCampaign({ enabled: false, keywords: [], anyComment: false });
    const res = await request(app)
      .patch(`/api/v1/lead-magnets/${campaign.id}/enabled`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(400);
    const after = await prisma.leadMagnetCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.enabled).toBe(false);
  });

  it("«любой комментарий» без публикации тоже не включается", async () => {
    const campaign = await makeCampaign({ enabled: false, keywords: [], anyComment: true, postUrl: null, postUrls: [] });
    const res = await request(app)
      .patch(`/api/v1/lead-magnets/${campaign.id}/enabled`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it("неверное тело и неизвестная кампания", async () => {
    const campaign = await makeCampaign();
    const bad = await request(app)
      .patch(`/api/v1/lead-magnets/${campaign.id}/enabled`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: "да" });
    expect(bad.status).toBe(400);
    const missing = await request(app)
      .patch("/api/v1/lead-magnets/00000000-0000-4000-8000-000000000000/enabled")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(missing.status).toBe(404);
  });
});
