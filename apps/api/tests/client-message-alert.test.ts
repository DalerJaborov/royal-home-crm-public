import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

// Аватар — best-effort сетевой поход к Meta/Telegram: в тестах он не должен ходить в
// реальную сеть. Мокаем саму точку входа lib/clientAvatar.ts, как sendPushToAgent выше.
const fetchAndStoreClientAvatarIfMissing = vi.fn(async () => null as string | null);
vi.mock("../src/lib/clientAvatar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientAvatar.js")>()),
  fetchAndStoreClientAvatarIfMissing,
}));

const { prisma } = await import("../src/db.js");
const { notifyAgentOfClientMessage, resetClientMessageThrottle } = await import("../src/lib/clientMessageAlert.js");

// С 11.08.2026 у уведомлений о сообщениях есть антиспам на пачку: второе сообщение
// того же клиента в течение нескольких минут push не даёт. Здесь проверяется не он,
// а содержимое уведомления, поэтому окно снимается перед каждой проверкой. Сам
// антиспам проверяется отдельно — tests/push-preferences.test.ts.
beforeEach(() => resetClientMessageThrottle());

/** Пуш агенту о сообщении его клиента: раньше уведомление уходило только на
 *  «повторное обращение», обычное сообщение не замечал никто. */

const runId = Date.now();
let agentId: string;
let assignedClientId: string;
let orphanClientId: string;
let assignedShortId: number;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Агент пуша", phone: `+992985${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;

  const assigned = await prisma.client.create({
    data: { fullName: "Клиент с агентом", phone: `+992984${runId}`, source: "WHATSAPP", assignedAgentId: agentId },
  });
  assignedClientId = assigned.id;
  assignedShortId = assigned.shortId;

  orphanClientId = (
    await prisma.client.create({
      data: { fullName: "Клиент без агента", phone: `+992983${runId}`, source: "WHATSAPP", kind: "OTHER" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: [assignedClientId, orphanClientId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Уведомление агента о сообщении клиента", () => {
  it("после оформления заявки пуш ведёт в уже взятый разговор по объекту", async () => {
    const conv = await prisma.botConversation.create({ data: {
      channel: "WHATSAPP", subscriberId: `handled-${runId}`, clientId: assignedClientId,
      propertyChatAgentId: agentId, propertyChatAgentAt: new Date(), messages: [],
    } });
    try {
      sendPushToAgent.mockClear();
      await notifyAgentOfClientMessage(assignedClientId, "Можно посмотреть завтра?", "WHATSAPP", conv.subscriberId, conv.id);
      expect(sendPushToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({ url: `/messages?open=${conv.id}` }));
      await prisma.botConversation.update({ where: { id: conv.id }, data: { clientId: orphanClientId } });
      sendPushToAgent.mockClear();
      resetClientMessageThrottle();
      await notifyAgentOfClientMessage(assignedClientId, "Ещё вопрос", "WHATSAPP", conv.subscriberId, conv.id);
      expect(sendPushToAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({ url: `/clients/${assignedShortId}` }));
    } finally { await prisma.botConversation.delete({ where: { id: conv.id } }); }
  });

  it("уходит назначенному агенту и ведёт в карточку клиента", async () => {
    sendPushToAgent.mockClear();
    await notifyAgentOfClientMessage(assignedClientId, "Здравствуйте, когда посмотрим квартиру?");
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    const [toAgent, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(toAgent).toBe(agentId);
    expect(payload.body).toContain("когда посмотрим");
    expect(payload.url).toBe(`/clients/${assignedShortId}`);
    // Общий тег на клиента: сообщения подряд заменяют друг друга, а не копятся.
    expect(payload.tag).toBe(`client-message-${assignedClientId}`);
  });

  it("вложение без текста тоже уведомляет — иначе его никто не заметит", async () => {
    sendPushToAgent.mockClear();
    await notifyAgentOfClientMessage(assignedClientId, "   ");
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.body).toBe("Прислал вложение");
  });

  it("заголовок — просто имя клиента, без значка канала (эмодзи убраны 19.08.2026)", async () => {
    sendPushToAgent.mockClear();
    await notifyAgentOfClientMessage(assignedClientId, "Привет");
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.title).toBe("Клиент с агентом");
  });

  it("клиент с уже сохранённым avatarUrl несёт его в payload пуша", async () => {
    const withAvatar = await prisma.client.create({
      data: {
        fullName: "Клиент с фото",
        phone: `+992980${runId}`,
        source: "INSTAGRAM",
        assignedAgentId: agentId,
        avatarUrl: "/uploads/avatars/existing.webp",
      },
    });
    try {
      sendPushToAgent.mockClear();
      fetchAndStoreClientAvatarIfMissing.mockClear();
      await notifyAgentOfClientMessage(withAvatar.id, "Привет");
      const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
      expect(payload.avatarUrl).toBe("/uploads/avatars/existing.webp");
      // Настоящее фото главнее нарисованного кружка: подстановка запасного аватара
      // (19.08.2026) не имеет права затереть то, что мы честно скачали у мессенджера.
      expect(payload.avatarUrl).not.toContain("/avatars-fallback/");
      // Аватар уже есть — заново лезть за ним незачем.
      expect(fetchAndStoreClientAvatarIfMissing).not.toHaveBeenCalled();
    } finally {
      await prisma.client.delete({ where: { id: withAvatar.id } });
    }
  });

  it("клиент без avatarUrl, но с известным каналом/id — пробует забрать аватар лениво", async () => {
    fetchAndStoreClientAvatarIfMissing.mockResolvedValueOnce("/uploads/avatars/fresh.webp");
    sendPushToAgent.mockClear();
    fetchAndStoreClientAvatarIfMissing.mockClear();
    await notifyAgentOfClientMessage(assignedClientId, "Привет", "TELEGRAM", "12345");
    expect(fetchAndStoreClientAvatarIfMissing).toHaveBeenCalledWith(assignedClientId, "TELEGRAM", "12345");
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.avatarUrl).toBe("/uploads/avatars/fresh.webp");
  });

  /**
   * ЗАПАСНОЙ АВАТАР (19.08.2026, формат ссылки поправлен 25.08.2026). Раньше этот
   * случай — а он самый частый: WhatsApp фото не отдаёт, у клиента с рук его нет
   * вовсе — оставлял уведомление с общей иконкой приложения, то есть все клиенты в
   * шторке выглядели одинаково. Теперь сервер рисует кружок с тоном по имени и
   * значком «покупатель/продавец», сохраняет PNG файлом в uploads/avatars-fallback
   * и кладёт в payload короткую ссылку — не base64 (тот раздувал тело push сверх
   * лимита Apple/FCM ~4096 байт и ронял доставку 413/400, см. clientAvatarFallback.ts).
   */
  it("без avatarUrl и без канала/id — пуш несёт нарисованный аватар и не ходит в сеть", async () => {
    sendPushToAgent.mockClear();
    fetchAndStoreClientAvatarIfMissing.mockClear();
    await notifyAgentOfClientMessage(assignedClientId, "Привет");
    // Ни канала, ни id собеседника — за настоящим фото идти некуда, и не идём.
    expect(fetchAndStoreClientAvatarIfMissing).not.toHaveBeenCalled();
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.avatarUrl).toMatch(/^\/uploads\/avatars-fallback\//);
  });

  it("канал известен, но фото у мессенджера нет — всё равно нарисованный аватар, а не пустота", async () => {
    sendPushToAgent.mockClear();
    fetchAndStoreClientAvatarIfMissing.mockClear();
    // Ровно случай WhatsApp: сходили и вернулись ни с чем.
    fetchAndStoreClientAvatarIfMissing.mockResolvedValueOnce(null);
    await notifyAgentOfClientMessage(assignedClientId, "Привет", "WHATSAPP", "992900000000");
    expect(fetchAndStoreClientAvatarIfMissing).toHaveBeenCalled();
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.avatarUrl).toMatch(/^\/uploads\/avatars-fallback\//);
  });

  it("покупатель и продавец с одним именем получают ОДНУ И ТУ ЖЕ картинку — значок убран 21.09.2026", async () => {
    // До 21.09.2026 в углу рисовался домик/ключ по Client.kind, и картинки этих
    // двух клиентов различались. Владелец решил значок убрать целиком (агенты
    // путали клиентов по совпавшему значку) — теперь аватар зависит только от
    // имени, и у одинаковых имён картинка обязана совпасть, вид клиента её
    // больше не трогает.
    const name = `Двойник ${runId}`;
    const buyer = await prisma.client.create({
      data: { fullName: name, phone: `+992971${runId}`, source: "WHATSAPP", kind: "BUYER", assignedAgentId: agentId },
    });
    const seller = await prisma.client.create({
      data: { fullName: name, phone: `+992972${runId}`, source: "WHATSAPP", kind: "SELLER", assignedAgentId: agentId },
    });
    try {
      sendPushToAgent.mockClear();
      await notifyAgentOfClientMessage(buyer.id, "Привет");
      await notifyAgentOfClientMessage(seller.id, "Привет");
      const [, first] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
      const [, second] = sendPushToAgent.mock.calls[1] as unknown as [string, Record<string, string>];
      expect(first.avatarUrl).toMatch(/^\/uploads\/avatars-fallback\//);
      expect(second.avatarUrl).toBe(first.avatarUrl);
    } finally {
      await prisma.client.deleteMany({ where: { id: { in: [buyer.id, seller.id] } } });
    }
  });

  it("клиент без агента никого не дёргает", async () => {
    sendPushToAgent.mockClear();
    await notifyAgentOfClientMessage(orphanClientId, "Привет");
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  /**
   * ПРИЗНАК ЖИЗНИ КЛИЕНТА — НЕ ТО ЖЕ, ЧТО РАБОТА С НИМ.
   *
   * Сообщение двигает `lastClientMessageAt` и НЕ трогает `lastContactAt`. Первая
   * редакция правки (12.08.2026) двигала именно `lastContactAt` — и клиент, которому
   * каждый день отвечает один бот, а человек не тронул ни разу, переставал попадать
   * в «забытых» (problemReport) и в кандидаты на остывание (clientAutoStatus). То
   * есть ровно те, ради кого отчёты и заведены, из них и исчезали.
   */
  describe("Входящее сообщение — признак жизни клиента, а не работа агента", () => {
    it("двигает lastClientMessageAt, не трогает lastContactAt и не пишет хронологию", async () => {
      const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await prisma.client.update({
        where: { id: assignedClientId },
        data: { lastContactAt: week, lastClientMessageAt: null },
      });
      const before = await prisma.interaction.count({ where: { clientId: assignedClientId } });

      await notifyAgentOfClientMessage(assignedClientId, "Здравствуйте!");
      await notifyAgentOfClientMessage(assignedClientId, "Ещё вопрос");

      const client = await prisma.client.findUnique({ where: { id: assignedClientId } });
      expect(client!.lastClientMessageAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      // Работы человека не было — отчёты обязаны продолжать видеть неделю тишины.
      expect(client!.lastContactAt.getTime()).toBe(week.getTime());
      // Сорок реплик за разговор утопили бы карточку: отмечаем факт, а не пишем
      // строку хронологии на каждое сообщение.
      expect(await prisma.interaction.count({ where: { clientId: assignedClientId } })).toBe(before);
      // firstContactAt — метка работы АГЕНТА, активность клиента её не ставит.
      expect(client!.firstContactAt).toBeNull();
    });

    it("клиент без агента тоже отмечается: пуша нет, отметка есть", async () => {
      const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await prisma.client.update({
        where: { id: orphanClientId },
        data: { lastContactAt: week, lastClientMessageAt: null },
      });

      await notifyAgentOfClientMessage(orphanClientId, "Привет");

      const client = await prisma.client.findUnique({ where: { id: orphanClientId } });
      expect(client!.lastClientMessageAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(client!.lastContactAt.getTime()).toBe(week.getTime());
    });

    it("клиент в Корзине не оживает и не роняет приём сообщения", async () => {
      const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const deleted = await prisma.client.create({
        data: {
          fullName: "Удалённый клиент",
          phone: `+992982${runId}`,
          source: "WHATSAPP",
          kind: "OTHER",
          lastContactAt: week,
          deletedAt: new Date(),
        },
      });
      try {
        await expect(notifyAgentOfClientMessage(deleted.id, "Привет")).resolves.toBeUndefined();
        const after = await prisma.client.findUnique({ where: { id: deleted.id } });
        expect(after!.lastClientMessageAt).toBeNull();
        expect(after!.lastContactAt.getTime()).toBe(week.getTime());
      } finally {
        await prisma.client.delete({ where: { id: deleted.id } });
      }
    });
  });

  it("несуществующий клиент не роняет обработку входящего", async () => {
    sendPushToAgent.mockClear();
    await expect(notifyAgentOfClientMessage("00000000-0000-0000-0000-000000000000", "Привет")).resolves.toBeUndefined();
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});
