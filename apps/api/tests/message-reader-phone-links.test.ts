import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { maskPhonesForReader } from "@royal-home/shared";
import { presentMessages } from "../src/lib/messageAttachments.js";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * НОМЕР В ССЫЛКЕ НЕ ОБХОДИТ clients.viewPhone В ПЕРЕПИСКЕ
 * (аудит Codex 04.10.2026, ACCESS-02).
 *
 * Так было: читатель без права на номер получал текст через maskPhones, а та по
 * замыслу (решение владельца для ИСХОДЯЩИХ) целиком пропускает ссылки — клиент
 * присылал https://wa.me/992900001122, и номер уходил читателю открытым в
 * content, translatedRu, превью списка и заметке оценки ответа.
 */

const DIGITS = "900001122";

describe("maskPhonesForReader", () => {
  it("закрывает цифры в телефонных ссылках и оставляет сами ссылки", () => {
    const cases = [
      "https://wa.me/992900001122",
      "wa.me/+992900001122?text=hi",
      "https://api.whatsapp.com/send?phone=992900001122&text=hi",
      "https://api.whatsapp.com/send/?text=hi&phone=992900001122",
      "https://t.me/+992900001122",
      "tel:+992900001122",
      "tel:+992 900 001 122",
    ];
    for (const c of cases) {
      const out = maskPhonesForReader(c);
      expect(out.text, c).not.toContain(DIGITS);
      expect(out.text.replace(/\D/g, ""), c).not.toContain("0001122");
      expect(out.masked).toBe(true);
    }
    expect(maskPhonesForReader("https://wa.me/992900001122").text).toBe("https://wa.me/****");
  });

  it("не ломает ссылки на объекты, канал и приглашения", () => {
    const keep = [
      "https://royal-home.tj/object/123456789",
      "https://t.me/royalhome_channel",
      "https://t.me/+AbC12345678xyz",
      "https://wa.me/message/ABCDEF",
    ];
    for (const k of keep) expect(maskPhonesForReader(k).text).toBe(k);
  });

  it("обычный номер по-прежнему закрывается как у maskPhones", () => {
    expect(maskPhonesForReader("Звоните +992 77 777 6001").text).toBe("Звоните ****");
  });
});

describe("presentMessages без права на номер", () => {
  const raw = [
    { role: "user", content: "вот мой ватсап https://wa.me/992900001122", translatedRu: "мой ватсап tel:+992900001122" },
    {
      role: "assistant",
      content: "ok",
      feedback: { verdict: "bad", note: "клиент оставил +992900001122", by: "a", at: new Date().toISOString() },
    },
  ];

  it("content, перевод и заметка оценки без номера", () => {
    const out = presentMessages(raw, true, false);
    expect(JSON.stringify(out)).not.toContain(DIGITS);
    expect(out[0].content).toContain("вот мой ватсап");
  });

  it("с правом на номер всё как есть", () => {
    const out = presentMessages(raw, true, true);
    expect(out[0].content).toContain(DIGITS);
    expect(out[1].feedback?.note).toContain(DIGITS);
  });
});

describe("превью списка диалогов", () => {
  const runId = Date.now();
  const tail = String(runId).slice(-7);
  const agentIds: string[] = [];
  let clientId = "";
  let convId = "";
  let token = "";

  beforeAll(async () => {
    const agent = await prisma.agent.create({
      data: {
        fullName: `Читатель переписок ${runId}`,
        phone: `+99251${tail}`,
        role: "MANAGER",
        passwordHash: "x",
        permissions: { granted: ["messages.view"], revoked: ["clients.viewPhone"] } as never,
      },
    });
    agentIds.push(agent.id);
    token = signAccessToken({ sub: agent.id, role: "MANAGER" });
    const client = await prisma.client.create({
      data: { fullName: `Клиент превью ${runId}`, phone: `+99252${tail}`, source: "WHATSAPP", assignedAgentId: agent.id, acceptedAt: new Date() },
    });
    clientId = client.id;
    const conv = await prisma.botConversation.create({
      data: {
        clientId,
        channel: "WHATSAPP",
        subscriberId: `wa-prev-${runId}`,
        lastMessageAt: new Date(),
        messages: [{ role: "user", content: "мой номер https://wa.me/992900001122", at: new Date().toISOString() }],
      },
    });
    convId = conv.id;
  });

  afterAll(async () => {
    await prisma.botConversation.deleteMany({ where: { id: convId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    await prisma.$disconnect();
  });

  it("lastMessage.content не несёт номер из ссылки", async () => {
    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = (res.body.items as Array<{ id: string; lastMessage: { content: string } | null }>).find((i) => i.id === convId);
    expect(row).toBeTruthy();
    expect(row!.lastMessage!.content).not.toContain(DIGITS);
    expect(row!.lastMessage!.content).toContain("мой номер");
  });
});
