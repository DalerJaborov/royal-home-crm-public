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
  CLIENT_NOTE_LABELS_REV,
  clientNotesLength,
  clientNotesPlain,
} from "../src/lib/clientNoteLabels.js";
import { sweepClientNotesPlain } from "../src/lib/clientNotesPlainSweep.js";
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
 * Что служебное — один список, lib/clientNoteLabels.ts; очищенный текст хранится в
 * Client.requirementsNotesPlain и пишется одной дверью (перехват записи в db.ts).
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

async function plainOf(id: string) {
  return prisma.client.findUniqueOrThrow({
    where: { id },
    select: { requirementsNotesPlain: true, requirementsNotesPlainRev: true },
  });
}

// ── Разбор исходников для сторожей ──
const LITERAL = /`((?:[^`\\]|\\.)*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const EMOJI_LED = /^[←-⯿\u{1F000}-\u{1FAFF}]/u;
/** Ярлык в стиле бота: значок, затем слова ЗАГЛАВНЫМИ и «—» или «:» («🌍 ВНЕ ДУШАНБЕ —», «💼 НЕ КЛИЕНТ:»). */
const CAPS_LABEL = /^[←-⯿\u{1F000}-\u{1FAFF}]️?\s+[А-ЯЁ]{2,}(?:[ ,]+[А-ЯЁ]{2,})*\s*(?:—|:|-)/u;
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
function literals(code: string): string[] {
  return [...code.matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? m[3]);
}
const registered = (text: string) => CLIENT_NOTE_LABELS.some((l) => text.startsWith(l.prefix));
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "generated") walk(p, out);
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
/**
 * Исходники сервера читаются и разбираются ОДИН раз на файл теста: сторожа ниже проходят
 * по ~1600 файлам, и повторное чтение с разбором литералов в общем прогоне упиралось в
 * лимит времени (29,6 с при 20 с, ревью #382).
 */
type Source = { file: string; raw: string; code: string; lits: () => string[] };
const ALL_FILES: Source[] = walk(SRC).map((p) => {
  const raw = readFileSync(p, "utf8");
  const code = raw
    .split("\n")
    .filter((l) => !isComment(l))
    .join("\n");
  let cached: string[] | undefined;
  return { file: relative(SRC, p).replace(/\\/g, "/"), raw, code, lits: () => (cached ??= literals(code)) };
});
const SOURCE = new Map(ALL_FILES.map((s) => [s.file, s]));
const HAS_SYMBOL = /[←-⯿\u{1F000}-\u{1FAFF}]/u;
/** Сторожа по всем исходникам — с запасом по времени на занятом раннере. */
const SCAN_TIMEOUT = 60_000;

/**
 * Файлы, где ярлыки заметок собираются в переменные (label, callbackNote, zoneNote,
 * summary, *_NOTE) вдали от самой записи. Каждая строка со значка в них — из списка
 * или названа «не заметкой» (сообщения клиенту и сотрудникам рядом).
 */
const LABEL_FILES: Record<string, string[]> = {
  "ai/leadKind.ts": [],
  "services/leads/intentUnknown.ts": [],
  "lib/customerNewLeadBridge.ts": [],
  "ai/incomingCallLead.ts": [],
  "messengers/commentPhoneLead.ts": [],
  "lib/ownerBuyerMatch.ts": [],
  "lib/telephony/autoLeadFromCall.ts": [],
  // Сценарий — часть пересказа ВНУТРИ строки «📞 ПРОСИТ ПЕРЕЗВОНИТЬ: …», а не начало строки.
  "lib/customerLeadOnlyCore.ts": ["🔥 Готов смотреть"],
  "messengers/conversation.ts": ["⚠️ Клиент жалуется", "📍 ${showcase", "🤖 Бот трижды"],
  "messengers/telegramDirectMessages.ts": ["👍"],
  "telegram/bot.ts": ["🏠 Смотреть объекты", "👍", "🙋 Позвать агента"],
  "routes/webhooks.ts": ["🤖 Доставка ответа"],
  "messengers/comments.ts": ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "🩷", "☠️", "🙏${", "💬 Instagram:"],
};

