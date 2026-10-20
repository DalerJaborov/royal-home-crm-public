import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { recordJobApplication } from "../src/lib/jobApplications.js";
import { savePrivateFile, privateFilePath } from "../src/lib/privateFiles.js";
import { dushanbeDayRange } from "../src/lib/dushanbeTime.js";
import { visibleNewCandidatesWhere } from "../src/lib/vacancyVisibility.js";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * Разбор раздела «Вакансии» 02.10.2026 — доступ, резюме, список и счётчики.
 *
 *  S2  «Всё равно позвать» сохраняется и переживает следующую запись бота.
 *  S8  список честно говорит, сколько всего под фильтром (total).
 *  L7  «Сегодня» собирается отдельным запросом, а не из загруженной страницы.
 *  L8  сайдбар и список считают «новых кандидатов» одним правилом.
 *  A6  руководитель открывает резюме своим путём, без права на вложения переписки.
 *  A7  переписка «не кандидата» закрыта, а переписка клиента маскирует номера.
 *  A8  журнал называет, что именно поменяли.
 *  A10c голосовая заметка к отказу — только адрес нашей записи.
 *  +   TELEGRAM_DIRECT читается из своей таблицы; причина «робот не звонил» видна.
 */

const runId = String(Date.now()).slice(-8);
const conv = (tag: string) => `vac-acc-${runId}-${tag}`;
const MARK = `Акс${runId}`;
let managerId = "";
let managerToken = "";
let buyerClientId = "";
let directConvId = "";
const cvFiles: string[] = [];

async function cleanup(): Promise<void> {
  await prisma.jobApplication.deleteMany({ where: { OR: [{ conversationId: { startsWith: `vac-acc-${runId}` } }, { name: { startsWith: MARK } }] } });
  await prisma.botConversation.deleteMany({ where: { id: { startsWith: `vac-acc-${runId}` } } });
  if (directConvId) await prisma.telegramDirectConversation.deleteMany({ where: { id: directConvId } });
  if (buyerClientId) await prisma.client.deleteMany({ where: { id: buyerClientId } });
}

beforeAll(async () => {
  await cleanup();
  const manager = await prisma.agent.create({
    data: { fullName: `HR доступа ${runId}`, phone: `+99297${runId.slice(-7)}`, role: "MANAGER", passwordHash: "x" },
  });
  managerId = manager.id;
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
});

afterAll(async () => {
  await cleanup();
  for (const f of cvFiles) {
    const p = privateFilePath(f);
    if (p) fs.rmSync(p, { force: true });
  }
  await prisma.auditLog.deleteMany({ where: { agentId: managerId } });
  await prisma.agent.deleteMany({ where: { id: managerId } });
});

