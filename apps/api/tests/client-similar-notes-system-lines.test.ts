import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { SIMILAR_NOTES_MIN_LENGTH, fuzzySimilarClientNotes } from "../src/lib/fuzzySearch.js";
import {
  CLIENT_NOTE_LABELS,
  noteLength,
  stripClientNoteLabels,
  stripClientNoteLabelsSql,
} from "../src/lib/clientNoteLabels.js";
import { DIRECTION_CONFLICT_NOTE, DIRECTION_UNCONFIRMED_NOTE, decideLeadKind } from "../src/ai/leadKind.js";
import { LEAD_MODEL_FAILED_NOTE } from "../src/services/leads/intentUnknown.js";

/**
 * «ПОХОЖЕ НА … — ЗАМЕТКИ СОВПАДАЮТ НА 84%» МЕЖДУ РАЗНЫМИ ЛЮДЬМИ (снимок владельца
 * 21.11.2026, «Прочее обращение» из WhatsApp). Заметки карточки состояли из ярлыков
 * бота: «📞 ПРОСИТ ПЕРЕЗВОНИТЬ…» и «🌍 ВНЕ ДУШАНБЕ — клиент назвал «Гиссар»…». Первый
 * вырезался списком из пяти значков, второй — нет, и у соседей с тем же ярлыком
 * отличалось только название города: 82–84%. Замер прода в тот же день: все 162
 * подсказки у 20 карточек шли от ярлыков 🌍/🚫, ни одной настоящей.
 *
 * Что служебное — один список, lib/clientNoteLabels.ts. Сторожа ниже держат его
 * полным: новая строка-ярлык в файлах, которые пишут заметки, красит тест.
 */

const SRC = join(__dirname, "..", "src");
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

async function sqlStrip(text: string): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ r: string }>>(
    Prisma.sql`SELECT ${stripClientNoteLabelsSql(Prisma.sql`${text}::text`)} AS r`
  );
  return row.r;
}

// ── Разбор исходников для сторожей ──
const LITERAL = /`((?:[^`\\]|\\.)*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const EMOJI_LED = /^[←-⯿\u{1F000}-\u{1FAFF}]/u;
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
function literals(code: string): string[] {
  return [...code.matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? m[3]);
}
const registered = (text: string) => CLIENT_NOTE_LABELS.some((l) => text.startsWith(l.prefix));

/**
 * Файлы, где ярлыки заметок собираются в переменные (label, callbackNote, zoneNote,
 * summary, *_NOTE) — вдали от самой записи requirementsNotes. Каждая строка со значка
 * в них — либо из списка, либо названа здесь «не заметкой» с причиной.
 */
const LABEL_FILES: Record<string, string[]> = {
  "ai/leadKind.ts": [],
  "services/leads/intentUnknown.ts": [],
  "lib/customerNewLeadBridge.ts": [],
  "ai/incomingCallLead.ts": [],
  "messengers/commentPhoneLead.ts": [],
  "lib/ownerBuyerMatch.ts": [],
  "lib/telephony/autoLeadFromCall.ts": [],
  // Ниже — файлы, где рядом с заметками живут сообщения клиенту и сотрудникам.
  "messengers/conversation.ts": ["⚠️ Клиент жалуется", "📍 ${showcase", "🤖 Бот трижды"],
  "messengers/telegramDirectMessages.ts": ["👍"],
  "telegram/bot.ts": ["🏠 Смотреть объекты", "👍", "🙋 Позвать агента"],
  "routes/webhooks.ts": ["🤖 Доставка ответа"],
  "messengers/comments.ts": ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "🩷", "☠️", "🙏${", "💬 Instagram:"],
};

/**
 * Текст рядом с записью заметок (requirementsNotes: / = …) по ВСЕМУ серверу: шаблон
 * без значка («Продаёт свою недвижимость: … «…»») одинаков у разных людей так же, как
 * ярлык. Каждая такая фраза — из списка или здесь, с причиной, почему это не заметка.
 */
