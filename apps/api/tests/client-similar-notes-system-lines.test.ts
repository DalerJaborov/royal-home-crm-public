import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { Prisma } from "../src/generated/prisma/client.js";
import {
  SIMILAR_NOTES_MIN_LENGTH,
  fuzzySimilarClientNotes,
  stripSystemNoteLines,
  stripSystemNoteLinesSql,
} from "../src/lib/fuzzySearch.js";
import { DIRECTION_CONFLICT_NOTE, DIRECTION_UNCONFIRMED_NOTE, decideLeadKind } from "../src/ai/leadKind.js";

/**
 * «ПОХОЖЕ НА … — ЗАМЕТКИ СОВПАДАЮТ НА 84%» МЕЖДУ РАЗНЫМИ ЛЮДЬМИ (снимок владельца
 * 21.11.2026, «Прочее обращение» из WhatsApp). Заметки карточки состояли из ярлыков
 * бота: «📞 ПРОСИТ ПЕРЕЗВОНИТЬ…» и «🌍 ВНЕ ДУШАНБЕ — клиент назвал «Гиссар»…». Первый
 * вырезался списком значков, второй — нет, и у соседей с тем же ярлыком отличалось
 * только название города: 82–84%. Замер прода в тот же день: все 162 подсказки у 20
 * карточек шли от ярлыков 🌍/🚫, ни одной настоящей.
 */

const runId = Date.now();
const password = "testpass123";
let adminId: string;
let token: string;
const clientIds: string[] = [];
// Уникальное слово прогона: тексты этого файла не совпадут с карточками соседних файлов.
const mark = `метка${runId}`;

async function createClient(name: string, suffix: string, requirementsNotes: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/clients")
    .set("Authorization", `Bearer ${token}`)
    .send({ fullName: name, phone: `+9927${runId}${suffix}`, source: "PHONE_CALL", requirementsNotes });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  clientIds.push(res.body.id);
  return res.body.id;
}

