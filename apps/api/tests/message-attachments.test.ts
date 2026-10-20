import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { savePrivateFile, privateFilePath } from "../src/lib/privateFiles.js";

/**
 * Вложения переписки: кто может их открыть.
 *
 * Требование владельца: фото и голосовые клиентов видят админ, директор и агент
 * (17.08.2026 — агенту право добавили: он должен слышать, что клиент прислал ЕМУ
 * САМОМУ, а не только читать пометку «доступно руководству»). РУКОВОДИТЕЛЮ
 * (MANAGER) право по-прежнему не входит в пресет — выдаётся отдельной галочкой.
 * Права проверяются на СЕРВЕРЕ — спрятать картинку в интерфейсе недостаточно,
 * запрос к /attachments/:name уходит руками.
 *
 * Проверяем три вещи, каждая из которых ломается по-своему:
 *   1. Сам файл выдаётся только по праву messages.viewAttachments.
 *   2. Имя файла не приезжает тому, у кого права нет, — ни в инбоксе, ни в карточке.
 *   3. Имя из URL не уводит чтение за пределы закрытой папки (обход пути).
 */

const runId = Date.now();
const password = "testpass123";

/** Уникальные телефоны: база общая с другими прогонами, phone у Agent уникален. */
const directorPhone = `+99291${String(runId).slice(-7)}`;
const managerPhone = `+99292${String(runId).slice(-7)}`;
const agentPhone = `+99293${String(runId).slice(-7)}`;
const otherAgentPhone = `+99295${String(runId).slice(-7)}`;

let directorToken: string;
let managerToken: string;
let agentToken: string;
let agentId: string;
/** Второй АГЕНТ (К7, 11.09.2026): свой клиент за ним не закреплён — проверяет
 *  владение вложением, а не только само право messages.viewAttachments. */
let otherAgentToken: string;

const createdAgentIds: string[] = [];
const createdConversationIds: string[] = [];
const createdClientIds: string[] = [];
/** Имена сохранённых файлов — убираем за собой, хранилище общее. */
const createdFiles: string[] = [];

/** Имя файла, который «прислал клиент». Кладём настоящий файл в закрытое хранилище. */
let photoFile: string;
let voiceFile: string;
/** Диалог с вложениями — открывается в инбоксе. */
let conversationId: string;
/** Клиент с тем же диалогом — открывается в карточке (единственное окно агента). */
let clientShortId: number;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

async function createAgent(fullName: string, phone: string, role: "DIRECTOR" | "MANAGER" | "AGENT") {
  const agent = await prisma.agent.create({
    data: { fullName, phone, passwordHash: await bcrypt.hash(password, 10), role, isActive: true },
  });
  createdAgentIds.push(agent.id);
  return agent;
}

beforeAll(async () => {
  await createAgent(`Директор Вложений ${runId}`, directorPhone, "DIRECTOR");
  await createAgent(`Руководитель Вложений ${runId}`, managerPhone, "MANAGER");
  const agent = await createAgent(`Агент Вложений ${runId}`, agentPhone, "AGENT");
  agentId = agent.id;
  await createAgent(`Другой агент Вложений ${runId}`, otherAgentPhone, "AGENT");

  [directorToken, managerToken, agentToken, otherAgentToken] = await Promise.all([
    login(directorPhone),
    login(managerPhone),
    login(agentPhone),
    login(otherAgentPhone),
  ]);

  const savedPhoto = await savePrivateFile(Buffer.from(`photo-bytes-${runId}`), "image/jpeg");
  const savedVoice = await savePrivateFile(Buffer.from(`voice-bytes-${runId}`), "audio/ogg");
  expect(savedPhoto).toBeTruthy();
  expect(savedVoice).toBeTruthy();
  photoFile = savedPhoto!;
  voiceFile = savedVoice!;
  createdFiles.push(photoFile, voiceFile);

  // Клиент нужен, чтобы проверить карточку: агенту инбокс закрыт правом messages.view,
  // и переписку своего клиента он видит только там.
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент Вложений ${runId}`,
      phone: `+99294${String(runId).slice(-7)}`,
      source: "WHATSAPP",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  createdClientIds.push(client.id);
  clientShortId = client.shortId;

  const conversation = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-att-${runId}`,
      name: `Диалог с вложениями ${runId}`,
      clientId: client.id,
      messages: [
        // Старая реплика без вложений — обязана отдаваться ровно как раньше.
        { role: "user", content: "здравствуйте" },
        { role: "assistant", content: "добрый день!" },
        {
          role: "user",
          content: "[📷]",
          attachments: [
            { kind: "image", file: photoFile, mime: "image/jpeg" },
            { kind: "audio", file: voiceFile, mime: "audio/ogg" },
          ],
        },
      ],
      lastMessageAt: new Date(),
    },
  });
  createdConversationIds.push(conversation.id);
  conversationId = conversation.id;
});