const NEAR_NOTES_NOT_LABELS: Array<[file: string, starts: string, why: string]> = [
  ["ai/assistant/tools/createClientTool.ts", "Что ищет клиент", "описание поля для модели"],
  ["lib/cardSuggestions.ts", "клиент не найден", "текст ошибки"],
  ["lib/clientToCandidate.ts", "Клиент не найден", "текст ошибки"],
  ["lib/customerNewLeadBridge.ts", "Клиент назвал конкретного сотрудника", "причина в журнале, не заметка"],
  ["routes/clients/card.ts", "Агент не может переназначать", "текст ошибки"],
  ["routes/clients/intents.ts", "Уточнены пожелания покупателя", "запись хронологии"],
  ["messengers/comments.ts", "Написать ему в личку отсюда нельзя", "продолжение «Продаёт свою недвижимость…» той же строки"],
  ["routes/clients/intents.ts", "Пожелания не поместились в карточку", "текст ошибки"],
  ["routes/clients/intents.ts", "Карточка изменилась. Обновите", "текст ошибки"],
  ["routes/clients/intents.ts", "Роли карточки изменились", "текст ошибки"],
  ["services/leads/intake.ts", "Тип обращения изменён:", "запись хронологии о смене типа"],
  ["services/leads/intake.ts", " Карточка снята с агента", "продолжение записи хронологии"],
  ["services/leads/intake.ts", " Прежние данные не стёрты", "продолжение записи хронологии"],
  ["services/leads/intake.ts", "Клиент назвал конкретного сотрудника", "причина назначения, не заметка"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "generated") walk(p, out);
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
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

describe("Список служебных строк заметок — полный и живой", () => {
  it("каждый префикс списка дословно есть в своём файле (список не врёт)", () => {
    for (const label of CLIENT_NOTE_LABELS) {
      if (label.source === "legacy") continue;
      const code = readFileSync(join(SRC, label.source), "utf8");
      expect(code.includes(label.prefix), `${label.source}: «${label.prefix}»`).toBe(true);
    }
  });

  it("каждая строка со значка в файлах ярлыков — из списка или названа «не заметкой»", () => {
    for (const [file, notNotes] of Object.entries(LABEL_FILES)) {
      const code = readFileSync(join(SRC, file), "utf8")
        .split("\n")
        .filter((l) => !isComment(l))
        .join("\n");
      for (const text of literals(code)) {
        if (!EMOJI_LED.test(text)) continue;
        const ok = registered(text) || notNotes.some((s) => text.startsWith(s));
        expect(ok, `${file}: новая строка со значка «${text.slice(0, 60)}» — внесите в lib/clientNoteLabels.ts`).toBe(true);
      }
    }
  });

  it("фразы рядом с записью заметок по всему серверу — из списка или с причиной", () => {
    const unknown: string[] = [];
    for (const path of walk(SRC)) {
      const file = relative(SRC, path).replace(/\\/g, "/");
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isComment(line) || !/requirementsNotes\s*(:|=[^=])/.test(line)) return;
        const near = lines.slice(i, i + 6).filter((l) => !isComment(l)).join("\n");
        for (const raw of literals(near)) {
          // Ведущий перенос строки и подстановки `${…}` — не текст заметки, а код.
          const text = raw.replace(/^(\\n)+/, "");
          const plain = text.replace(/\$\{[^}]*\}/g, "");
          // Пути, имена прав («clients.viewPhone») и прочие слова без пробела — не фразы.
          if (text.startsWith("${") || text.startsWith("/") || !plain.trim().includes(" ")) continue;
          if ((plain.match(/\p{L}/gu) ?? []).length < 12) continue;
          const ok =
            registered(text) || NEAR_NOTES_NOT_LABELS.some(([f, s]) => f === file && text.startsWith(s));
          if (!ok) unknown.push(`${file}:${i + 1}: «${text.slice(0, 70)}»`);
        }
      });
    }
    // Шаблон заметки — внесите в lib/clientNoteLabels.ts; не заметка — в NEAR_NOTES_NOT_LABELS с причиной.
    expect(unknown).toEqual([]);
  });

  it("каждый ярлык decideLeadKind и пометки-константы вырезаются целиком", () => {
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
    labels.push(DIRECTION_CONFLICT_NOTE, DIRECTION_UNCONFIRMED_NOTE, LEAD_MODEL_FAILED_NOTE);
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) expect(stripClientNoteLabels(label!), label!).toBe("");
  });
});

