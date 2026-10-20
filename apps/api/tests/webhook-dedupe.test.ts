import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  cleanupProcessedMessages,
  isDuplicateDelivery,
  markProcessedMessageComplete,
  PROCESS_INSTANCE_ID,
  releaseProcessedMessage,
  resetIncompleteProcessedMessages,
} from "../src/lib/webhookDedupe.js";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * Повторная доставка вебхука.
 *
 * Meta шлёт дубль, если не получила 200 достаточно быстро, а 200 мы отдаём до
 * работы ИИ — то есть повтор приходит именно при задержке сети, а не в теории.
 * Без этого замка клиент получал два ответа на одну реплику, а сама реплика
 * ложилась в историю диалога дважды.
 */

const IDS = ["wamid.test.1", "wamid.test.2", "mid.test.1"];

afterEach(async () => {
  // Подхват зависшей доставки пишет в журнал через `void reportStaleDeliveryReclaimed`
  // (webhookDedupe.ts) — не дожидаясь вставки. Если предыдущий тест сам не ждал
  // свою строку, она может приземлиться уже ПОСЛЕ этой очистки и попасть в счётчик
  // следующего теста. Ждём, пока счётчик по тому же фильтру, что и deleteMany,
  // перестанет расти.
  await waitForSettled(() => prisma.errorLog.count({ where: { message: { contains: "wamid.test." } } }));
  await prisma.processedMessage.deleteMany({ where: { messageId: { in: IDS } } });
  await prisma.errorLog.deleteMany({ where: { message: { contains: "wamid.test." } } });
});

describe("Одно сообщение — один ответ", () => {
  it("первая доставка проходит, вторая с тем же идентификатором отсекается", async () => {
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });

  /** Замок держится на уникальном ограничении БД, а не на проверке «есть ли уже»:
   *  два дубля, стартовавшие одновременно, оба увидели бы пустоту. */
  it("одновременные дубли: ровно один проходит", async () => {
    const verdicts = await Promise.all([
      isDuplicateDelivery("WHATSAPP", "wamid.test.2"),
      isDuplicateDelivery("WHATSAPP", "wamid.test.2"),
      isDuplicateDelivery("WHATSAPP", "wamid.test.2"),
    ]);
    expect(verdicts.filter((v) => v === false)).toHaveLength(1);
  });

  it("одинаковый идентификатор в разных каналах — разные сообщения", async () => {
    expect(await isDuplicateDelivery("WHATSAPP", "mid.test.1")).toBe(false);
    expect(await isDuplicateDelivery("INSTAGRAM", "mid.test.1")).toBe(false);
  });

  /** Событие без идентификатора (ответ на историю приходит без mid) обрабатывается
   *  как раньше: придумывать ключ из текста нельзя — «салом» пишут дважды. */
  it("без идентификатора сообщение не считается дублем никогда", async () => {
    expect(await isDuplicateDelivery("INSTAGRAM", undefined)).toBe(false);
    expect(await isDuplicateDelivery("INSTAGRAM", undefined)).toBe(false);
    expect(await isDuplicateDelivery("INSTAGRAM", null)).toBe(false);
  });

  /** Обработка упала после отметки — повтор от Meta не должен отступить перед
   *  сообщением, которое на самом деле осталось без ответа. */
  it("после снятия замка повторная доставка проходит как первая", async () => {
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
    await releaseProcessedMessage("WHATSAPP", "wamid.test.1");
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
  });

  /** Снятие зовётся из catch безусловно — без идентификатора оно обязано быть
   *  тихой пустой операцией, а не падением поверх уже случившейся ошибки. */
  it("снятие замка без идентификатора ничего не делает и не падает", async () => {
    await expect(releaseProcessedMessage("INSTAGRAM", undefined)).resolves.toBeUndefined();
  });
});

/**
 * Обрыв процесса ПОСРЕДИ обработки (рестарт, OOM) — не исключение, catch не
 * зовётся, и до 21.09.2026 отметка «обработка начата» оставалась навсегда:
 * повторная доставка того же сообщения от Meta/Telegram отбрасывалась как
 * дубль, хотя ответа клиент так и не получил (разбор ночи 20→21.09, объект
 * №114). Три состояния теперь различимы: завершено — дубль навсегда; идёт
 * (свежее) — дубль, это гонка параллельных доставок; зависло (старше
 * STALE_AFTER_MS и не завершено) — не дубль, обрабатывается заново, и находка
 * попадает в журнал.
 */