const get = (url: string) => request(app).get(`/api/v1${url}`).set("Authorization", `Bearer ${managerToken}`);
const patch = (id: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/v1/vacancies/${id}`).set("Authorization", `Bearer ${managerToken}`).send(body);

describe("S2: «Всё равно позвать»", () => {
  let id = "";

  it("переводит отсеянного в «Подходят», и следующая запись бота это не отменяет", async () => {
    await prisma.botConversation.create({ data: { id: conv("ovr"), channel: "WHATSAPP", subscriberId: `99290${runId}` } });
    await recordJobApplication({
      conversationId: conv("ovr"),
      channel: "WHATSAPP",
      draft: { name: `${MARK} Отсеянный`, age: 20, phone: "+992900111222" },
    });
    const row = await prisma.jobApplication.findUnique({ where: { conversationId: conv("ovr") } });
    expect(row?.eligible).toBe(false);
    id = row!.id;

    const res = await patch(id, { status: "REVIEWED", eligibleOverride: true });
    expect(res.status).toBe(200);

    // Бот пишет дальше — eligible пересчитывается заново и остаётся false.
    await recordJobApplication({ conversationId: conv("ovr"), channel: "WHATSAPP", draft: { age: 20, city: "Душанбе" } });
    const after = await prisma.jobApplication.findUnique({ where: { id } });
    expect(after?.eligible).toBe(false);
    expect(after?.eligibleOverride).toBe(true);

    const fit = await get(`/vacancies?bucket=fit&q=${encodeURIComponent(MARK + " Отсеянный")}`);
    expect(fit.status).toBe(200);
    expect(fit.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(fit.body.bucketCounts).toMatchObject({ fit: 1, rejected: 0 });

    const rejected = await get(`/vacancies?bucket=rejected&q=${encodeURIComponent(MARK + " Отсеянный")}`);
    expect(rejected.body.items).toHaveLength(0);
  });

  it("снять решение можно — анкета возвращается в «Не подходят»", async () => {
    expect((await patch(id, { eligibleOverride: false })).status).toBe(200);
    expect((await prisma.jobApplication.findUnique({ where: { id } }))?.eligibleOverride).toBeNull();
    const rejected = await get(`/vacancies?bucket=rejected&q=${encodeURIComponent(MARK + " Отсеянный")}`);
    expect(rejected.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
  });
});

describe("S8/L7: сколько всего и «Сегодня»", () => {
  it("total считает всё под фильтром, а items — только первые limit", async () => {
    await prisma.jobApplication.createMany({
      data: [1, 2, 3].map((n) => ({
        conversationId: conv(`pg${n}`),
        channel: "WHATSAPP",
        name: `${MARK} Страница ${n}`,
        phone: `+99290055${runId.slice(-3)}${n}`,
        eligible: true,
      })),
    });
    const res = await get(`/vacancies?bucket=fit&limit=2&q=${encodeURIComponent(MARK + " Страница")}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
  });

  it("собеседование сегодня у старой анкеты попадает в «Сегодня», даже если её нет на странице", async () => {
    const { start, end } = dushanbeDayRange(new Date());
    const midday = new Date((start.getTime() + end.getTime()) / 2);
    const old = await prisma.jobApplication.create({
      data: {
        conversationId: conv("today"),
        channel: "WHATSAPP",
        name: `${MARK} Сегодня`,
        phone: "+992900333444",
        eligible: true,
        status: "INTERVIEW",
        interviewAt: midday,
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    });
    const tomorrow = await prisma.jobApplication.create({
      data: {
        conversationId: conv("tomorrow"),
        channel: "WHATSAPP",
        name: `${MARK} Завтра`,
        phone: "+992900333445",
        eligible: true,
        status: "INTERVIEW",
        interviewAt: new Date(end.getTime() + 60 * 60 * 1000),
      },
    });
    // limit=1 и поиск по другой анкете: страница старую анкету точно не содержит.
    const res = await get(`/vacancies?bucket=fit&limit=1&q=${encodeURIComponent(MARK + " Страница")}`);
    expect(res.status).toBe(200);
    const todayIds = (res.body.todayInterviews as { id: string; inviteCall: unknown }[]).map((i) => i.id);
    expect(todayIds).toContain(old.id);
    expect(todayIds).not.toContain(tomorrow.id);
    expect(res.body.items.map((i: { id: string }) => i.id)).not.toContain(old.id);
  });
});

describe("L8: «новые кандидаты» — одно правило для счётчиков и вкладки", () => {
  it("сайдбар считает только то, что видно во вкладке «Подходят» → «Новая»", async () => {
    const counter = async () => (await get("/dashboard/counters")).body.vacancies as number;
    const before = await waitForSettled(counter);
    const base = { channel: "WHATSAPP", status: "NEW" };
    await prisma.jobApplication.createMany({
      data: [
        { ...base, conversationId: conv("c-fit"), name: `${MARK} c1`, phone: "+992900000101", eligible: true },
        { ...base, conversationId: conv("c-ovr"), name: `${MARK} c2`, phone: "+992900000102", eligible: false, eligibleOverride: true },
        // Не видны во вкладке по умолчанию — значит и в цифре их быть не должно.
        { ...base, conversationId: conv("c-null"), name: `${MARK} c3`, phone: "+992900000103", eligible: null },
        { ...base, conversationId: conv("c-rej"), name: `${MARK} c4`, phone: "+992900000104", eligible: false },
        { ...base, conversationId: conv("c-nop"), name: `${MARK} c5`, phone: null, eligible: true },
      ],
    });
    expect(await counter()).toBe(before + 2);

    const mine = { conversationId: { startsWith: conv("c-") } };
    expect(await prisma.jobApplication.count({ where: { AND: [mine, visibleNewCandidatesWhere()] } })).toBe(2);
    const list = await get(`/vacancies?bucket=fit&status=NEW&q=${encodeURIComponent(MARK + " c")}`);
    expect(list.body.total).toBe(2);
  });
});