describe("Очистка заметок одинакова в JS и в Postgres", () => {
  const samples = [
    "🌍 ВНЕ ДУШАНБЕ — клиент назвал «Гиссар», мы работаем только по городу",
    "📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. Когда звонить: «вечером». Слова клиента: «У нас есть «две» квартиры в Гиссаре»\n🌍 ВНЕ ДУШАНБЕ — клиент назвал «Гиссар», мы работаем только по городу",
    "📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Кандидат интересуется вакансией",
    "Клиент продаёт 3-комнатную квартиру\n🚫 НЕ НАШ ПРОФИЛЬ: коммерция (клиент назвал «склад»)\nс ремонтом, 17 этаж",
    "🏠 Продаю 3-комнатную\n📍 Сино, 12 мкр\n💰 90 000 $\n→ торг\n✓ документы\n≈ 70 м",
    "  📍 вне зоны (Душанбе и Рудаки): Вахдат\n\nҲавлӣ дар Ваҳдат, 6 сотих",
    "Продаёт свою недвижимость: выложил объявление в комментарии под нашим постом (Instagram). Написать ему в личку отсюда нельзя — позвонить и предложить продать через нас: «Продаю дом «у реки», 8 соток»\nПодходящие покупатели в базе: 2 (ПК-000001, ПК-000002).",
    "⚠️ Код переопределил тип со слов модели (похоже на аренду, а не покупку/продажу). Клиент ищет квартиру на месяц",
    "Спам-комментарий под нашим постом (реклама чужой недвижимости), удалён автоматически: «Хона фурӯшӣ»",
    "near the market, rent\n🌍 ВНЕ ДУШАНБЕ — клиент назвал «X», мы работаем только по городу\ntest",
    "\r\n Клиент ищет\t\r\n",
    "",
  ];

  it("каждый образец даёт одинаковый остаток", async () => {
    for (const sample of samples) expect(await sqlStrip(sample), JSON.stringify(sample)).toBe(stripClientNoteLabels(sample));
  });

  it("слова клиента остаются, обёртки уходят", () => {
    // Объявление значками — слова клиента целиком (ревью #382: правило «строка со значка» стирало его).
    expect(stripClientNoteLabels(samples[4])).toBe(samples[4]);
    expect(stripClientNoteLabels(samples[1])).toBe("У нас есть «две» квартиры в Гиссаре");
    expect(stripClientNoteLabels(samples[2])).toBe("");
    expect(stripClientNoteLabels(samples[3])).toBe("Клиент продаёт 3-комнатную квартиру\nс ремонтом, 17 этаж");
    expect(stripClientNoteLabels(samples[6])).toBe("Продаю дом «у реки», 8 соток");
    expect(stripClientNoteLabels(samples[7])).toBe("Клиент ищет квартиру на месяц");
    expect(stripClientNoteLabels(samples[8])).toBe("Хона фурӯшӣ");
    // Края — ровно [ \n\t\r], как btrim в Postgres; длина — в кодовых точках, как length().
    expect(stripClientNoteLabels(samples[10])).toBe("Клиент ищет");
    expect(noteLength("🏠 дом")).toBe(5);
  });
});