describe("Обрыв на полуслове не должен терять сообщение навсегда", () => {
  const STALE_MS = 10 * 60 * 1000;

  it("завершённая обработка остаётся дублем сколько угодно долго", async () => {
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
    await markProcessedMessageComplete("WHATSAPP", "wamid.test.1");
    // Старим отметку далеко за пределы окна — завершённая обработка не должна
    // открываться заново просто потому что прошло много времени.
    await prisma.processedMessage.update({
      where: { channel_messageId: { channel: "WHATSAPP", messageId: "wamid.test.1" } },
      data: { createdAt: new Date(Date.now() - STALE_MS - 60_000) },
    });
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });

  it("свежая незавершённая отметка всё ещё блокирует повтор (гонка параллельных доставок)", async () => {
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
    // markProcessedMessageComplete не звали — как будто обработка ещё идёт.
    // Отметка совсем свежая, младше STALE_AFTER_MS — это не «зависла», это
    // вторая доставка, пришедшая, пока первая ещё не отработала.
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });

  it("зависшая (начатая, не завершённая) отметка старше окна принимается заново и пишет в журнал один раз", async () => {
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
    // Имитация процесса, умершего посреди обработки: отметка есть, completedAt
    // не проставлен, createdAt старше разумного окна ожидания.
    await prisma.processedMessage.update({
      where: { channel_messageId: { channel: "WHATSAPP", messageId: "wamid.test.1" } },
      data: { createdAt: new Date(Date.now() - STALE_MS - 60_000) },
    });

    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);

    // Подхват зависшей отметки пишет журнал через `void reportStaleDeliveryReclaimed`
    // (webhookDedupe.ts) — не дожидаясь вставки, поэтому голый findFirst сразу после
    // действия гоняется с ней наперегонки. Ждём появления строки.
    const logged = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { source: "meta", message: { contains: "wamid.test.1" } },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись журнала о подхвате зависшей доставки" }
    );
    expect(logged).not.toBeNull();
    expect(logged?.message).toContain("не завершилась");

    // Подхваченная доставка обрабатывается — обязана иметь возможность дойти
    // до нормального завершения, как первая попытка.
    await markProcessedMessageComplete("WHATSAPP", "wamid.test.1");
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });

  /** Одна строка в журнал на СЛУЧАЙ, а не на каждую проверку дедупа. */
  it("повторные проверки той же зависшей отметки не плодят вторую запись в журнале", async () => {
    await isDuplicateDelivery("WHATSAPP", "wamid.test.1");
    await prisma.processedMessage.update({
      where: { channel_messageId: { channel: "WHATSAPP", messageId: "wamid.test.1" } },
      data: { createdAt: new Date(Date.now() - STALE_MS - 60_000) },
    });
    await isDuplicateDelivery("WHATSAPP", "wamid.test.1");
    // Вторая проверка того же (уже подхваченного и свежего теперь) сообщения —
    // обычная гонка, не второй подхват; журнал не должен вырасти повторно.
    await isDuplicateDelivery("WHATSAPP", "wamid.test.1");

    // Подхват пишет журнал в отрыве (см. выше) — ждём, пока счётчик осядет,
    // прежде чем проверять «не выросло второй раз».
    const count = await waitForSettled(() =>
      prisma.errorLog.count({
        where: { source: "meta", message: { contains: "wamid.test.1" } },
      })
    );
    expect(count).toBe(1);
  });
});

/**
 * У КАЖДОЙ ОТМЕТКИ ЕСТЬ ВЛАДЕЛЕЦ (24.09.2026, разбор потери ролика монтажёра
 * при рестарте контейнера). Раньше единственным признаком мёртвого процесса
 * было время (`STALE_AFTER_MS`, 10 минут) — теперь известно точно: если
 * `claimedBy` не совпадает с текущим `PROCESS_INSTANCE_ID`, отметка точно не
 * может принадлежать этому же (живому) процессу прямо сейчас, и ждать
 * `STALE_AFTER_MS` незачем.
 */
describe("Отметка чужого экземпляра подхватывается немедленно", () => {
  it("незавершённая отметка чужого (мёртвого) экземпляра при повторной доставке берётся в работу сразу, не дожидаясь STALE_AFTER_MS", async () => {
    // Имитация: чужой процесс поставил отметку и умер посреди обработки —
    // отметка совсем свежая (моложе STALE_AFTER_MS), но claimedBy принадлежит
    // не этому запуску тестов.
    await prisma.processedMessage.create({
      data: { channel: "WHATSAPP", messageId: "wamid.test.1", claimedBy: "dead-instance-24-09" },
    });

    // Будь владелец тем же (PROCESS_INSTANCE_ID), совсем свежая отметка
    // блокировала бы повтор (см. «свежая незавершённая отметка» выше) — здесь
    // владелец другой, поэтому подхват происходит немедленно.
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);

    // Подхваченная отметка теперь принадлежит этому процессу.
    const row = await prisma.processedMessage.findUnique({
      where: { channel_messageId: { channel: "WHATSAPP", messageId: "wamid.test.1" } },
    });
    expect(row?.claimedBy).toBe(PROCESS_INSTANCE_ID);

    // И пишет в журнал — как и подхват по возрасту, только с другой причиной.
    const logged = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { source: "meta", message: { contains: "wamid.test.1" } },
          orderBy: { createdAt: "desc" },
        }),
      { label: "запись журнала о подхвате отметки другого экземпляра" }
    );
    expect(logged?.message).toContain("другой экземпляр");

    await markProcessedMessageComplete("WHATSAPP", "wamid.test.1");
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });

  it("своя же (текущего процесса) свежая незавершённая отметка по-прежнему ждёт STALE_AFTER_MS — не самоподхват", async () => {
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
    // Вторая проверка сразу же — claimedBy совпадает (это тот же процесс),
    // возраст свежий: обычная гонка параллельных доставок, не мёртвый владелец.
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });
});