/** Фразы рядом с записью requirementsNotes, которые НЕ заметки, — с причиной. */
const NEAR_NOTES_NOT_LABELS: Array<[file: string, starts: string, why: string]> = [
  ["ai/assistant/tools/createClientTool.ts", "Что ищет клиент", "описание поля для модели"],
  ["lib/cardSuggestions.ts", "клиент не найден", "текст ошибки"],
  ["lib/clientToCandidate.ts", "Клиент не найден", "текст ошибки"],
  ["lib/customerNewLeadBridge.ts", "Клиент назвал конкретного сотрудника", "причина в журнале, не заметка"],
  ["routes/clients/card.ts", "Агент не может переназначать", "текст ошибки"],
  ["routes/clients/intents.ts", "Уточнены пожелания покупателя", "запись хронологии"],
  ["routes/clients/intents.ts", "Пожелания не поместились в карточку", "текст ошибки"],
  ["routes/clients/intents.ts", "Карточка изменилась. Обновите", "текст ошибки"],
  ["routes/clients/intents.ts", "Роли карточки изменились", "текст ошибки"],
  ["services/leads/intake.ts", "Тип обращения изменён:", "запись хронологии о смене типа"],
  ["services/leads/intake.ts", " Карточка снята с агента", "продолжение записи хронологии"],
  ["services/leads/intake.ts", " Прежние данные не стёрты", "продолжение записи хронологии"],
  ["services/leads/intake.ts", "Клиент назвал конкретного сотрудника", "причина назначения, не заметка"],
  ["messengers/comments.ts", "Написать ему в личку отсюда нельзя", "продолжение «Продаёт свою недвижимость…» той же строки"],
];

/** Кто вправе упоминать новую колонку: дверь записи, досчёт, поиск. Остальным писать её нельзя. */
const PLAIN_COLUMN_FILES = new Set([
  "db.ts",
  "lib/clientNoteLabels.ts",
  "lib/clientNotesPlainSweep.ts",
  "lib/fuzzySearch.ts",
  // Только в типе строки списка (omit, как у клиента базы), не запись.
  "routes/clients/list.ts",
]);

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

