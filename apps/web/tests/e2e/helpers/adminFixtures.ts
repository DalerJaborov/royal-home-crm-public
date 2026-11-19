/**
 * ВЫМЫШЛЕННЫЕ ОТВЕТЫ API для служебных экранов «Нового вида» (пачка admin, 20.11.2026):
 * лента уведомлений, интеграции, состояние функций. В сиде стенда сломанных каналов,
 * критичных уведомлений, предложений объекта и упавших фоновых задач нет — без подмены
 * сторож ширин и кадры видели бы пустые экраны. Имена, номера и тексты придуманы;
 * данных реальных клиентов здесь нет (репозиторий публичный).
 *
 * Строки нарочно длинные: длинное имя, причина и имя переменной сервера обязаны
 * переноситься, а не вылезать за край на 320 px.
 */
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export const notifications = {
  unreadCount: 3,
  hasMore: true,
  pinned: [],
  items: [
    {
      id: "n-approval", agentId: "ag-1", kind: "lead", level: "APPROVAL", count: 1, read: false,
      title: "Новый лид: Фарзона Каримова-Шарифзода, трёхкомнатная в Сино", body: "Ждёт, когда вы примете заявку. Клиент оставил номер на сайте.",
      url: "/clients/900001", createdAt: at(12),
    },
    {
      id: "n-critical", agentId: "ag-1", kind: "message", level: "CRITICAL", count: 4, read: false,
      title: "Клиент ждёт ответа больше часа", body: "Бахтиёр Назаров написал в WhatsApp о показе в субботу, ответа нет уже 74 минуты.",
      url: "/chats", createdAt: at(40),
    },
    {
      id: "n-offer", agentId: "ag-1", kind: "property-offer", level: "INSIGHT", count: 1, read: false,
      title: "Коллега предложил объект для вашего клиента", body: "Двухкомнатная квартира на Рудаки, 68 м², 9 этаж — для клиента Мадины Рахимовой.",
      url: "/properties/700001", createdAt: at(90), offer: { id: "of-1", status: "SENT", answerable: true },
    },
    {
      id: "n-showing", agentId: "ag-1", kind: "showing", level: "OTHER", count: 1, read: true,
      title: "Показ завтра в 11:00", body: "Объект ОБ-512, улица Айни, клиент Сорбон Юсупов.",
      url: "/calendar", createdAt: at(60 * 26),
    },
    {
      id: "n-retired", agentId: "ag-1", kind: "lead", level: "OTHER", count: 1, read: true,
      title: "Лид передан другому агенту", body: "Клиент перешёл к коллеге по решению руководителя.",
      url: "/clients/900002", createdAt: at(60 * 50), retiredAt: at(60 * 49), retiredReason: "Клиент передан Иванову",
    },
  ],
};

export const pendingLeads = {
  items: [{ id: "cl-900001", shortId: 900001, assignedAgentId: "ag-1" }],
  total: 1, page: 1, pageSize: 100,
};

export const integrations = {
  channels: [
    { name: "WhatsApp Business", ok: true, detail: "ключ принят, вебхук отвечает", checkedAt: at(300) },
    { name: "Telegram — бот приёма заявок и служебных уведомлений сотрудникам", ok: false,
      detail: "Telegram ответил 401 Unauthorized: ключ бота отозван или неверен, новые сообщения не принимаются", checkedAt: at(300) },
    { name: "Instagram Direct", ok: null, detail: null, checkedAt: at(300) },
    { name: "Gemini", ok: true, detail: "модель отвечает за 1,2 с", checkedAt: at(300) },
  ],
};

export const functionStatus = {
  generatedAt: at(1),
  summary: { working: 1, preview: 1, off: 1, attention: 1 },
  items: [
    {
      key: "bot-photos", title: "Фото объектов в чате", what: "Бот присылает клиенту фотографии объекта прямо в переписку.",
      group: "bot", state: "off", attention: true,
      reason: "Тумблер в Настройках включён, но сервер не разрешает: переменная BOT_PROPERTY_PHOTOS_DELIVERY_MODE на сервере не задана.",
      detail: null, envNames: ["BOT_PROPERTY_PHOTOS_DELIVERY_MODE"], settingsTab: "bot",
      crons: [{ name: "bot-pause-watch", lastRunAt: at(5), lastOkAt: at(5), lastError: null, health: "ok" }],
      lastError: { at: at(30), message: "Meta Graph API: (#131030) Recipient phone number not in allowed list — сообщение не доставлено" },
    },
    {
      key: "narration", title: "Автоозвучка роликов", what: "Голос за кадром для роликов объектов без монтажёра.",
      group: "video", state: "preview", attention: false,
      reason: "Идёт только для проверки: озвучка готовится, но монтажёру и наружу не уходит.",
      detail: "Последняя озвучка — ОБ-512, 38 секунд.", envNames: [], settingsTab: "system",
      crons: [{ name: "narration-auto-flow", lastRunAt: at(200), lastOkAt: at(600), lastError: "ElevenLabs: 429 Too Many Requests", health: "failing" }],
      lastError: null,
    },
    {
      key: "owner-reports", title: "Отчёты собственникам", what: "Раз в месяц собственник получает отчёт о показах.",
      group: "video", state: "working", attention: false, reason: "Работает: отчёты уходят по расписанию.",
      detail: null, envNames: [], settingsTab: null, crons: [], lastError: null,
    },
  ],
  crons: [
    { name: "owner-report-delivery", lastRunAt: at(60), lastOkAt: at(60), lastError: null, health: "ok" },
    { name: "market-weekly-crawl", lastRunAt: at(60 * 24 * 9), lastOkAt: at(60 * 24 * 9), lastError: null, health: "stale" },
    { name: "a-very-long-background-task-name-without-human-title", lastRunAt: null, lastOkAt: null, lastError: null, health: "never" },
  ],
};