afterAll(async () => {
  // Убираем за собой: база и хранилище общие с другими прогонами.
  await prisma.botConversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
  for (const name of createdFiles) {
    const full = privateFilePath(name);
    if (full) fs.rmSync(full, { force: true });
  }
});

describe("Выдача файла GET /attachments/:name", () => {
  it("директор получает файл с правильным типом и без общего кэширования", async () => {
    const res = await request(app)
      .get(`/api/v1/attachments/${photoFile}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(res.body.toString()).toBe(`photo-bytes-${runId}`);
    // Файл персональный и выдан под право: общий кэш (Cloudflare перед CRM) не
    // должен уметь отдать его тому, кому мы ответили 403.
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("голосовое отдаётся как аудио — иначе браузер не покажет плеер", async () => {
    const res = await request(app)
      .get(`/api/v1/attachments/${voiceFile}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/ogg");
  });

  it("АГЕНТ файл получает — право есть в пресете роли по умолчанию (17.08.2026)", async () => {
    const res = await request(app)
      .get(`/api/v1/attachments/${photoFile}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(res.body.toString()).toBe(`photo-bytes-${runId}`);
  });

  it("руководителю (MANAGER) вложения тоже закрыты: право не входит в его пресет", async () => {
    const res = await request(app)
      .get(`/api/v1/attachments/${photoFile}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(res.status).toBe(403);
  });

  it("без авторизации — 401", async () => {
    const res = await request(app).get(`/api/v1/attachments/${photoFile}`);
    expect(res.status).toBe(401);
  });

  it("имя файла не уводит чтение за пределы закрытой папки", async () => {
    // Классический обход пути: %2F не считается разделителем при маршрутизации,
    // а в req.params.name приезжает уже раскодированным.
    for (const evil of ["..%2F..%2Fpackage.json", "..%2F..%2F.env", "not-a-uuid.jpg", "%2Fetc%2Fpasswd"]) {
      const res = await request(app)
        .get(`/api/v1/attachments/${evil}`)
        .set("Authorization", `Bearer ${directorToken}`);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("несуществующий файл с правильным по форме именем — 404", async () => {
    const res = await request(app)
      .get("/api/v1/attachments/00000000-0000-4000-8000-000000000000.jpg")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(404);
  });

  it("К7: другой АГЕНТ (право есть, но клиент чужой) получает 403, а не файл", async () => {
    const res = await request(app)
      .get(`/api/v1/attachments/${photoFile}`)
      .set("Authorization", `Bearer ${otherAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("К7: clients.viewAll (директор) видит вложение даже без своего клиента", async () => {
    // Директор из этого файла и так видит всех — но важно, что путь работает не
    // «потому что владелец совпал», а потому что право снимает саму проверку.
    const res = await request(app)
      .get(`/api/v1/attachments/${voiceFile}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
  });
});

describe("Вложения в переписке", () => {
  it("директор видит имена файлов в инбоксе", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    const withFiles = res.body.messages[2];
    expect(withFiles.attachments).toHaveLength(2);
    expect(withFiles.attachments[0]).toEqual({ kind: "image", mime: "image/jpeg", file: photoFile });
    expect(withFiles.attachments[1]).toEqual({ kind: "audio", mime: "audio/ogg", file: voiceFile });
  });

  it("руководителю имя файла не приезжает вовсе — только пометка о вложении", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    const withFiles = res.body.messages[2];
    // Вид вложения остаётся — интерфейсу надо знать, что писать: «Фото» или «Голосовое».
    expect(withFiles.attachments).toHaveLength(2);
    expect(withFiles.attachments[0].kind).toBe("image");
    expect(withFiles.attachments[0].file).toBeNull();
    expect(withFiles.attachments[1].file).toBeNull();
    // И текст переписки при этом виден полностью — право закрывает только файлы.
    expect(res.body.messages[0].content).toBe("здравствуйте");
  });

  it("старые реплики без вложений отдаются как раньше", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(3);
    expect(res.body.messages[0]).toEqual({ role: "user", content: "здравствуйте" });
    expect(res.body.messages[1]).toEqual({ role: "assistant", content: "добрый день!" });
    // Поля attachments у них нет вовсе — ничего лишнего в ответе не появилось.
    expect("attachments" in res.body.messages[0]).toBe(false);
  });

  it("АГЕНТ в карточке своего клиента видит и имена файлов", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    const messages = res.body.botConversation[0].messages;
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("здравствуйте");
    expect(messages[2].attachments[0].file).toBe(photoFile);
    expect(messages[2].attachments[1].file).toBe(voiceFile);
  });

  it("директор в карточке клиента имена файлов видит", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.botConversation[0].messages[2].attachments[0].file).toBe(photoFile);
  });
});