describe("Подсказка «Может, один человек?» — только по словам людей", () => {
  it("карточки из одних ярлыков «вне Душанбе» с разными городами — не подсказка (ПО-000935)", async () => {
    const gissar = decideLeadKind({ clientText: "У нас есть несколько квартир в городе Гиссаре" }).label!;
    const bokhtar = decideLeadKind({ clientText: "Дом в Бохтаре продаю" }).label!;
    expect(gissar).toContain("ВНЕ ДУШАНБЕ");
    expect(bokhtar).toContain("ВНЕ ДУШАНБЕ");
    const a = await createClient(
      "Прочее А",
      "51",
      `📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. район: Гиссар. Слова клиента: «Асалому алейкум. У нас есть несколько квартир в городе Гиссаре ${mark}»\n${gissar}`
    );
    const b = await createClient("Прочее Б", "52", bokhtar);
    const c = await createClient("Прочее В", "53", `${bokhtar}\n${bokhtar}`);
    const ids = await similarIds(a);
    expect(ids).not.toContain(b);
    expect(ids).not.toContain(c);
    // Сама функция — общая с пушем руководству (services/leads/intake.ts, порог 0.75).
    expect(await fuzzySimilarClientNotes(b, bokhtar, 0.75, 5)).toEqual([]);
  });

  it("длинная заметка против кандидата из одних ярлыков — не подсказка", async () => {
    const story = `Квартира 2 комнаты в Шохмансуре, евроремонт, 9 этаж из 12, мебель остаётся ${mark}`;
    const labelsOnly = [
      "🏷 ПРОДАВЕЦ — хочет разместить объект у нас (реклама бесплатно, комиссия 2% при продаже)",
      "📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать квартиру в Шохмансуре, евроремонт, 9 этаж",
      "Подходящие покупатели в базе: 3 (ПК-000010, ПК-000011, ПК-000012).",
    ].join("\n");
    const a = await createClient("Продавец Ж", "63", `🏷 ПРОДАВЕЦ — хочет разместить объект у нас\n${story}`);
    const b = await createClient("Продавец З", "64", labelsOnly);
    expect(await similarIds(a)).not.toContain(b);
    expect(await similarIds(b)).toEqual([]);
  });

  it("одинаковая обёртка комментария с разными объявлениями — не подсказка", async () => {
    const wrap = (text: string) =>
      `Продаёт свою недвижимость: выложил объявление в комментарии под нашим постом (Instagram). ` +
      `Написать ему в личку отсюда нельзя — позвонить и предложить продать через нас: «${text}»`;
    const a = await createClient("Комментатор А", "65", wrap(`Продаю дом в Гиссаре, 6 соток, ${mark}`));
    const b = await createClient("Комментатор Б", "66", wrap(`Квартира 1 комн. Сино, 40 кв.м ${String(runId).slice(-4)}`));
    expect(await similarIds(a)).not.toContain(b);
    // То же объявление с другого номера — один человек, подсказка есть.
    const c = await createClient("Комментатор В", "67", wrap(`Продаю дом в Гиссаре, 6 соток, ${mark}`));
    expect(await similarIds(a)).toContain(c);
  });

  it("объявление значками с двух номеров находится (слова клиента не вырезаются)", async () => {
    const ad = `🏠 Продаю 3-комнатную в 82 мкр\n📍 Сино, напротив школы\n💰 85 000 $\n✓ документы ${mark}`;
    const a = await createClient("Продавец И", "68", ad);
    const b = await createClient("Продавец К", "69", `🏷 ПРОДАВЕЦ — хочет разместить объект у нас\n${ad}`);
    expect(await similarIds(a)).toContain(b);
  });

  it("короткая общая фраза пересказа — не «уникальное содержание»", async () => {
    const phrase = `Клиент ищет дом ${String(runId).slice(-6)}`;
    expect(noteLength(phrase)).toBeLessThan(SIMILAR_NOTES_MIN_LENGTH);
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
