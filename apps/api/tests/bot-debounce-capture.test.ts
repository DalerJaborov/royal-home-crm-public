import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ОКНО ДЕБАУНСА ЗАБИРАЕТСЯ ОДНИМ ХОДОМ И РОВНО ОДИН РАЗ.
 *
 * Найдено проверкой кода 12.08.2026, два дефекта в одной паре запросов:
 *
 * 1. Буфер проверялся findUnique, а очищался отдельным update. Сообщение, пришедшее
 *    МЕЖДУ ними, дописывалось в буфер и тут же стиралось: его слов не видели ни
 *    модель, ни переписка, а клиент получал два ответа вместо одного склеенного.
 *
 * 2. Победитель окна определялся равенством lastMessageAt с точностью до
 *    миллисекунды. Две доставки Meta, попавшие в одну миллисекунду, объявляли
 *    победителями ОБА вызова — и оба отвечали клиенту.
 *
 * Теперь и проверка, и очистка — один UPDATE с условием: победитель ровно один,
 * его буфер уходит модели целиком.
 *
 * Модель подменена: тест не должен ни платить за токены, ни зависеть от сети.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));


/**
 * Загрузчик вложений подменён: предмет теста — ОЖИДАНИЕ, а не скачивание. С живым
 * загрузчиком выдуманный адрес не резолвится, картинки нет, и ход уходит в ветку
 * «пустой текст» — то есть проверялось бы совсем не то.
 */
vi.mock("../src/messengers/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/attachments.js")>()),
  fetchAttachments: async () => ({
    images: [{ kind: "image" as const, mediaType: "image/jpeg", data: "" }],
    audios: [],
    medias: [],
    hadUnsupported: false,
  }),
  storeFetchedAttachments: () => [],
}));
const runId = Date.now().toString(36);
const SUBSCRIBER = `debounce-${runId}`;

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Окно настоящее: без него ходы не накладываются и гонки не происходит вовсе.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 2, botReplyMaxWaitSec: 5 },
  });
  // Диалог заводим заранее: предмет теста — захват буфера, а не создание записи
  // диалога (её upsert параллельные первые сообщения ловят своей отдельной гонкой).
  const conv = await fixture.ensureConversation(SUBSCRIBER);
  await prisma.botConversation.update({ where: { id: conv.id }, data: { messages: [], leadDraft: { stage: "chatting" } } });
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await fixture?.dispose();
});