/**
 * НАЙДЕНО ВЛАДЕЛЬЦЕМ 12.08.2026: телефон клиента виден в переписке даже тому, у
 * кого нет права `clients.viewPhone`.
 *
 * Право закрывает структурное поле `Client.phone` (маска `+992•••••18`), но
 * клиенты постоянно диктуют номер прямо в чате — «мой номер 930001001». Такая
 * реплика уходила сотруднику текстом целиком, и право обходилось первой же
 * подобной фразой. РУКОВОДИТЕЛЬ (MANAGER) — тот самый пример: по пресету ролей у
 * него нет `clients.viewPhone` (выдаётся отдельной галочкой в Настройках), но
 * есть messages.view и доступ к карточкам подчинённых.
 */
describe("Телефон клиента в тексте переписки — по праву clients.viewPhone", () => {
  const phoneMsgId = 3; // четвёртая реплика: клиент диктует номер

  beforeAll(async () => {
    await prisma.botConversation.update({
      where: { id: conversationId },
      data: {
        messages: [
          { role: "user", content: "здравствуйте" },
          { role: "assistant", content: "добрый день!" },
          {
            role: "user",
            content: "[📷]",
            attachments: [
              { kind: "image", file: photoFile, mime: "image/jpeg" },
              { kind: "audio", file: voiceFile, mime: "audio/ogg" },
            ],
          },
          { role: "user", content: "Ассалом! Мой номер 930001001, позвоните мне туда" },
        ],
      },
    });
  });

  it("руководителю без права номер в тексте закрыт маской", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages[phoneMsgId].content).not.toContain("930001001");
    expect(res.body.messages[phoneMsgId].content).toContain("****");
    // Остальной текст реплики остаётся читаемым — маска бьёт только по цифрам.
    expect(res.body.messages[phoneMsgId].content).toContain("Ассалом");
  });

  it("директору с правом номер виден как есть — в инбоксе", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages[phoneMsgId].content).toContain("930001001");
  });

  it("тот же клиент в своей карточке: агенту без права номер закрыт", async () => {
    // Агент из этого файла — обычный AGENT, у которого clients.viewPhone нет по
    // пресету ролей (выдаётся отдельно), а сам клиент за ним закреплён.
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.botConversation[0].messages[phoneMsgId].content).not.toContain("930001001");
  });

  it("директору в той же карточке номер виден", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientShortId}`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.botConversation[0].messages[phoneMsgId].content).toContain("930001001");
  });
});
