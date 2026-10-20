import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitFor } from "./helpers/waitFor.js";

/**
 * ИИ ПИШЕТ УСЛЫШАННОЕ В КАРТОЧКУ САМ, МОЛЧА И ЦЕЛИКОМ — решение владельца 12.09.2026.
 *
 * Дословно: «блок „После разговора: проверьте, верно ли поняли клиента“ я уже сто раз
 * убираю, чтобы он исчез у всех и больше не появлялся. Я специально плачу за дорогую
 * модель, чтобы она не переспрашивала».
 *
 * ЧТО БЫЛО ДО ЭТОГО (нужно знать, иначе тест выглядит противоречащим соседним):
 *  · 07.08.2026 — заполнять только с подтверждения агента;
 *  · 12.08.2026 — обязательное окно отменено, пустые поля заполняются сами;
 *  · 14.08.2026 — граница: расхождение с уже записанным значением остаётся
 *    предложением и ждёт нажатия. Именно эту границу владелец и снял 12.09.
 *
 * Стерегут пять вещей, каждая из которых уже ломалась или может сломаться:
 *  1. записывается ВСЁ услышанное, включая расхождение с тем, что вписал человек;
 *  2. висящих предложений не остаётся ни одного — иначе баннер вернётся;
 *  3. в хронологии клиента есть строка «ИИ уточнил карточку по разговору: …»
 *     с перечнем «было → стало» — единственный способ заметить правку;
 *  4. история карточки хранит структурный before/after (автор «Система»);
 *  5. ИИ не пишет в карточку, которую автор разговора больше не ведёт.
 */

let aiReply: Record<string, unknown> | null = null;
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: async () => aiReply,
}));

const { prisma } = await import("../src/db.js");
const { buildSuggestionFromCall } = await import("../src/lib/cardSuggestions.js");

