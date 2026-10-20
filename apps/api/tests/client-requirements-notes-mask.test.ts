import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A5 — «Заметки» карточки (requirementsNotes) шли
 * наружу как есть.
 *
 * presentClient закрывает номер в phone, extraPhones, имени, сводке ИИ — а
 * requirementsNotes пропускал. Туда же CRM кладёт дословные цитаты: комментарий
 * из Instagram («продаю 2-комн, звоните 93…»), комментарий с сайта, сводку
 * звонка, требования, которые ИИ вынимает из расшифровок. Агент без «Видеть
 * телефоны клиентов» читал номер целиком в «Заметках».
 *
 * Поле при этом редактируемое: форма шлёт его при каждом сохранении. Значит
 * показанный со скрытым номером текст, вернувшийся обратно, не должен
 * переписать настоящий — тот же приём, что у имени карточки (аудит 23.09, №67).
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const DIGITS = "935551234";
const NOTES = `Продаю 2-комн, звоните ${DIGITS}\nЭтаж не последний`;

const agentIds: string[] = [];
const clientIds: string[] = [];
let clientId: string;
let agentToken: string;
let managerToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент A5 ${runId}`, phone: `+992961${runId}`, role: "AGENT", passwordHash },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Руководитель A5 ${runId}`, phone: `+992962${runId}`, role: "MANAGER", passwordHash },
  });
  agentIds.push(agent.id, manager.id);

  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Продавец A5 ${runId}`,
        phone: `+992963${runId}`,
        source: "INSTAGRAM",
        kind: "SELLER",
        assignedAgentId: agent.id,
        acceptedAt: new Date(),
        requirementsNotes: NOTES,
      },
    })
  ).id;
  clientIds.push(clientId);
  // Двойник с почти той же заметкой — для «похожих по заметкам» у руководителя.
  // Номер ещё и в имени — так CRM заводила незнакомых звонивших до 20.08.2026.
  clientIds.push(
    (
      await prisma.client.create({
        data: {
          fullName: `Входящий +992${DIGITS}`,
          phone: `+992964${runId}`,
          source: "PHONE_CALL",
          kind: "SELLER",
          assignedAgentId: agent.id,
          acceptedAt: new Date(),
          requirementsNotes: NOTES,
        },
      })
    ).id
  );

  agentToken = await login(agent.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("A5: номер в «Заметках» скрыт от того, кому номер не положен", () => {
  it("карточка клиента", async () => {
    const res = await request(app).get(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requirementsNotes).toContain("Этаж не последний");
    expect(res.body.requirementsNotes).not.toContain("5551234");
  });

  it("список клиентов", async () => {
    const res = await request(app)
      .get(`/api/v1/clients`)
      .query({ q: `Продавец A5 ${runId}` })
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const row = (res.body.items as { id: string; requirementsNotes: string | null }[]).find((c) => c.id === clientId);
    expect(row).toBeDefined();
    expect(row!.requirementsNotes).not.toContain("5551234");
  });

  it("«похожие по заметкам» у руководителя без права на номера — ни в заметке, ни в имени", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientId}/similar-notes`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain("5551234");
  });

  it("сохранение формы с показанной заметкой не затирает настоящий номер", async () => {
    const shown = (await request(app).get(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${agentToken}`)).body
      .requirementsNotes as string;
    const res = await request(app)
      .patch(`/api/v1/clients/${clientId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ requirementsNotes: shown, budgetMax: 90000 });
    expect(res.status).toBe(200);
    const row = await prisma.client.findUnique({ where: { id: clientId } });
    expect(row?.requirementsNotes).toBe(NOTES);
  });

  it("дописанная строка сохраняется, скрытая строка возвращается настоящей", async () => {
    const shown = (await request(app).get(`/api/v1/clients/${clientId}`).set("Authorization", `Bearer ${agentToken}`)).body
      .requirementsNotes as string;
    const res = await request(app)
      .patch(`/api/v1/clients/${clientId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ requirementsNotes: `${shown}\nНужен ремонт` });
    expect(res.status).toBe(200);
    const row = await prisma.client.findUnique({ where: { id: clientId } });
    expect(row?.requirementsNotes).toBe(`${NOTES}\nНужен ремонт`);
  });
});