describe("A6: резюме открывается по праву раздела", () => {
  it("руководитель без права на вложения переписки получает файл резюме", async () => {
    const name = await savePrivateFile(Buffer.from("%PDF-1.4 resume"), "application/pdf");
    expect(name).toBeTruthy();
    cvFiles.push(name!);
    const row = await prisma.jobApplication.create({
      data: { conversationId: conv("cv"), channel: "WHATSAPP", name: `${MARK} Резюме`, cvFile: name },
    });
    // Общий путь вложений ему закрыт — это и была поломка.
    expect((await get(`/attachments/${name}`)).status).toBe(403);

    const res = await get(`/vacancies/${row.id}/cv`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(Buffer.from(res.body).toString()).toContain("resume");
  });

  it("путь в cvFile, указывающий за пределы хранилища, не отдаётся", async () => {
    const row = await prisma.jobApplication.create({
      data: { conversationId: conv("cv-bad"), channel: "WHATSAPP", name: `${MARK} Обход`, cvFile: "../../package.json" },
    });
    expect((await get(`/vacancies/${row.id}/cv`)).status).toBe(404);
  });

  it("анкета без резюме — 404", async () => {
    const row = await prisma.jobApplication.create({
      data: { conversationId: conv("cv-none"), channel: "WHATSAPP", name: `${MARK} Без` },
    });
    expect((await get(`/vacancies/${row.id}/cv`)).status).toBe(404);
  });
});

describe("A7: чья это переписка", () => {
  it("NOT_CANDIDATE — переписку и резюме не отдаёт", async () => {
    await prisma.botConversation.create({
      data: { id: conv("nc"), channel: "WHATSAPP", subscriberId: `99291${runId}`, messages: [{ role: "user", content: "Продаю квартиру, 90 555 12 34" }] },
    });
    const row = await prisma.jobApplication.create({
      data: { conversationId: conv("nc"), channel: "WHATSAPP", name: `${MARK} Продавец`, status: "NOT_CANDIDATE", cvFile: cvFiles[0] },
    });
    expect((await get(`/vacancies/${row.id}/conversation`)).status).toBe(404);
    expect((await get(`/vacancies/${row.id}/cv`)).status).toBe(404);
  });

  it("диалог, привязанный к карточке покупателя, маскирует номера без права clients.viewPhone", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Покупатель ${runId}`, phone: `+99293${runId.slice(-7)}`, source: "WHATSAPP", kind: "BUYER", currency: "TJS" },
    });
    buyerClientId = client.id;
    await prisma.botConversation.create({
      data: {
        id: conv("buyer"),
        channel: "WHATSAPP",
        subscriberId: `99292${runId}`,
        clientId: client.id,
        messages: [{ role: "user", content: "Ищу квартиру, и работа у вас есть? Звоните 90 777 12 34" }],
      },
    });
    const row = await prisma.jobApplication.create({
      data: { conversationId: conv("buyer"), channel: "WHATSAPP", name: `${MARK} Покупатель` },
    });
    const res = await get(`/vacancies/${row.id}/conversation`);
    expect(res.status).toBe(200);
    const text = res.body.messages[0].content as string;
    expect(text).not.toContain("90 777 12 34");
  });

  it("TELEGRAM_DIRECT читается из своей таблицы, а ссылки в инбокс нет", async () => {
    const direct = await prisma.telegramDirectConversation.create({
      data: {
        chatId: `tgd-chat-${runId}`,
        topicId: `tgd-topic-${runId}`,
        messages: [{ role: "user", content: "Салом, ищу работу, мне 26" }],
      },
    });
    directConvId = direct.id;
    const row = await prisma.jobApplication.create({
      data: { conversationId: direct.id, channel: "TELEGRAM_DIRECT", name: `${MARK} Директ`, phone: "+992900444555", eligible: true },
    });
    const res = await get(`/vacancies/${row.id}/conversation`);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(["Салом, ищу работу, мне 26"]);
    expect(res.body.inboxId).toBeNull();

    const list = await get(`/vacancies?bucket=fit&q=${encodeURIComponent(MARK + " Директ")}`);
    expect(list.body.items[0].inboxId).toBeNull();
  });
});

describe("Причина «робот не звонил» в списке", () => {
  it("строка звонка называет точную причину пропуска", async () => {
    const row = await prisma.jobApplication.create({
      data: {
        conversationId: conv("skip"),
        channel: "WHATSAPP",
        name: `${MARK} Пропуск`,
        phone: "+992900555666",
        eligible: true,
        status: "INTERVIEW",
        interviewAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.interviewInviteCall.create({
      data: {
        jobApplicationId: row.id,
        interviewAt: row.interviewAt!,
        scheduledFor: new Date(),
        status: "SKIPPED",
        skipReason: "not_dialable",
      },
    });
    const res = await get(`/vacancies?bucket=fit&q=${encodeURIComponent(MARK + " Пропуск")}`);
    expect(res.body.items[0].inviteCall.text).toBe(
      "Робот не звонил: номер не похож на таджикский — свяжитесь с кандидатом сами"
    );
  });
});

describe("A8: журнал называет, что поменяли", () => {
  let id = "";
  beforeAll(async () => {
    id = (
      await prisma.jobApplication.create({
        data: { conversationId: conv("audit"), channel: "WHATSAPP", name: `${MARK} Журнал`, phone: "+992900666777", status: "REVIEWED" },
      })
    ).id;
  });
  const entries = () =>
    prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" }, select: { action: true, meta: true } });

  it("правка телефона без смены этапа — VACANCY_UPDATE с полем, не «смена этапа»", async () => {
    expect((await patch(id, { phone: "+992900666778" })).status).toBe(200);
    const rows = await waitFor(async () => {
      const r = await entries();
      return r.length > 0 ? r : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("VACANCY_UPDATE");
    expect(rows[0].meta).toMatchObject({ fields: ["phone"], phoneChanged: true });
    expect(JSON.stringify(rows[0].meta)).not.toContain("666778");
  });

  it("смена этапа с датой — VACANCY_STATUS с from/to и временем", async () => {
    const at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect((await patch(id, { status: "INTERVIEW", interviewAt: at })).status).toBe(200);
    const rows = await waitFor(async () => {
      const r = await entries();
      return r.length > 1 ? r : null;
    });
    expect(rows[1].action).toBe("VACANCY_STATUS");
    expect(rows[1].meta).toMatchObject({ from: "REVIEWED", to: "INTERVIEW", fields: ["interviewAt"], interviewAt: { from: null, to: at } });
  });

  it("повторное сохранение того же самого журнал не засоряет", async () => {
    const before = await waitForSettled(async () => (await entries()).length);
    expect((await patch(id, { status: "INTERVIEW" })).status).toBe(200);
    expect(await waitForSettled(async () => (await entries()).length)).toBe(before);
  });
});

describe("A10c: голосовая заметка к отказу — только наш адрес", () => {
  let id = "";
  beforeAll(async () => {
    id = (await prisma.jobApplication.create({ data: { conversationId: conv("voice"), channel: "WHATSAPP", name: `${MARK} Голос` } })).id;
  });

  it("произвольный путь API отклоняется", async () => {
    for (const bad of ["/clients/export", "https://evil.example/x.webm", "/me/voice-notes/../../clients", "/me/voice-notes/abc.webm"]) {
      const res = await patch(id, { rejectionReasonVoiceUrl: bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it("адрес, выданный записью голосовой заметки, принимается; null очищает", async () => {
    const url = `/me/voice-notes/${"0123abcd-0123-4567-89ab-0123456789ab"}.webm`;
    expect((await patch(id, { rejectionReasonVoiceUrl: url })).status).toBe(200);
    expect((await prisma.jobApplication.findUnique({ where: { id } }))?.rejectionReasonVoiceUrl).toBe(url);
    expect((await patch(id, { rejectionReasonVoiceUrl: null })).status).toBe(200);
  });
});