async function similarIds(id: string): Promise<string[]> {
  const res = await request(app).get(`/api/v1/clients/${id}/similar-notes`).set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.map((r: { id: string }) => r.id);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  adminId = (
    await prisma.agent.create({
      data: { fullName: "Админ похожих заметок", phone: `+992968${runId}`, role: "ADMIN", passwordHash },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: `+992968${runId}`, password });
  token = login.body.accessToken;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("Системные строки заметок не считаются похожестью", () => {
  it("правило «строка со значка» одинаково в JS и в Postgres", async () => {
    const samples = [
      "🌍 ВНЕ ДУШАНБЕ — клиент назвал «Гиссар», мы работаем только по городу",
      "📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать.\n🌍 ВНЕ ДУШАНБЕ — клиент назвал «Бохтар»",
      "Клиент продаёт 3-комнатную квартиру\n🚫 НЕ НАШ ПРОФИЛЬ: коммерция\nс ремонтом, 17 этаж",
      "  ⚠️ проверить номер\n📍 вне зоны (Душанбе и Рудаки): Вахдат\n\nҲавлӣ дар Ваҳдат, 6 сотих",
      "❓ уточнить: покупает или продаёт\n🗂 ПО ДОСЬЕ: продавец\n✅ принят",
      "«Асалому алейкум» — 2 хона, 70 кв.м\n- торг уместен\nJust text 123",
      // Края «n…t»: btrim обязан снимать пробельные знаки, а не буквы n/t/r (экранирование E'…').
      "near the market, rent\n🌍 ВНЕ ДУШАНБЕ\ntest",
      "",
    ];
    for (const sample of samples) {
      const [row] = await prisma.$queryRaw<Array<{ r: string }>>(
        Prisma.sql`SELECT ${stripSystemNoteLinesSql(Prisma.sql`${sample}::text`)} AS r`
      );
      expect(row.r, JSON.stringify(sample)).toBe(stripSystemNoteLines(sample));
    }
    // Слова клиента остаются: буквы, цифры, кавычки и тире в диапазоны значков не входят.
    expect(stripSystemNoteLines(samples[5])).toBe(samples[5]);
    expect(stripSystemNoteLines(samples[2])).toBe("Клиент продаёт 3-комнатную квартиру\nс ремонтом, 17 этаж");
  });

  it("каждый ярлык decideLeadKind целиком вырезается (новый ярлык без значка красит тест)", () => {
    const inputs = [
      { clientText: "Квартира в Гиссаре, продаю" },
      { clientText: "Предлагаем услуги SMM и создание сайтов для вашей компании" },
      { clientText: "Ищу работу, резюме отправлю" },
      { intent: "job" as const, clientText: "Ищу работу" },
      { intent: "rent" as const, clientText: "Нужна квартира" },
      { intent: "other" as const, clientText: "Здравствуйте" },
      { intent: "sell" as const, clientText: "Продаю квартиру 3 комнаты" },
      { clientText: "Можно подробнее?", fromAd: true },
      { clientText: "Помогите деньгами пожалуйста" },
      { intent: "buy" as const, clientText: "Здравствуйте", confident: false },
    ];
    const labels = inputs.map((i) => decideLeadKind(i as Parameters<typeof decideLeadKind>[0]).label).filter(Boolean);
    labels.push(DIRECTION_CONFLICT_NOTE, DIRECTION_UNCONFIRMED_NOTE);
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) expect(stripSystemNoteLines(label!), label!).toBe("");
  });

  it("карточки из одних ярлыков «вне Душанбе» с разными городами — не подсказка (ПО-000935)", async () => {
    const gissar = decideLeadKind({ clientText: "У нас есть несколько квартир в городе Гиссаре" }).label!;
    const bokhtar = decideLeadKind({ clientText: "Дом в Бохтаре продаю" }).label!;
    expect(gissar).toContain("ВНЕ ДУШАНБЕ");
    expect(bokhtar).toContain("ВНЕ ДУШАНБЕ");
    const a = await createClient(
      "Прочее А",
      "51",
      `📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. район: Гиссар. Слова клиента: «У нас есть несколько квартир» ${mark}\n${gissar}`
    );
    const b = await createClient("Прочее Б", "52", bokhtar);
    const c = await createClient("Прочее В", "53", `${bokhtar}\n${bokhtar}`);
    const ids = await similarIds(a);
    expect(ids).not.toContain(b);
    expect(ids).not.toContain(c);
    // Сама функция — общая с пушем руководству (services/leads/intake.ts, порог 0.75).
    expect(await fuzzySimilarClientNotes(b, bokhtar, 0.75, 5)).toEqual([]);
  });

  it("короткая общая фраза пересказа — не «уникальное содержание»", async () => {
    const phrase = `Клиент ищет дом ${String(runId).slice(-6)}`;
    expect(phrase.length).toBeLessThan(SIMILAR_NOTES_MIN_LENGTH);
    const a = await createClient("Покупатель А", "54", phrase);
    const b = await createClient("Покупатель Б", "55", phrase);
    expect(await similarIds(a)).not.toContain(b);
  });

  it("настоящее совпадение описания под ярлыком находится", async () => {
    const story = `Квартира переделана в 3-комнатную на 17 этаже, напротив Театра кукол, срочно ${mark}`;
    const a = await createClient("Продавец А", "56", `🏷 ПРОДАВЕЦ — хочет разместить объект у нас\n${story}`);
    const b = await createClient("Продавец Б", "57", `${story}\n📞 ПРОСИТ ПЕРЕЗВОНИТЬ: вечером`);
    expect(await similarIds(a)).toContain(b);
  });

  it("отклонённые пары «разные люди» не занимают места настоящей (отсев до LIMIT)", async () => {
    const story = `Дом 2 этажа в Зарнисоре, 8 соток, баня и гараж, документы готовы ${mark}`;
    const a = await createClient("Хозяин А", "58", story);
    const twins = [
      await createClient("Хозяин Б", "59", story),
      await createClient("Хозяин В", "60", story),
      await createClient("Хозяин Г", "61", story),
    ];
    const near = await createClient("Хозяин Д", "62", `${story}, торг`);
    for (const twin of twins) {
      const res = await request(app)
        .post(`/api/v1/clients/${a}/similar-notes/${twin}/dismiss`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
    const ids = await similarIds(a);
    for (const twin of twins) expect(ids).not.toContain(twin);
    expect(ids).toContain(near);
  });
});