describe("Список служебных строк заметок — полный и живой", { timeout: SCAN_TIMEOUT }, () => {
  it("каждый префикс списка дословно есть в своём файле (список не врёт)", () => {
    for (const label of CLIENT_NOTE_LABELS) {
      if (label.source === "legacy") continue;
      expect(readFileSync(join(SRC, label.source), "utf8").includes(label.prefix), `${label.source}: «${label.prefix}»`).toBe(
        true
      );
    }
  });

  it("ярлык в стиле бота («значок ЗАГЛАВНЫЕ —») в ЛЮБОМ файле сервера — из списка", () => {
    const unknown: string[] = [];
    for (const { file, code, lits } of ALL_FILES) {
      if (!HAS_SYMBOL.test(code)) continue;
      for (const text of lits()) {
        if (CAPS_LABEL.test(text) && !registered(text) && !registered(text.trimEnd() + " ")) unknown.push(`${file}: «${text.slice(0, 60)}»`);
      }
    }
    // Новый ярлык в заметки — внесите в lib/clientNoteLabels.ts.
    expect(unknown).toEqual([]);
  });

  it("каждая строка со значка в файлах ярлыков — из списка или названа «не заметкой»", () => {
    const unknown: string[] = [];
    for (const [file, notNotes] of Object.entries(LABEL_FILES)) {
      for (const text of SOURCE.get(file)!.lits()) {
        if (EMOJI_LED.test(text) && !registered(text) && !notNotes.some((s) => text.startsWith(s))) {
          unknown.push(`${file}: «${text.slice(0, 60)}»`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("фразы рядом с записью заметок по всему серверу — из списка или с причиной", () => {
    const unknown: string[] = [];
    for (const { file, raw } of ALL_FILES) {
      if (!raw.includes("requirementsNotes")) continue;
      const lines = raw.split("\n");
      lines.forEach((line, i) => {
        if (isComment(line) || !/requirementsNotes\s*(:|=[^=])/.test(line)) return;
        const near = lines.slice(i, i + 6).filter((l) => !isComment(l)).join("\n");
        for (const raw of literals(near)) {
          // Ведущий перенос строки и подстановки `${…}` — код, а не текст заметки.
          const text = raw.replace(/^(\\n)+/, "");
          const plain = text.replace(/\$\{[^}]*\}/g, "");
          // Пути, имена прав («clients.viewPhone») и прочие слова без пробела — не фразы.
          if (text.startsWith("${") || text.startsWith("/") || !plain.trim().includes(" ")) continue;
          if ((plain.match(/\p{L}/gu) ?? []).length < 12) continue;
          const ok = registered(text) || NEAR_NOTES_NOT_LABELS.some(([f, s]) => f === file && text.startsWith(s));
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
    for (const label of labels) expect(clientNotesPlain(label!), label!).toBe("");
  });
});

describe("Одна дверь записи: requirementsNotesPlain меняется вместе с requirementsNotes", { timeout: SCAN_TIMEOUT }, () => {
  it("create / update / { set } / null / updateMany / upsert / createMany — все через перехват", async () => {
    const notes = `🌍 ВНЕ ДУШАНБЕ — клиент назвал «Вахдат», мы работаем только по городу\nДом 6 соток ${mark}`;
    const created = await prisma.client.create({
      data: { fullName: "Дверь А", phone: `+9927${runId}71`, source: "PHONE_CALL", requirementsNotes: notes },
    });
    clientIds.push(created.id);
    expect(await plainOf(created.id)).toEqual({ requirementsNotesPlain: `Дом 6 соток ${mark}`, requirementsNotesPlainRev: CLIENT_NOTE_LABELS_REV });

    await prisma.client.update({ where: { id: created.id }, data: { requirementsNotes: { set: `Квартира ${mark}` } } });
    expect((await plainOf(created.id)).requirementsNotesPlain).toBe(`Квартира ${mark}`);

    await prisma.client.update({ where: { id: created.id }, data: { requirementsNotes: null } });
    expect((await plainOf(created.id)).requirementsNotesPlain).toBeNull();

    await prisma.client.updateMany({ where: { id: created.id }, data: { requirementsNotes: `💼 СОИСКАТЕЛЬ РАБОТЫ\nОфис ${mark}` } });
    expect((await plainOf(created.id)).requirementsNotesPlain).toBe(`Офис ${mark}`);

    // Запись без заметок колонку не трогает.
    await prisma.client.update({ where: { id: created.id }, data: { fullName: "Дверь А2" } });
    expect((await plainOf(created.id)).requirementsNotesPlain).toBe(`Офис ${mark}`);

    const phone = `+9927${runId}72`;
    const up = await prisma.client.upsert({
      where: { phone },
      create: { fullName: "Дверь Б", phone, source: "PHONE_CALL", requirementsNotes: `📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. Слова клиента: «Хона ${mark}»` },
      update: {},
    });
    clientIds.push(up.id);
    expect((await plainOf(up.id)).requirementsNotesPlain).toBe(`Хона ${mark}`);
    await prisma.client.upsert({ where: { phone }, create: { fullName: "x", phone, source: "PHONE_CALL" }, update: { requirementsNotes: `Сад ${mark}` } });
    expect((await plainOf(up.id)).requirementsNotesPlain).toBe(`Сад ${mark}`);

    const phoneC = `+9927${runId}73`;
    await prisma.client.createMany({ data: [{ fullName: "Дверь В", phone: phoneC, source: "PHONE_CALL", requirementsNotes: `🏷 ПРОДАВЕЦ — хочет разместить объект у нас\nХавли ${mark}` }] });
    const c = await prisma.client.findUniqueOrThrow({ where: { phone: phoneC }, select: { id: true, requirementsNotesPlain: true } });
    clientIds.push(c.id);
    expect(c.requirementsNotesPlain).toBe(`Хавли ${mark}`);

    // В интерактивной транзакции — тот же перехват.
    await prisma.$transaction(async (tx) => {
      await tx.client.update({ where: { id: c.id }, data: { requirementsNotes: `🚫 НЕ НАШ ПРОФИЛЬ: склад\nМагазин ${mark}` } });
    });
    expect((await plainOf(c.id)).requirementsNotesPlain).toBe(`Магазин ${mark}`);
  });

  it("служебная копия не едет в ответы: обычное чтение клиента её не возвращает", async () => {
    const id = await createClient("Скрытая копия", "75", `🏷 ПРОДАВЕЦ — хочет разместить объект у нас\nНомер в тексте 900000000 ${mark}`);
    const row = (await prisma.client.findUniqueOrThrow({ where: { id } })) as Record<string, unknown>;
    expect("requirementsNotesPlain" in row).toBe(false);
    expect("requirementsNotesPlainRev" in row).toBe(false);
    expect((await plainOf(id)).requirementsNotesPlain).toContain(mark);
  });

  it("мимо двери не пишут: ни сырого SQL в requirementsNotes, ни чужой записи новой колонки", () => {
    const rawWrites: string[] = [];
    const plainWriters: string[] = [];
    for (const { file, code } of ALL_FILES) {
      if (/(UPDATE\s+"Client"[\s\S]{0,300}?"requirementsNotes"\s*=|INSERT\s+INTO\s+"Client"[^;]{0,600}"requirementsNotes")/i.test(code)) {
        rawWrites.push(file);
      }
      if (code.includes("requirementsNotesPlain") && !PLAIN_COLUMN_FILES.has(file)) plainWriters.push(file);
    }
    expect(rawWrites).toEqual([]);
    expect(plainWriters).toEqual([]);
  });

  it("досчёт после выката: старые строки и смена версии списка", async () => {
    const id = await createClient("Досчёт", "74", `🌍 ВНЕ ДУШАНБЕ — клиент назвал «Нурек», мы работаем только по городу\nУчасток у реки ${mark}`);
    // Как строка, записанная до правки: колонки пустые (сырой SQL — только в тесте).
    await prisma.$executeRaw`UPDATE "Client" SET "requirementsNotesPlain" = NULL, "requirementsNotesPlainRev" = NULL WHERE id = ${id}`;
    await sweepClientNotesPlain();
    expect(await plainOf(id)).toEqual({ requirementsNotesPlain: `Участок у реки ${mark}`, requirementsNotesPlainRev: CLIENT_NOTE_LABELS_REV });
    // Посчитано по прежней версии списка — пересчитывается.
    await prisma.$executeRaw`UPDATE "Client" SET "requirementsNotesPlain" = 'старое', "requirementsNotesPlainRev" = ${CLIENT_NOTE_LABELS_REV + 1} WHERE id = ${id}`;
    await sweepClientNotesPlain();
    expect((await plainOf(id)).requirementsNotesPlain).toBe(`Участок у реки ${mark}`);
    // Копия испорчена мимо двери при ТЕКУЩЕЙ версии (сырой SQL, откат правки) — сверка тоже чинит.
    await prisma.$executeRaw`UPDATE "Client" SET "requirementsNotesPlain" = 'чужое', "requirementsNotesPlainRev" = ${CLIENT_NOTE_LABELS_REV} WHERE id = ${id}`;
    expect(await sweepClientNotesPlain()).toBeGreaterThanOrEqual(1);
    expect((await plainOf(id)).requirementsNotesPlain).toBe(`Участок у реки ${mark}`);
    // Сверенная строка второй раз не переписывается.
    await sweepClientNotesPlain();
    const again = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Client" WHERE id = ${id} AND "requirementsNotesPlain" = ${`Участок у реки ${mark}`}`;
    expect(again[0].n).toBe(1);
  });

  it("поиск идёт по индексу (оператор %), а не очисткой каждой строки", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>(
        Prisma.sql`EXPLAIN SELECT id FROM "Client" WHERE "requirementsNotesPlain" % ${"тест текста"}`
      );
    });
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("Client_requirementsNotesPlain_trgm_idx");
    const code = readFileSync(join(SRC, "lib/fuzzySearch.ts"), "utf8");
    expect(code).toMatch(/"requirementsNotesPlain" % /);
    expect(code).not.toMatch(/regexp_replace\("requirementsNotes"/);
  });
});

describe("Слова клиента остаются, обёртки уходят", () => {
  it("объявление значками — слова клиента целиком", () => {
    const ad = "🏠 Продаю 3-комнатную\n📍 Сино, 12 мкр\n💰 90 000 $\n→ торг\n✓ документы\n≈ 70 м";
    expect(clientNotesPlain(ad)).toBe(ad);
  });

  it("просьба перезвонить: слова после «Слова клиента:», «Когда звонить» — не слова клиента", () => {
    expect(
      clientNotesPlain("📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать. Когда звонить: «вечером». Слова клиента: «У нас есть «две» квартиры в Гиссаре»")
    ).toBe("У нас есть «две» квартиры в Гиссаре");
    expect(clientNotesPlain("📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Кандидат интересуется вакансией")).toBe("");
  });

  it("старая форма «📞 …: «слова»» без «Слова клиента:» — цитата остаётся, хвост «Когда звонить» — нет", () => {
    expect(clientNotesPlain("📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет продать: «Хонаи 3 хуҷра дар Сино». Когда звонить: «завтра утром»")).toBe(
      "Хонаи 3 хуҷра дар Сино"
    );
  });

  it("кавычка не закрылась (текст обрезан по длине) — слова после « остаются", () => {
    expect(clientNotesPlain("📞 ПРОСИТ ПЕРЕЗВОНИТЬ: Хочет купить. Слова клиента: «Ищу квартиру в 82 мкр, бюджет до")).toBe(
      "Ищу квартиру в 82 мкр, бюджет до"
    );
  });

  it("многострочный комментарий: первая строка не теряется, хвостовой » не остаётся", () => {
    const note =
      "Продаёт свою недвижимость: выложил объявление в комментарии под нашим постом (Instagram). " +
      "Написать ему в личку отсюда нельзя — позвонить и предложить продать через нас: «Продаю дом «у реки»\n8 соток\nтел. в профиле»\n" +
      "Подходящие покупатели в базе: 2 (ПК-000001, ПК-000002).";
    expect(clientNotesPlain(note)).toBe("Продаю дом «у реки»\n8 соток\nтел. в профиле");
    expect(clientNotesPlain("Оставил номер в комментарии под нашим постом: «Хона\nфурӯшӣ»\nсвои слова агента")).toBe(
      "Хона\nфурӯшӣ\nсвои слова агента"
    );
    expect(clientNotesPlain("Клиент снова оставил номер в комментарии под нашим постом: +992 90 000 00 00 — «Дом\nв Варзобе»")).toBe(
      "Дом\nв Варзобе"
    );
  });

  it("«⚠️ Код переопределил тип (… (…))» — вложенные скобки, пересказ остаётся", () => {
    expect(
      clientNotesPlain("⚠️ Код переопределил тип со слов модели (похоже на аренду (сумма 3000), а не покупку). Клиент ищет квартиру на месяц")
    ).toBe("Клиент ищет квартиру на месяц");
  });

  it("края — ровно [ \\n\\t\\r], длина — в кодовых точках", () => {
    expect(clientNotesPlain("\r\n Клиент ищет\t\r\n")).toBe("Клиент ищет");
    expect(clientNotesPlain("  📍 вне зоны (Душанбе и Рудаки): Вахдат\n\nҲавлӣ дар Ваҳдат")).toBe("Ҳавлӣ дар Ваҳдат");
    expect(clientNotesLength("🏠 дом")).toBe(5);
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

  it("одинаковая обёртка комментария с разными объявлениями — не подсказка, то же объявление — подсказка", async () => {
    const wrap = (text: string) =>
      `Продаёт свою недвижимость: выложил объявление в комментарии под нашим постом (Instagram). ` +
      `Написать ему в личку отсюда нельзя — позвонить и предложить продать через нас: «${text}»`;
    const a = await createClient("Комментатор А", "65", wrap(`Продаю дом в Гиссаре, 6 соток, ${mark}`));
    const b = await createClient("Комментатор Б", "66", wrap(`Квартира 1 комн. Сино, 40 кв.м ${String(runId).slice(-4)}`));
    expect(await similarIds(a)).not.toContain(b);
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
    expect(clientNotesLength(phrase)).toBeLessThan(SIMILAR_NOTES_MIN_LENGTH);
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
