import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * ПУСТОЙ РАЗДЕЛ «ВАКАНСИИ» ОБЯЗАН ОБЪЯСНЯТЬ СЕБЯ (жалоба владельца 03.09.2026:
 * «вакансии так и не приходят в CRM, хотя люди отправляют данные»).
 *
 * Что было. Анкеты писались в базу, но кандидатов, не прошедших обязательный
 * отбор (работает сейчас / учится / моложе 24), список прячет по умолчанию.
 * Признак `includeFiltered` жил только на бэке — фронт его не отправлял НИ РАЗУ,
 * то есть отсеянных нельзя было увидеть вообще ничем, кроме запроса к базе
 * руками. Раздел показывал «Пока никто не спрашивал про работу» — и раздел с
 * живыми анкетами читался как сломанный бот.
 *
 * Здесь проверяется контракт, на который опирается экран: сколько анкет спрятано
 * (`filteredCount`) и собирает ли их бот вообще (`collecting`, рубильник
 * Настройки → Бот → «Вакансии»). Без этих двух чисел пустой экран не может
 * назвать свою причину и снова начнёт врать.
 */

const runId = Date.now();
let adminId = "";
let token = "";
const conversationIds = [
  `vac-test-eligible-${runId}`,
  `vac-test-filtered-${runId}`,
  `vac-test-undecided-${runId}`,
  `vac-test-nophone-${runId}`,
];

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ вакансий ${runId}`,
      phone: `+99298${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  token = signAccessToken({ sub: admin.id, role: "ADMIN" });

  await prisma.jobApplication.createMany({
    data: [
      {
        conversationId: conversationIds[0],
        channel: "WHATSAPP",
        name: `Подходящий ${runId}`,
        status: "NEW",
        phone: "900000001",
        eligible: true,
      },
      {
        // Тот самый случай: человек написал по-настоящему, но сейчас работает —
        // обязательный отбор его закрывает, и до правки он исчезал бесследно.
        conversationId: conversationIds[1],
        channel: "WHATSAPP",
        name: `Отсеянный ${runId}`,
        status: "NEW",
        phone: "900000002",
        employedNow: true,
        eligible: false,
      },
      {
        /**
         * ДОПУСК ЕЩЁ НЕ РЕШЁН — самый частый случай на проде (03.09.2026: 12 анкет
         * из 14). Бот не успел спросить про возраст или занятость, и eligible
         * остаётся NULL. Такие обязаны быть видны: разговор оборвался на середине,
         * а не кандидат не подошёл. Условие `NOT (eligible = false)` их молча
         * выбрасывало — для NULL это выражение в SQL истиной не является.
         */
        conversationId: conversationIds[2],
        channel: "INSTAGRAM",
        name: `Невыясненный ${runId}`,
        status: "NEW",
        phone: "900000003",
        eligible: null,
      },
      {
        /**
         * БЕЗ ТЕЛЕФОНА — В ОЧЕРЕДЬ НЕ ИДЁТ (решение владельца 03.09.2026: «у кого
         * нет телефона, не надо кидать в CRM — без телефона мы не знаем, как с
         * ними связываться»). Но и не удаляется: ответить человеку можно в той
         * же переписке, и кнопка «Без телефона» его показывает.
         */
        conversationId: conversationIds[3],
        channel: "INSTAGRAM",
        name: `Безтелефона ${runId}`,
        status: "NEW",
        phone: null,
        eligible: null,
      },
    ],
  });
});

afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.jobApplication.deleteMany({ where: { id: withChatId } });
  await prisma.botConversation.deleteMany({ where: { id: chatConversationId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

/** Анкета с настоящей перепиской: на ней проверяются ссылка в инбокс и файлы. */
let withChatId = "";
const chatConversationId = `vac-test-chat-${runId}`;

beforeAll(async () => {
  await prisma.botConversation.create({
    data: {
      id: chatConversationId,
      channel: "WHATSAPP",
      subscriberId: `vac-sub-${runId}`,
      name: "Кандидат с резюме",
      lastMessageAt: new Date(),
      messages: [
        { role: "user", content: "Салом, хочу работать риелтором" },
        { role: "assistant", content: "Здравствуйте! Расскажите о себе." },
        {
          role: "user",
          content: "Отправляю резюме",
          // Резюме документом — то, чего анкета не содержит никогда: модель
          // кладёт в поля только слова (владелец 03.09.2026).
          attachments: [{ kind: "file", file: "resume-abc.pdf", mime: "application/pdf" }],
        },
      ],
    },
  });
  const created = await prisma.jobApplication.create({
    data: {
      conversationId: chatConversationId,
      channel: "WHATSAPP",
      name: `С резюме ${runId}`,
      status: "NEW",
      phone: "900000004",
    },
  });
  withChatId = created.id;
});

function list(query = "") {
  return request(app).get(`/api/v1/vacancies${query}`).set("Authorization", `Bearer ${token}`);
}

const names = (body: { items: { name: string | null }[] }) => body.items.map((i) => i.name);

describe("Вакансии: список объясняет, почему он пуст", () => {
  it("по умолчанию отсеянных не показывает, но честно считает их", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(names(res.body)).toContain(`Подходящий ${runId}`);
    expect(names(res.body)).not.toContain(`Отсеянный ${runId}`);
    // Главное число: без него экран не отличает «никто не писал» от «всех отсеяли».
    expect(res.body.filteredCount).toBeGreaterThanOrEqual(1);
  });

  it("анкету с нерешённым допуском (eligible = null) показывает по умолчанию", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(names(res.body)).toContain(`Невыясненный ${runId}`);
  });

  it("includeFiltered=true отдаёт отсеянных — они не удалены, а спрятаны", async () => {
    const res = await list("?includeFiltered=true");
    expect(res.status).toBe(200);
    expect(names(res.body)).toContain(`Отсеянный ${runId}`);
    expect(names(res.body)).toContain(`Подходящий ${runId}`);
  });

  it("счётчик скрытых учитывает выбранный статус, а не всю таблицу", async () => {
    const res = await list("?status=HIRED");
    expect(res.status).toBe(200);
    // Наших отсеянных в статусе HIRED нет — значит и прятать в этой вкладке нечего.
    expect(res.body.items.every((i: { name: string | null }) => i.name !== `Отсеянный ${runId}`)).toBe(true);
    expect(typeof res.body.filteredCount).toBe("number");
  });

  it("сообщает, собирает ли бот анкеты — выключенный рубильник виден экрану", async () => {
    const before = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botCanHandleVacancies: true },
    });
    try {
      await prisma.settings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", botCanHandleVacancies: false },
        update: { botCanHandleVacancies: false },
      });
      expect((await list()).body.collecting).toBe(false);

      await prisma.settings.update({
        where: { id: "singleton" },
        data: { botCanHandleVacancies: true },
      });
      expect((await list()).body.collecting).toBe(true);
    } finally {
      // Настройки — одна строка на всю базу: возвращаем как было (tests/setup.ts).
      if (before) {
        await prisma.settings.update({
          where: { id: "singleton" },
          data: { botCanHandleVacancies: before.botCanHandleVacancies },
        });
      }
    }
  });

  it("отдаёт ссылку на переписку в инбоксе вместе со списком", async () => {
    const res = await list();
    const item = res.body.items.find((i: { id: string }) => i.id === withChatId);
    // Без inboxId кнопка «Открыть переписку» вести некуда — а именно её
    // отсутствие владелец назвал главной бедой раздела (03.09.2026).
    expect(item.inboxId).toBe(chatConversationId);
  });

  it("отдаёт переписку и файлы, присланные кандидатом", async () => {
    const res = await request(app)
      .get(`/api/v1/vacancies/${withChatId}/conversation`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.inboxId).toBe(chatConversationId);
    expect(res.body.messages.length).toBe(3);
    // Ровно одно вложение — и именно кандидатское.
    expect(res.body.files.length).toBe(1);
    expect(res.body.files[0].kind).toBe("file");
  });

  it("анкета без переписки отвечает пустотой, а не отказом", async () => {
    const res = await request(app)
      .get(`/api/v1/vacancies/${conversationIds[0]}/conversation`)
      .set("Authorization", `Bearer ${token}`);
    // Идентификатор диалога — не идентификатор анкеты: несуществующая анкета
    // обязана давать понятный 404, а не пустой список.
    expect(res.status).toBe(404);
  });

  it("анкету без телефона в очередь не пускает, но считает и отдаёт по признаку", async () => {
    const plain = await list();
    expect(names(plain.body)).not.toContain(`Безтелефона ${runId}`);
    expect(plain.body.noPhoneCount).toBeGreaterThanOrEqual(1);

    const withNoPhone = await list("?includeNoPhone=true");
    expect(names(withNoPhone.body)).toContain(`Безтелефона ${runId}`);
  });

  it("пустая строка в телефоне считается отсутствием номера", async () => {
    const id = `vac-test-emptyphone-${runId}`;
    await prisma.jobApplication.create({
      data: { conversationId: id, channel: "INSTAGRAM", name: `Пустой ${runId}`, status: "NEW", phone: "" },
    });
    try {
      expect(names((await list()).body)).not.toContain(`Пустой ${runId}`);
      expect(names((await list("?includeNoPhone=true")).body)).toContain(`Пустой ${runId}`);
    } finally {
      await prisma.jobApplication.deleteMany({ where: { conversationId: id } });
    }
  });

  it("считает анкеты по стадиям — сводка не зависит от выбранной стадии", async () => {
    const res = await list("?status=HIRED");
    expect(res.status).toBe(200);
    // Выбран HIRED, но в сводке обязаны остаться все стадии: иначе, нажав одну
    // плитку, человек теряет из виду, куда идти дальше.
    expect(res.body.counts.NEW).toBeGreaterThanOrEqual(3);
    expect(typeof res.body.counts.REJECTED).toBe("number");
  });

  it("ищет по имени, телефону и опыту — на сервере, а не по загруженному куску", async () => {
    expect(names((await list(`?q=${encodeURIComponent(`Подходящий ${runId}`)}`)).body)).toEqual([
      `Подходящий ${runId}`,
    ]);
    // Телефон ищется целиком и по части.
    expect(names((await list("?q=900000003")).body)).toContain(`Невыясненный ${runId}`);
    // Регистр не важен: «зарина» и «Зарина» для ищущего одно и то же.
    expect(names((await list(`?q=${encodeURIComponent(`подходящий ${runId}`)}`)).body)).toEqual([
      `Подходящий ${runId}`,
    ]);
  });

  it("фильтр по цвету светофора отдаёт только свой цвет", async () => {
    const id = `vac-test-green-${runId}`;
    await prisma.jobApplication.create({
      data: {
        conversationId: id,
        channel: "WHATSAPP",
        name: `Зелёный ${runId}`,
        status: "NEW",
        phone: "900000005",
        priority: "GREEN",
      },
    });
    try {
      const green = names((await list("?priority=GREEN")).body);
      expect(green).toContain(`Зелёный ${runId}`);
      expect(green).not.toContain(`Подходящий ${runId}`);
      // Неизвестный цвет отвергается разбором, а не молча игнорируется.
      expect((await list("?priority=BLUE")).status).toBe(400);
    } finally {
      await prisma.jobApplication.deleteMany({ where: { conversationId: id } });
    }
  });

  it("считает кандидатов по цветам и умеет отбирать тех, у кого цвета нет", async () => {
    /**
     * Число рядом с цветом должно стоять ДО нажатия: цвет, за которым никого
     * нет, иначе неотличим от сломанной кнопки — ровно на это владелец и
     * пожаловался 03.09.2026 («эти кнопки вообще не работают»).
     */
    const res = await list();
    expect(res.status).toBe(200);
    expect(typeof res.body.priorityCounts.GREEN).toBe("number");
    // Наши тестовые анкеты цвета не имеют — значит они в NONE.
    expect(res.body.priorityCounts.NONE).toBeGreaterThanOrEqual(3);

    // NONE — это отбор «опыт не выяснен», а не отсутствие фильтра.
    const none = await list("?priority=NONE");
    expect(none.status).toBe(200);
    expect(none.body.items.every((i: { priority: string | null }) => i.priority === null)).toBe(true);
  });

  it("счётчики по цветам не зависят от выбранного цвета", async () => {
    // Иначе, выбрав один цвет, человек видит нули у всех остальных и решает,
    // что выбирать больше нечего.
    const res = await list("?priority=GREEN");
    expect(res.body.priorityCounts.NONE).toBeGreaterThanOrEqual(3);
  });
});
