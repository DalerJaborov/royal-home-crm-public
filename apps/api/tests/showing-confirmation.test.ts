import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Подтверждение показа обеими сторонами.
 *
 * Что здесь защищается в первую очередь — не «работает ли отправка», а правило,
 * которое дороже всего сломать: МОЛЧАНИЕ КЛИЕНТА НЕ ОТМЕНЯЕТ ПОКАЗ. Половина
 * людей не отвечает на такие сообщения и приходит; автоотмена по тишине потеряла
 * бы живых клиентов. Плюс кириллица в разборе ответа (`\b` с ней не работает),
 * ночная тишина и идемпотентность повторного прогона джоба.
 */

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

const deliverToConversation = vi.fn(async () => ({ ok: true, masked: false, pausedUntil: new Date() }));
const deliveryTarget = {
  kind: "bot" as const,
  id: "conv",
  channel: "WHATSAPP",
  subscriberId: "sub",
};
const findClientDeliveryTarget = vi.fn(async () => deliveryTarget);
const findClientDeliveryTargets = vi.fn(async (clientIds: string[]) => new Map(clientIds.map((id) => [id, deliveryTarget])));
vi.mock("../src/lib/conversationDelivery.js", () => ({ deliverToConversation, findClientDeliveryTarget, findClientDeliveryTargets }));

const { prisma } = await import("../src/db.js");
const { classifyShowingReply } = await import("../src/lib/showingReply.js");
const { applyShowingReply } = await import("../src/lib/showingConfirmation.js");
const { confirmationDueAt, notifyUnconfirmedShowings, sendShowingConfirmationRequests } = await import(
  "../src/lib/meetingReminders.js"
);

const runId = Date.now();
let districtId: string;
let agentId: string;
let clientId: string;
let propertyId: string;

/** «Настенное» время Душанбе → реальный момент (контейнер и тесты живут в UTC). */
const DUSHANBE_OFFSET_MS = 5 * 60 * 60 * 1000;
function dushanbe(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, day, hour, minute, 0) - DUSHANBE_OFFSET_MS);
}