describe("Три сообщения подряд — один ответ", () => {
  it("отвечает ровно один ход, и в модель уходят все три реплики", async () => {
    callAi.mockResolvedValue({ reply: ["Хуб, фаҳмидам"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    callAi.mockClear();

    // Отправляем практически одновременно — как Meta доставляет пачку сообщений,
    // набранных клиентом за пару секунд.
    const results = await Promise.all([
      processMessengerTurn({ ...fixture.turnInput(SUBSCRIBER), text: "Салом" }),
      processMessengerTurn({ ...fixture.turnInput(SUBSCRIBER), text: "хона даркор" }),
      processMessengerTurn({ ...fixture.turnInput(SUBSCRIBER), text: "Сино, 3 хона" }),
    ]);

    // Главное свойство: клиент получает ОДИН ответ на пачку, а не три.
    const answered = results.filter((r) => r.shouldReply !== false);
    expect(answered).toHaveLength(1);

    // И ни одно слово не потеряно: победитель забрал буфер целиком.
    const said = callAi.mock.calls
      .flatMap((call) => (call[0].messages ?? []) as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    expect(said).toContain("Салом");
    expect(said).toContain("хона даркор");
    expect(said).toContain("Сино, 3 хона");

    // Буфер после хода пуст — иначе следующая пачка утащила бы чужие слова.
    const conv = await prisma.botConversation.findFirst({
      where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId: SUBSCRIBER },
      select: { pendingMessages: true, pendingSince: true },
    });
    expect(conv?.pendingMessages).toEqual([]);
    expect(conv?.pendingSince).toBeNull();
  });
});

describe("Две доставки в одну миллисекунду", () => {
  it("победителем окна становится ровно один вызов", async () => {
    // Один и тот же lastMessageAt у обоих ждущих вызовов — ровно тот случай, на
    // котором старое сравнение по миллисекундам объявляло победителями обоих.
    // Воспроизводим его в базе напрямую: подгадать одинаковую миллисекунду двумя
    // живыми ходами нельзя, а условие захвата обязано выдержать и это.
    const tie = new Date();
    const native = await fixture.ensureConversation(`${SUBSCRIBER}-tie`);
    const conv = await prisma.botConversation.update({
      where: { id: native.id },
      data: {
        messages: [],
        leadDraft: { stage: "chatting" } as never,
        pendingMessages: ["Салом", "хона даркор"],
        lastMessageAt: tie,
        pendingSince: tie,
      },
    });

    const capture = () =>
      prisma.$queryRaw<{ pending: unknown }[]>`
        WITH taken AS (
          SELECT "id", "pendingMessages"
          FROM "BotConversation"
          WHERE "id" = ${conv.id}
            AND "lastMessageAt" = ${tie}
            AND "pendingSince" IS NOT NULL
          FOR UPDATE
        )
        UPDATE "BotConversation" b
        SET "pendingMessages" = '[]'::jsonb, "pendingSince" = NULL
        FROM taken
        WHERE b."id" = taken."id"
        RETURNING taken."pendingMessages" AS "pending"`;

    const [a, b] = await Promise.all([capture(), capture()]);
    const winners = [a, b].filter((rows) => rows.length > 0);
    expect(winners).toHaveLength(1);
    // Победителю достаётся буфер целиком, а не половина.
    expect(winners[0][0].pending).toEqual(["Салом", "хона даркор"]);
  });
});

/**
 * ФОТО ЖДЁТ ТЕКСТ (16.08.2026, по живому диалогу первого дня).
 *
 * Человек прислал скриншот объявления, через двадцать пять секунд дописал
 * «Салом. Ҳами хона арзон мешавад?» — и получил ДВА ответа: первый про скриншот
 * (на языке скриншота, то есть по-русски), второй про свой вопрос. Оба с
 * приветствием. Владелец: «зачем отвечать отдельно на то, что клиент скриншот
 * отправил? Нужно дождаться его сообщения».
 *
 * Причина была в буфере: он умел хранить только строки, поэтому ход с картинкой
 * не ждал вовсе. Теперь ждут все, а файлы копятся вместе с текстом.
 */
describe("Скриншот, потом вопрос — один ответ на оба", () => {
  it("ход с вложением ждёт наравне с текстом", async () => {
    const subscriber = `${SUBSCRIBER}-photo`;
    const native = await fixture.ensureConversation(subscriber);
    await prisma.botConversation.update({ where: { id: native.id }, data: { messages: [], leadDraft: { stage: "chatting" } } });
    callAi.mockResolvedValue({ reply: ["Ин хона дар Сино"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    callAi.mockClear();

    // Вложение без текста — ровно как приходит пересланная публикация: сначала
    // файл, следом словами вопрос. Адрес заведомо недоступен: предмет теста —
    // ожидание, а не скачивание, и падать из-за сети он не должен.
    const results = await Promise.all([
      processMessengerTurn({
        ...fixture.turnInput(subscriber),
        text: "",
        attachments: [{ url: "https://cdn.example/screenshot.jpg", type: "image" }],
      }),
      processMessengerTurn({ ...fixture.turnInput(subscriber), text: "Ҳами хона арзон мешавад?" }),
    ]);

    // Главное: ответ ОДИН. Раньше их было два, и оба здоровались.
    expect(results.filter((r) => r.shouldReply !== false)).toHaveLength(1);

    // Буфер вложений пуст — иначе картинка всплыла бы у чужой реплики позже.
    const conv = await prisma.botConversation.findFirst({
      where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId: subscriber },
      select: { pendingMessages: true, pendingAttachments: true, pendingSince: true },
    });
    expect(conv?.pendingMessages).toEqual([]);
    expect(conv?.pendingAttachments).toEqual([]);
    expect(conv?.pendingSince).toBeNull();
  });
});