/**
 * СБРОС ПРИ СТАРТЕ ПРОЦЕССА (24.09.2026). Незавершённые отметки каналов, которые
 * обслуживает именно ЭТОТ процесс, гарантированно принадлежат мёртвому предку —
 * текущий процесс только что запустился. Вызывается из index.ts (вебхуки) и
 * telegram/poller.ts (long polling), см. докстринг resetIncompleteProcessedMessages.
 */
describe("Незавершённые отметки своего канала сбрасываются при старте", () => {
  it("при старте незавершённые отметки перечисленных каналов удаляются, завершённые и чужих каналов — нет", async () => {
    // Незавершённая отметка мёртвого предка (другой claimedBy) — её и сносит сброс.
    await prisma.processedMessage.create({
      data: { channel: "WHATSAPP", messageId: "wamid.test.1", claimedBy: "dead-process-id" },
    });
    await isDuplicateDelivery("WHATSAPP", "wamid.test.2");
    await markProcessedMessageComplete("WHATSAPP", "wamid.test.2"); // завершена — трогать нельзя
    await isDuplicateDelivery("INSTAGRAM", "mid.test.1"); // другой канал — не в списке сброса

    const removed = await resetIncompleteProcessedMessages(["WHATSAPP"], "meta");
    expect(removed).toBe(1);

    const left = await prisma.processedMessage.findMany({ where: { messageId: { in: IDS } } });
    expect(left.map((r) => r.messageId).sort()).toEqual(["mid.test.1", "wamid.test.2"]);

    // Повторная доставка того же update/сообщения по сброшенному каналу теперь
    // обрабатывается заново, как первая попытка.
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(false);
  });

  it("пустой список каналов — no-op, ничего не сносит и не падает", async () => {
    await isDuplicateDelivery("WHATSAPP", "wamid.test.1");
    const removed = await resetIncompleteProcessedMessages([], "meta");
    expect(removed).toBe(0);
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });

  /**
   * СБРОС НЕ ДОЛЖЕН СНОСИТЬ ОТМЕТКИ ЖИВОГО ПРОЦЕССА (разбор Codex 04.10.2026).
   * Сброс стартует в callback app.listen ПОСЛЕ bind, без await. Если за эти
   * миллисекунды пришла новая доставка (Meta повторяет её после 502 при
   * деплое), isDuplicateDelivery уже поставил отметку ЭТОГО процесса, а сброс
   * её удалял, и повтор той же доставки переставал распознаваться как дубль.
   */
  it("отметка текущего процесса без completedAt сбросом не удаляется", async () => {
    await isDuplicateDelivery("WHATSAPP", "wamid.test.1"); // claimedBy = PROCESS_INSTANCE_ID

    const removed = await resetIncompleteProcessedMessages(["WHATSAPP"], "meta");
    expect(removed).toBe(0);

    const row = await prisma.processedMessage.findUnique({
      where: { channel_messageId: { channel: "WHATSAPP", messageId: "wamid.test.1" } },
    });
    expect(row?.claimedBy).toBe(PROCESS_INSTANCE_ID);
    // Повтор той же доставки по-прежнему распознаётся как дубль.
    expect(await isDuplicateDelivery("WHATSAPP", "wamid.test.1")).toBe(true);
  });

  it("отметка чужого процесса (и безымянная старая) без completedAt удаляется, завершённая не тронута", async () => {
    await prisma.processedMessage.create({
      data: { channel: "WHATSAPP", messageId: "wamid.test.1", claimedBy: "dead-process-id" },
    });
    await prisma.processedMessage.create({ data: { channel: "WHATSAPP", messageId: "wamid.test.2", claimedBy: null } });
    await prisma.processedMessage.create({
      data: { channel: "INSTAGRAM", messageId: "mid.test.1", claimedBy: "dead-process-id", completedAt: new Date() },
    });

    const removed = await resetIncompleteProcessedMessages(["WHATSAPP", "INSTAGRAM"], "meta");
    expect(removed).toBe(2);

    const left = await prisma.processedMessage.findMany({ where: { messageId: { in: IDS } } });
    expect(left.map((r) => r.messageId)).toEqual(["mid.test.1"]);
  });
});

describe("Отметки не копятся вечно", () => {
  it("уборка сносит старые и не трогает свежие", async () => {
    await isDuplicateDelivery("WHATSAPP", "wamid.test.1");
    await prisma.processedMessage.update({
      where: { channel_messageId: { channel: "WHATSAPP", messageId: "wamid.test.1" } },
      data: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    await isDuplicateDelivery("WHATSAPP", "wamid.test.2");

    await cleanupProcessedMessages();

    const left = await prisma.processedMessage.findMany({ where: { messageId: { in: IDS } } });
    expect(left.map((r) => r.messageId)).toEqual(["wamid.test.2"]);
  });
});