async function makeShowing(nextActionDate: Date, extra: Record<string, unknown> = {}) {
  return prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SHOWING",
      propertyId,
      notes: `Показ ${runId}`,
      nextAction: "Показ объекта",
      nextActionDate,
      ...extra,
    },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-подтв-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент подтверждений", phone: `+992953${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент подтверждения ${runId}`,
        phone: `+992951${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект подтверждения ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
      },
    })
  ).id;

  // Автосообщения клиенту с просьбой подтвердить показ по умолчанию ВЫКЛЮЧЕНЫ с
  // 18.08.2026 (владелец: «клиенту такие сообщения не должны приходить») — этот
  // файл проверяет саму механику отправки/разбора ответа, поэтому включаем
  // явно на время теста, а не полагаемся на дефолт.
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { askClientsToConfirmShowings: true },
    create: { id: "singleton", askClientsToConfirmShowings: true },
  });
});

beforeEach(async () => {
  sendPushToAgent.mockClear();
  deliverToConversation.mockClear();
  findClientDeliveryTarget.mockClear();
  findClientDeliveryTargets.mockClear();
  // Каждый сценарий начинает с чистого листа: показы разных тестов иначе
  // попадают в выборку соседа (джобы смотрят на всю базу, а не на «свой» показ).
  await prisma.interaction.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { askClientsToConfirmShowings: false } });
  await prisma.$disconnect();
});

describe("Разбор ответа клиента", () => {
  // Главные грабли: `\b` в JS не работает с кириллицей, и правило вида /\bда\b/
  // не срабатывает НИКОГДА. Поэтому кириллица и таджикские буквы проверяются явно.
  it.each(["да", "Да!", "ДА", "ок", "Хорошо", "конечно", "приду", "буду", "👍"])(
    "русское согласие «%s» засчитывается",
    (text) => expect(classifyShowingReply(text)).toBe("yes")
  );

  it.each(["ҳа", "Ҳа", "бале", "оре", "хуб", "албатта", "меоям", "майлаш", "тасдиқ мекунам"])(
    "таджикское согласие «%s» засчитывается",
    (text) => expect(classifyShowingReply(text)).toBe("yes")
  );

  it.each(["не смогу", "Не получится", "не приду", "отмените пожалуйста", "давайте перенесём"])(
    "русский отказ «%s» распознан",
    (text) => expect(classifyShowingReply(text)).toBe("no")
  );

  it.each(["наметавонам", "намеоям", "бекор кунед"])("таджикский отказ «%s» распознан", (text) =>
    expect(classifyShowingReply(text)).toBe("no")
  );

  it("отказ сильнее согласия в одном сообщении", () => {
    expect(classifyShowingReply("Да, но сегодня не смогу")).toBe("no");
  });

  it("«нет проблем» — это согласие, а не отказ", () => {
    expect(classifyShowingReply("Нет проблем, приду")).toBe("yes");
  });

  it("посторонний ответ не отказ — человек на связи", () => {
    expect(classifyShowingReply("А во сколько именно?")).toBe("unclear");
  });
});

describe("Просьба подтвердить показ", () => {
  it("уходит клиенту за несколько часов до показа и ровно один раз", async () => {
    const now = dushanbe(10, 11); // 11:00 по Душанбе — рабочее дневное время
    const showing = await makeShowing(dushanbe(10, 15)); // показ в 15:00

    expect(await sendShowingConfirmationRequests(now)).toBe(1);
    expect(deliverToConversation).toHaveBeenCalledTimes(1);

    const [, text] = deliverToConversation.mock.calls[0] as unknown as [unknown, string];
    // Формулировка — часть требования: просим подтвердить приход, а НЕ спрашиваем
    // «вы не передумали?»: второе само подсказывает передумать.
    expect(text).toContain("Подтвердите");
    expect(text).not.toContain("передумал");
    expect(text).toContain("ҳа"); // таджикская строка тоже уходит

    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(after?.confirmAskedAt).not.toBeNull();
    expect(after?.remindersSent).toContain("confirm-ask");

    // Повторный прогон джоба второго сообщения не шлёт — идемпотентность.
    expect(await sendShowingConfirmationRequests(now)).toBe(0);
    expect(deliverToConversation).toHaveBeenCalledTimes(1);
  });

  /**
   * №172 (ночная проверка 24.09): отметка «спросили» ставилась ПОСЛЕ доставки.
   * Рестарт процесса (каждый выкат) между отправкой и отметкой — и после
   * рестарта клиент получал вторую просьбу. Теперь отметка ставится условно ДО
   * отправки (кто поставил — тот шлёт), а не дошло — снимается, и следующий
   * проход пробует снова, как и раньше.
   */
  it("в момент отправки показ уже отмечен «спросили»; не дошло — отметка снята", async () => {
    const now = dushanbe(10, 11);
    const showing = await makeShowing(dushanbe(10, 15));
    let askedDuringSend: Date | null = null;
    deliverToConversation.mockImplementationOnce(async () => {
      askedDuringSend = (await prisma.interaction.findUnique({ where: { id: showing.id } }))?.confirmAskedAt ?? null;
      return { ok: false, error: "канал недоступен" } as never;
    });

    expect(await sendShowingConfirmationRequests(now)).toBe(0);
    expect(askedDuringSend).not.toBeNull();
    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } });
    expect(after.confirmAskedAt).toBeNull();
    expect(after.remindersSent).not.toContain("confirm-ask");

    // Следующий проход пробует снова и на этот раз доставляет.
    expect(await sendShowingConfirmationRequests(now)).toBe(1);
    expect((await prisma.interaction.findUniqueOrThrow({ where: { id: showing.id } })).remindersSent).toEqual(["confirm-ask"]);
  });

  /**
   * ШАБЛОН — ТОЖЕ СООБЩЕНИЕ ОТ БОТА (разбор живых переписок 22.08.2026).
   *
   * Клиент видит одно сообщение от компании и не знает, где кончается модель и
   * начинается зашитый текст. Этот шаблон нарушал сразу три правила бота и давал
   * большинство срабатываний по всему проду: 30 длинных тире и 13 повторных
   * приветствий. Правила проверяются здесь, а не глазами: текст правят редко, и
   * следующая правка обязана споткнуться об этот тест.
   */
  it("шаблон не нарушает правил бота: без тире, без ника, без второго приветствия", async () => {
    await makeShowing(dushanbe(10, 15));
    await sendShowingConfirmationRequests(dushanbe(10, 11));

    const [, text] = deliverToConversation.mock.calls[0] as unknown as [unknown, string];
    // Правило 11: живой человек в мессенджере не печатает «—» и «–».
    expect(text).not.toMatch(/[—–]/);
    // Правило 10: обращение по нику читается как рассылка. Имя клиента в этом
    // тесте («Клиент подтверждения 17…») настоящим не считается — цифры в нём.
    expect(text).not.toContain("@");
    expect(text).not.toContain("Клиент подтверждения");
    // Напоминание прилетает в СЕРЕДИНУ идущей переписки: здороваться тут нечем,
    // ни по-русски, ни по-таджикски.
    expect(text).not.toMatch(/здравствуйте|салом|ассалом/i);
    // Суть при этом на месте, и обе строки тоже.
    expect(text).toContain("15:00");
    expect(text).toContain("Намоиши хона");
  });

  /**
   * «ПОКАЗ ЗАВТРА В 00:00» — ЖИВОЕ СООБЩЕНИЕ ИЗ ПРОДА 22.08.2026.
   *
   * Полночь взялась не из часового пояса: ровно 00:00 по Душанбе в базе и лежало.
   * Так фронтенд записывает дату, у которой время не заполнили
   * (dushanbeInputToIso подставляет "00:00" по местному времени), а hasExactTime
   * знает только другую запись «без часа» — полночь UTC. Показов в полночь не
   * бывает: даже бот вправе назначать их лишь с 09:00 до 20:00.
   */
  it("показ без настоящего часа: пишем «завтра», а не «завтра в 00:00»", async () => {
    await makeShowing(dushanbe(11, 0));
    expect(await sendShowingConfirmationRequests(dushanbe(10, 19))).toBe(1);

    const [, text] = deliverToConversation.mock.calls[0] as unknown as [unknown, string];
    expect(text).not.toContain("00:00");
    expect(text).toContain("показ завтра");
    expect(text).toContain("Намоиши хона пагоҳ.");
  });

  it("ночью клиенту не пишет", async () => {
    const showing = await makeShowing(dushanbe(11, 7)); // показ в 07:00
    // 03:00 по Душанбе — «за 4 часа» формально наступило, но это ночь.
    expect(await sendShowingConfirmationRequests(dushanbe(11, 3))).toBe(0);
    expect(deliverToConversation).not.toHaveBeenCalled();
    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(after?.confirmAskedAt).toBeNull();
  });

  it("ранний показ спрашивается накануне вечером, а не в 05 утра", () => {
    // Показ в 09:00 → «за 4 часа» это 05:00, ночь. Правило переносит НАЗАД,
    // на 19:00 предыдущего дня: вечером человек с телефоном и планирует завтра.
    expect(confirmationDueAt(dushanbe(12, 9)).getTime()).toBe(dushanbe(11, 19).getTime());
    // Обычный дневной показ остаётся «за 4 часа».
    expect(confirmationDueAt(dushanbe(12, 15)).getTime()).toBe(dushanbe(12, 11).getTime());
  });

  it("накануне вечером просьба о раннем показе действительно уходит", async () => {
    await makeShowing(dushanbe(12, 9));
    expect(await sendShowingConfirmationRequests(dushanbe(11, 19))).toBe(1);
  });

  it("до срока не торопится", async () => {
    await makeShowing(dushanbe(10, 18));
    expect(await sendShowingConfirmationRequests(dushanbe(10, 11))).toBe(0);
  });
});

/**
 * ДВА ТУМБЛЕРА НА ОДНО ПОВЕДЕНИЕ (аудит настроек 28.09.2026).
 *
 * Экран обещает ровно это: просьба уходит, только когда включены ОБА —
 * «Просить клиента подтвердить показ» («Лиды») и «Просить подтверждение встречи»
 * («Бот»), — а «Назначать показы» здесь ни при чём (прежнее предупреждение на
 * вкладке «Бот» говорило обратное). Тексты подсказок в
 * apps/web/src/lib/settingsDependencies.ts держатся на этих проверках.
 */
describe("Какие настройки держат просьбу подтвердить", () => {
  let saved: { askClientsToConfirmShowings: boolean; botCanConfirmShowings: boolean; botCanBookShowings: boolean };

  beforeAll(async () => {
    const s = await prisma.settings.findUniqueOrThrow({
      where: { id: "singleton" },
      select: { askClientsToConfirmShowings: true, botCanConfirmShowings: true, botCanBookShowings: true },
    });
    saved = s;
  });

  afterAll(async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { botCanConfirmShowings: saved.botCanConfirmShowings, botCanBookShowings: saved.botCanBookShowings },
    });
  });

  async function setSwitches(data: { askClientsToConfirmShowings: boolean; botCanConfirmShowings: boolean; botCanBookShowings: boolean }) {
    await prisma.settings.update({ where: { id: "singleton" }, data });
  }

  it("выключенный «Назначать показы» просьбу НЕ останавливает", async () => {
    await setSwitches({ askClientsToConfirmShowings: true, botCanConfirmShowings: true, botCanBookShowings: false });
    await makeShowing(dushanbe(10, 15));
    expect(await sendShowingConfirmationRequests(dushanbe(10, 11))).toBe(1);
  });

  it("выключен тумблер на вкладке «Бот» — просьбы нет", async () => {
    await setSwitches({ askClientsToConfirmShowings: true, botCanConfirmShowings: false, botCanBookShowings: true });
    await makeShowing(dushanbe(10, 15));
    expect(await sendShowingConfirmationRequests(dushanbe(10, 11))).toBe(0);
  });

  it("выключен тумблер на вкладке «Лиды» — просьбы нет", async () => {
    await setSwitches({ askClientsToConfirmShowings: false, botCanConfirmShowings: true, botCanBookShowings: true });
    await makeShowing(dushanbe(10, 15));
    expect(await sendShowingConfirmationRequests(dushanbe(10, 11))).toBe(0);
    // Остальные сценарии файла рассчитаны на включённый рубильник «Лидов».
    await setSwitches({ askClientsToConfirmShowings: true, botCanConfirmShowings: true, botCanBookShowings: true });
  });

  it("граница «показ раньше 13:00 — спрашиваем накануне в 19:00» из подсказки", () => {
    expect(confirmationDueAt(dushanbe(12, 13)).getTime()).toBe(dushanbe(12, 9).getTime());
    expect(confirmationDueAt(dushanbe(12, 12, 59)).getTime()).toBe(dushanbe(11, 19).getTime());
  });
});

describe("Ответ клиента", () => {
  it("«ҳа» по-таджикски засчитывается как подтверждение", async () => {
    const showing = await makeShowing(new Date(Date.now() + 3 * 60 * 60 * 1000), {
      confirmAskedAt: new Date(Date.now() - 60 * 60 * 1000),
      remindersSent: ["confirm-ask"],
    });

    await applyShowingReply(clientId, "Ҳа, меоем");

    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(after?.confirmedAt).not.toBeNull();
    expect(after?.declinedAt).toBeNull();
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
  });

  it("посторонний ответ тоже считается подтверждением — человек на связи", async () => {
    const showing = await makeShowing(new Date(Date.now() + 3 * 60 * 60 * 1000), {
      confirmAskedAt: new Date(Date.now() - 60 * 60 * 1000),
      remindersSent: ["confirm-ask"],
    });

    await applyShowingReply(clientId, "А адрес какой?");

    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(after?.confirmedAt).not.toBeNull();
  });

  it("явный отказ отмечается, но показ НЕ отменяется", async () => {
    const showing = await makeShowing(new Date(Date.now() + 3 * 60 * 60 * 1000), {
      confirmAskedAt: new Date(Date.now() - 60 * 60 * 1000),
      remindersSent: ["confirm-ask"],
    });

    await applyShowingReply(clientId, "Наметавонам, бекор кунед");

    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(after?.declinedAt).not.toBeNull();
    expect(after?.confirmedAt).toBeNull();
    // Ключевое: решение за агентом. Система не трогает ни время, ни отметку
    // выполнения — она только сообщает.
    expect(after?.completedAt).toBeNull();
    expect(after?.nextActionDate).not.toBeNull();
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.title).toContain("не сможет");
  });

  /**
   * ЖИВОЙ КЛАСС 27.08.2026 (сплошная охота). applyShowingReply вызывается из
   * clientMessageAlert РАНЬШЕ, чем Telegram успевает отвязать диалог от
   * удалённой карточки: первое же сообщение человека после удаления проходило
   * сюда со старым clientId и подтверждало показ клиента, которого в CRM уже нет.
   */
  it("клиент в Корзине — ответ показ не подтверждает и push не уходит", async () => {
    const showing = await makeShowing(new Date(Date.now() + 3 * 60 * 60 * 1000), {
      confirmAskedAt: new Date(Date.now() - 60 * 60 * 1000),
      remindersSent: ["confirm-ask"],
    });
    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
    sendPushToAgent.mockClear();

    await applyShowingReply(clientId, "Ҳа, меоем");

    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(after?.confirmedAt).toBeNull();
    expect(sendPushToAgent).not.toHaveBeenCalled();

    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: null } });
  });

  it("сообщение до просьбы подтвердить ничего не засчитывает", async () => {
    const showing = await makeShowing(new Date(Date.now() + 3 * 60 * 60 * 1000));
    await applyShowingReply(clientId, "да");
    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    expect(after?.confirmedAt).toBeNull();
  });
});

describe("Молчание клиента", () => {
  it("не отменяет показ, а поднимает агента позвонить", async () => {
    const now = dushanbe(10, 12);
    const showing = await makeShowing(dushanbe(10, 14), {
      confirmAskedAt: dushanbe(10, 10),
      remindersSent: ["confirm-ask"],
    });

    expect(await notifyUnconfirmedShowings(now)).toBe(1);
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.title).toContain("не подтвердил");

    const after = await prisma.interaction.findUnique({ where: { id: showing.id } });
    // Самое важное утверждение всего файла: тишина ничего не отменила.
    expect(after?.declinedAt).toBeNull();
    expect(after?.completedAt).toBeNull();
    expect(after?.nextActionDate?.getTime()).toBe(dushanbe(10, 14).getTime());
    expect(after?.remindersSent).toContain("confirm-nudge");

    // Повторный прогон джоба второй раз агента не дёргает.
    sendPushToAgent.mockClear();
    expect(await notifyUnconfirmedShowings(now)).toBe(0);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("подтверждённый показ агента не беспокоит", async () => {
    await makeShowing(dushanbe(10, 14), {
      confirmAskedAt: dushanbe(10, 10),
      confirmedAt: dushanbe(10, 11),
      remindersSent: ["confirm-ask"],
    });
    expect(await notifyUnconfirmedShowings(dushanbe(10, 12))).toBe(0);
  });

  it("не дёргает агента, если клиенту ещё не успели написать", async () => {
    await makeShowing(dushanbe(10, 14));
    expect(await notifyUnconfirmedShowings(dushanbe(10, 12))).toBe(0);
  });

  it("не даёт сигнал раньше, чем клиент успел ответить", async () => {
    await makeShowing(dushanbe(10, 14), {
      confirmAskedAt: dushanbe(10, 11, 50), // просьба ушла 10 минут назад
      remindersSent: ["confirm-ask"],
    });
    expect(await notifyUnconfirmedShowings(dushanbe(10, 12))).toBe(0);
  });

  it("ночью агента не будит", async () => {
    await makeShowing(dushanbe(11, 6), {
      confirmAskedAt: dushanbe(10, 19),
      remindersSent: ["confirm-ask"],
    });
    expect(await notifyUnconfirmedShowings(dushanbe(11, 4))).toBe(0);
  });
});
