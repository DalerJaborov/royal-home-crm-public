import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * PATCH /api/v1/vacancies/:id — правка стадии и полей анкеты.
 *
 * До этой правки (04.09.2026, полный обход раздела) у роута не было НИ ОДНОГО
 * теста: ни на переход стадий, ни на телефон (только что добавленное поле —
 * единственное, от которого зависит, увидит ли руководство кандидата в очереди
 * вообще), ни на interviewNote (поле проведено через всю цепочку — БД, роут,
 * тип на фронте, — а форму для него добавили только сейчас).
 */

const runId = Date.now();
let adminId = "";
let token = "";
let appId = "";
const conversationId = `vac-patch-${runId}`;

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ правки вакансий ${runId}`,
      phone: `+99297${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  token = signAccessToken({ sub: admin.id, role: "ADMIN" });
});

afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { conversationId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

beforeAll(async () => {
  const created = await prisma.jobApplication.create({
    data: { conversationId, channel: "WHATSAPP", name: `Патч ${runId}`, status: "NEW", phone: "900000010" },
  });
  appId = created.id;
});

function patch(body: Record<string, unknown>) {
  return request(app).patch(`/api/v1/vacancies/${appId}`).set("Authorization", `Bearer ${token}`).send(body);
}

describe("PATCH /vacancies/:id — телефон", () => {
  it("нормализует телефон так же, как запись бота", async () => {
    const res = await patch({ phone: "0900112233" });
    expect(res.status).toBe(200);
    const row = await prisma.jobApplication.findUnique({ where: { id: appId } });
    expect(row?.phone).toBe("+992900112233");
  });

  it("мусор в поле телефона отклоняется понятной ошибкой, а не тихо отбрасывается", async () => {
    /**
     * У модели (parseJobApplication) мусор молча выпадает — это правильно для
     * бота, который просто не понял ответ. Но здесь администратор ЯВНО ввёл
     * значение и жмёт «Сохранить» — молча отбросить его ввод хуже, чем
     * ответить 400: он решит, что телефон сохранился, а на деле нет.
     */
    const before = await prisma.jobApplication.findUnique({ where: { id: appId } });
    const res = await patch({ phone: "оставлю попозже" });
    expect(res.status).toBe(400);
    const after = await prisma.jobApplication.findUnique({ where: { id: appId } });
    expect(after?.phone).toBe(before?.phone);
  });

  it("null очищает телефон — анкета честно уходит из очереди со звонком", async () => {
    const res = await patch({ phone: null });
    expect(res.status).toBe(200);
    const row = await prisma.jobApplication.findUnique({ where: { id: appId } });
    expect(row?.phone).toBeNull();
    // Вернуть на место для следующих тестов файла.
    await patch({ phone: "900000010" });
  });

  it("пустая строка — то же самое, что null, а не отдельное «пустое» значение", async () => {
    const res = await patch({ phone: "   " });
    expect(res.status).toBe(200);
    const row = await prisma.jobApplication.findUnique({ where: { id: appId } });
    expect(row?.phone).toBeNull();
    await patch({ phone: "900000010" });
  });
});

describe("PATCH /vacancies/:id — заметка по собеседованию", () => {
  it("сохраняет и очищает interviewNote — поле, для которого раньше не было формы", async () => {
    const res = await patch({ interviewNote: "Уверенно держится, есть машина" });
    expect(res.status).toBe(200);
    expect((await prisma.jobApplication.findUnique({ where: { id: appId } }))?.interviewNote).toBe(
      "Уверенно держится, есть машина"
    );

    const cleared = await patch({ interviewNote: null });
    expect(cleared.status).toBe(200);
    expect((await prisma.jobApplication.findUnique({ where: { id: appId } }))?.interviewNote).toBeNull();
  });
});

describe("PATCH /vacancies/:id — общие гарантии", () => {
  it("404 на несуществующую анкету", async () => {
    const res = await request(app)
      .patch(`/api/v1/vacancies/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: "900000099" });
    expect(res.status).toBe(404);
  });

  it("пустое тело отклоняется — иначе PATCH без единого поля выглядел бы успешным", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
  });

  it("переход в INTERVIEW без даты отклоняется", async () => {
    const res = await patch({ status: "INTERVIEW" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /vacancies/:id — итоговая пара стадия + дата (02.10.2026)", () => {
  it("очистка даты у анкеты на стадии собеседования отклоняется — INTERVIEW без даты не остаётся", async () => {
    const at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect((await patch({ status: "INTERVIEW", interviewAt: at })).status).toBe(200);
    const res = await patch({ interviewAt: null });
    expect(res.status).toBe(400);
    const row = await prisma.jobApplication.findUniqueOrThrow({ where: { id: appId } });
    expect(row.status).toBe("INTERVIEW");
    expect(row.interviewAt?.toISOString()).toBe(at);
  });

  it("ушли с «Принят» — дата выхода стирается, а повторный «Принят» ставит новую", async () => {
    expect((await patch({ status: "HIRED" })).status).toBe(200);
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: appId } })).hiredAt).not.toBeNull();
    expect((await patch({ status: "REVIEWED" })).status).toBe(200);
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: appId } })).hiredAt).toBeNull();
    expect((await patch({ status: "HIRED" })).status).toBe(200);
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: appId } })).hiredAt).not.toBeNull();
  });

  it("старая анкета INTERVIEW без даты: правка номера или заметки не упирается в правило о дате", async () => {
    // Такие анкеты лежат с тех времён, когда правило проверялось только при смене
    // статуса. Запрос, не трогающий ни статус, ни дату, к правилу отношения не имеет.
    await prisma.jobApplication.update({ where: { id: appId }, data: { status: "INTERVIEW", interviewAt: null } });
    expect((await patch({ phone: "900000011" })).status).toBe(200);
    expect((await patch({ interviewNote: "перезвонить после обеда" })).status).toBe(200);
    // А сам статус без даты по-прежнему не ставится.
    expect((await patch({ status: "INTERVIEW" })).status).toBe(400);
  });
});