const runId = Date.now();
let agentId = "";
let otherAgentId = "";
let clientId = "";
let districtId = "";
let interactionId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент автозаписи ${runId}`, phone: `+99263${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const other = await prisma.agent.create({
    data: { fullName: `Чужой агент ${runId}`, phone: `+99265${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  otherAgentId = other.id;
  const district = await prisma.district.create({ data: { name: `Фирдавсӣ-${runId}` } });
  districtId = district.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент автозаписи ${runId}`,
      phone: `+99264${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
      // Бюджет в карточке УЖЕ есть и отличается от услышанного: до 12.09.2026 машина
      // о нём спрашивала, теперь перезаписывает и оставляет след.
      budgetMin: 200000,
      budgetMax: 250000,
    },
  });
  clientId = client.id;

  const interaction = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Звонок через CRM, разговор 3:20",
      transcript: "Ман хонаи сеҳуҷраги дар Фирдавсӣ мекобам, то чорсаду панҷоҳ ҳазор",
    },
  });
  interactionId = interaction.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: clientId } });
  await prisma.pendingSummary.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.cardSuggestion.deleteMany({ where: { clientId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

describe("ИИ сам обновляет карточку по разговору", () => {
  it("записывает всё услышанное молча — и пустое, и расхождение с тем, что вписал человек", async () => {
    aiReply = {
      budgetMin: 400000,
      budgetMax: 450000,
      districtName: `Фирдавсӣ-${runId}`,
      rooms: 3,
      notes: "Ищет трёхкомнатную в Фирдавси, бюджет до 450 тысяч",
      evidence: ["хонаи сеҳуҷраги", "то чорсаду панҷоҳ ҳазор"],
    };

    const result = await buildSuggestionFromCall({ clientId, agentId, interactionId, talkSeconds: 200 });
    expect(result.created).toBe(true);

    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    // 1. Пустое машина заполнила сама — так было и до 12.09.
    expect(card.desiredRooms).toBe(3);
    expect(card.desiredDistrictId).toBe(districtId);

    // 2. Заполненное ТОЖЕ перезаписано. Агент записал 200–250 тысяч, машина услышала
    //    400–450 — с 12.09.2026 она не спрашивает, а пишет и оставляет след.
    expect(Number(card.budgetMin)).toBe(400000);
    expect(Number(card.budgetMax)).toBe(450000);
  });

  it("висящих предложений не остаётся — ни строки pending, ни обязательного окна", async () => {
    // Ровно то, на что жаловался владелец: «я уже сто раз убираю этот блок». Пока в
    // базе есть pending-предложение, баннер возвращается сам собой.
    const pending = await prisma.cardSuggestion.count({ where: { clientId, status: "pending" } });
    expect(pending).toBe(0);

    const suggestion = await prisma.cardSuggestion.findFirstOrThrow({ where: { interactionId } });
    expect(suggestion.status).toBe("applied");
    expect(suggestion.resolvedAt).not.toBeNull();
    // Услышанное сохранено целиком — это ещё и запись о разговоре, с цитатами клиента.
    expect(Number(suggestion.budgetMin)).toBe(400000);
    expect(suggestion.evidence.length).toBeGreaterThan(0);

    const windows = await prisma.pendingSummary.count({ where: { agentId, kind: "card_fill", doneAt: null } });
    expect(windows).toBe(0);
  });

  it("в хронологии клиента есть строка о правке с перечнем «было → стало»", async () => {
    const trace = await prisma.interaction.findFirst({
      where: { clientId, type: "SYSTEM", notes: { startsWith: "ИИ уточнил карточку по разговору" } },
      orderBy: { createdAt: "desc" },
    });
    expect(trace).not.toBeNull();

    // Заголовок перечисляет поля человеческими словами, а не именами колонок.
    expect(trace!.notes).toContain("бюджет от");
    expect(trace!.notes).toContain("район");
    expect(trace!.notes).toContain("комнат");

    // Перезапись бюджета видна вместе со старым значением — без этого агент не
    // узнал бы, что его цифру поменяли.
    expect(trace!.notes).toContain("было «200000» → стало «400000»");
    // Район — названием, а не uuid: «было „7f3a…“» в ленте бесполезно.
    expect(trace!.notes).toContain(`стало «Фирдавсӣ-${runId}»`);
    // Пустого поля не было — так и написано.
    expect(trace!.notes).toContain("• комнат: было «—» → стало «3»");
  });

  it("история карточки хранит структурный before/after, автор — «Система»", async () => {
    // Строка истории пишется «в отрыве»: logSystemAudit (lib/audit.ts) намеренно
    // не ждёт вставку, чтобы запись в историю не задерживала и не роняла разбор
    // разговора — и вызов в lib/cardSuggestions.ts тоже без await. Читать её
    // сразу следующим запросом — гонка: на свободной машине вставка успевает, на
    // загруженном раннере нет. С 20.09.2026 (правка #608) тесты сервера идут в
    // два процесса на одной базе, и падение стало живым: красный build-and-test
    // на #616 (прогон 35633594556) при полностью зелёном прогоне этого же файла
    // в одиночку. Ждём запись помощником, а не переделываем logSystemAudit под
    // await: «в отрыве» — это его смысл, а не недосмотр.
    const entry = await waitFor(
      () =>
        prisma.auditLog.findFirst({
          where: { entityType: "Client", entityId: clientId, action: "CLIENT_AI_UPDATED" },
          orderBy: { createdAt: "desc" },
        }),
      { label: "CLIENT_AI_UPDATED в истории карточки" }
    );
    expect(entry).not.toBeNull();
    expect(entry?.agentName).toBe("Система");

    const changes = (entry?.meta as { changes?: { field: string; before: unknown; after: unknown }[] })?.changes ?? [];
    expect(changes.map((c) => c.field).sort()).toEqual([
      "budgetMax",
      "budgetMin",
      "districtId",
      "notes",
      "rooms",
    ]);
    // Именно по этой паре поле возвращается руками, если машина расслышала неверно.
    expect(changes.find((c) => c.field === "budgetMin")?.before).toBe(200000);
    expect(changes.find((c) => c.field === "budgetMin")?.after).toBe(400000);
    expect(changes.find((c) => c.field === "rooms")?.before).toBeNull();
  });

  it("поле, о котором в разговоре не было ни слова, не затирается", async () => {
    // Клиент назвал только район: остальное в карточке обязано остаться прежним.
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    aiReply = { districtName: `Фирдавсӣ-${runId}`, rooms: null, budgetMin: null, budgetMax: null, evidence: [] };

    const second = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Второй звонок", transcript: "Дар Фирдавсӣ" },
    });
    await buildSuggestionFromCall({ clientId, agentId, interactionId: second.id, talkSeconds: 100 });

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(after.budgetMin)).toBe(Number(before.budgetMin));
    expect(after.desiredRooms).toBe(before.desiredRooms);
  });

  /**
   * ОРИЕНТИР ПО ПУТИ ЗВОНКА. Разбор его извлекал (ai/cardFill.ts), путь ПЕРЕПИСКИ
   * записывал в карточку (lib/clientAutopilot.ts), а путь ЗВОНКА терял: у
   * CardSuggestion не было такой колонки вовсе.
   */
  it("ориентир, названный в разговоре, доезжает до карточки", async () => {
    aiReply = {
      address: "напротив кинотеатра Зебунисо",
      evidence: ["рӯ ба рӯи кинотеатри Зебунисо"],
    };
    const third = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Третий звонок", transcript: "Рӯ ба рӯи кинотеатри Зебунисо" },
    });

    await buildSuggestionFromCall({ clientId, agentId, interactionId: third.id, talkSeconds: 120 });

    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(card.address).toBe("напротив кинотеатра Зебунисо");
    const suggestion = await prisma.cardSuggestion.findFirstOrThrow({ where: { interactionId: third.id } });
    expect(suggestion.address).toBe("напротив кинотеатра Зебунисо");
  });

  /**
   * ДО 12.09.2026 УЖЕ ЗАПИСАННЫЙ ОРИЕНТИР МАШИНА НЕ ТРОГАЛА — это была та самая
   * граница «спорное оставляем агенту». Владелец её снял: клиент уточняет ориентир
   * от разговора к разговору, и свежее слово клиента важнее прошлого.
   */
  it("уже записанный ориентир перезаписывается, и старый остаётся в хронологии", async () => {
    aiReply = { address: "за рынком Саховат", evidence: [] };
    const fourth = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Четвёртый звонок", transcript: "Паси бозори Саховат" },
    });

    await buildSuggestionFromCall({ clientId, agentId, interactionId: fourth.id, talkSeconds: 120 });

    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(card.address).toBe("за рынком Саховат");

    const trace = await prisma.interaction.findFirst({
      where: { clientId, type: "SYSTEM", notes: { startsWith: "ИИ уточнил карточку по разговору" } },
      orderBy: { createdAt: "desc" },
    });
    expect(trace!.notes).toContain("• ориентир: было «напротив кинотеатра Зебунисо» → стало «за рынком Саховат»");
  });

  /**
   * ПРАВА (12.09.2026). Разбор идёт через минуту-две после отбоя — окно, в котором
   * клиента успевают переназначить. Молчаливая запись от имени агента, который
   * карточку больше не ведёт, это ровно то, что запрещают маршруты карточки
   * (canAccessAssignedAgent), а фоновый путь в middleware не заходит вовсе.
   */
  it("клиент переназначен другому — разбор в карточку не пишет", async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: otherAgentId } });

    aiReply = { rooms: 5, evidence: ["панҷхонагӣ"] };
    const sixth = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Шестой звонок", transcript: "Панҷхонагӣ мехоҳам" },
    });
    const result = await buildSuggestionFromCall({ clientId, agentId, interactionId: sixth.id, talkSeconds: 120 });
    expect(result.created).toBe(false);

    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(card.desiredRooms).toBe(before.desiredRooms);

    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: agentId } });
  });

  /**
   * ЖИВОЙ КЛАСС 27.08.2026 (сплошная охота). Конвейер запускается через минуту-
   * две после отбоя — ровно то окно, когда карточку успевают удалить. Без
   * фильтра предложение молча дописывало карточку из Корзины и писало
   * CLIENT_AI_UPDATED в её историю.
   */
  it("карточка в Корзине — предложение не создаётся, карточка не трогается", async () => {
    aiReply = { rooms: 4, evidence: ["чорхонагӣ"] };
    const fifth = await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Пятый звонок", transcript: "Чорхонагӣ мехоҳам" },
    });
    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });

    const result = await buildSuggestionFromCall({ clientId, agentId, interactionId: fifth.id, talkSeconds: 120 });
    expect(result.created).toBe(false);

    const card = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(card.desiredRooms).toBe(3); // осталось прежним, не перезаписалось на 4

    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: null } });
  });
});
