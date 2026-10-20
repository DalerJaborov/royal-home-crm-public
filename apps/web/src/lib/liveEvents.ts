import type { QueryClient } from "@tanstack/react-query";
import { LIVE_EVENT_TYPES, type LiveEvent, type LiveEventType } from "@royal-home/shared";
import { api } from "./api";

/**
 * ЖИВЫЕ ДАННЫЕ БЕЗ ПЕРЕЗАГРУЗКИ (12.09.2026) — одно соединение на вкладку.
 *
 * До этого «живость» держалась только на таймерах: общий `refetchInterval:
 * 25_000` плюс 56 точечных переопределений. Теперь сервер сам говорит «в
 * диалоге X новое сообщение», а вкладка перезапрашивает ИМЕННО те ключи,
 * которых это касается.
 *
 * ⚠️ ОПРОС НЕ УДАЛЁН, А РАСТЯНУТ. Поток может не дойти: прокси режет
 * долгоживущие соединения, телефон засыпает, сеть моргает. Поэтому таймер
 * остаётся запасным путём — просто редким. Если однажды поток отключат флагом
 * LIVE_EVENTS=0, CRM продолжит обновляться сама, только медленнее.
 *
 * В потоке НЕТ содержимого: приходят идентификаторы и признаки, данные вкладка
 * берёт обычным роутом со своей проверкой прав.
 */

/**
 * Какие ключи TanStack Query протухают от какого события. Префиксные, не точные.
 *
 * Экспортируется РАДИ ТЕСТА (src/lib/__tests__/liveEvents.test.ts): тип
 * Record<LiveEventType, ...> ловит забытую строку на сборке, но не ловит пустой
 * список — а событие с пустым списком тихо не делает ничего.
 */
export const INVALIDATION: Record<LiveEventType, string[][]> = {
  // Новый лид ждёт принятия: окно приёма живёт на useClients({pendingAcceptance}).
  "lead.pending": [["clients"], ["counters"], ["mission-control"], ["dashboard-summary"]],
  // Принят — предложение обязано погаснуть у всех, кто его видел.
  "lead.accepted": [["clients"], ["client"], ["counters"], ["mission-control"], ["dashboard-summary"]],
  "message.new": [["conversations"], ["counters"]],
  "conversation.updated": [["conversations"], ["counters"]],
  "deal.updated": [["deals"], ["counters"], ["mission-control"], ["dashboard-summary"]],
  "pult.snapshot": [["mission-control"], ["mission-control-ticker"]],
  "notification.new": [["notifications"], ["counters"]],
  // Звонок: журнал входящих, лента и сводки читаются с одних и тех же строк.
  // Пульт телефонии (["telephony-dashboard"]) сюда НЕ входит намеренно — там
  // живут регистрации аппаратов на АТС и бегущий таймер разговора, то есть
  // данные, которые меняются вне CRM и о которых сервер сигнала не даёт.
  "call.updated": [
    ["incoming-calls"],
    ["calls"],
    ["call-feed"],
    ["call-insights"],
    ["calls-summary"],
    ["counters"],
    ["mission-control"],
  ],
  // Исполнитель или статус клиента: списки, карточка, надзор и всё, что считает
  // клиентов по агентам.
  // Ночной аудит 24.09.2026 (№12): без этих четырёх ключей окна «Потеряны»,
  // «Отложены», «Корзина» и предложения реактивации не гасли по живому событию
  // и обновлялись только общим таймером (60 с) — сравнение идёт по первому
  // элементу ключа, а не по имени хука.
  "client.updated": [
    ["clients"],
    ["client"],
    ["counters"],
    ["dashboard-team-live"],
    ["team"],
    ["oversight"],
    ["mission-control"],
    ["dashboard-summary"],
    ["report-waiting-now"],
    ["me", "summaries"],
    ["clients-lost"],
    ["clients-deferred"],
    ["clients-trash"],
    ["reactivation-offers"],
  ],
  // ["marketing"]: очереди передачи видео и редактора читают те же объекты (№252) —
  // правка объекта на другом устройстве иначе не обновляла их до ручного захода.
  "property.updated": [["properties"], ["property"], ["marketing"], ["counters"], ["mission-control"], ["oversight"]],
  // Заявки на рассмотрение: у трёх механизмов один зритель и один экран.
  "request.updated": [
    ["delete-requests"],
    ["client-delete-request"],
    ["property-delete-requests"],
    ["property-delete-request"],
    // Заявки агента на изменение опубликованного объекта (07.10.2026): тот же зритель.
    ["property-change-requests"],
    ["property-count-disputes"],
    ["client-property-count-dispute"],
    ["counters"],
    ["mission-control"],
  ],
};

/**
 * Что перезапросить, когда вкладка вернулась из фона: за время сна события
 * прошли мимо (соединение было закрыто), и какие именно — узнать неоткуда.
 * Поэтому один раз гасим всё, чего поток вообще касается.
 */
const ON_RESUME: string[][] = [
  ["clients"],
  ["conversations"],
  ["deals"],
  ["counters"],
  ["notifications"],
  ["mission-control"],
  ["dashboard-summary"],
  ["properties"],
  ["incoming-calls"],
  ["calls"],
  ["oversight"],
  ["delete-requests"],
  ["property-delete-requests"],
  ["property-change-requests"],
  ["property-count-disputes"],
  // Ночной аудит 24.09.2026 (№12): те же четыре семейства, что в client.updated
  // выше, — иначе возврат из фона их не гасил.
  ["clients-lost"],
  ["clients-deferred"],
  ["clients-trash"],
  ["reactivation-offers"],
  ["team"],
];

/** Пауза перед переподключением: 1с → 30с, дальше потолок. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
/** Пачка инвалидаций: десять событий подряд не должны дать десять волн запросов.
 *
 * 19.09.2026: было 250 мс, то есть до четырёх волн в секунду. Волна — это не
 * один запрос, а перезапрос ВСЕХ открытых экраном семейств: на чатах три, на
 * пульте до шести. При потоке входящих это десятки запросов в секунду от одной
 * вкладки, и общий лимитер (600 на пять минут, apps/api/src/app.ts) выбирался
 * за минуту — дальше 429 на случайных разделах. Секунда задержки в списке
 * незаметна, а всплеск срезает вчетверо. */
const COALESCE_MS = 1_000;

/** Счётчики и сводки гасятся почти при каждом событии (lead.pending,
 *  lead.accepted, deal.updated, notification.new, message.new — см.
 *  INVALIDATION выше), а при потоке входящих таких событий десятки в
 *  минуту. Обычный COALESCE_MS (1с) собирает только соседние события в
 *  одну волну, а не редкие подряд — 22.09.2026: это была ощутимая доля
 *  429-шторма. Эти три семейства не обязаны быть секундными: цифра на
 *  бейдже, отстающая на несколько секунд, никого не смущает. Задний
 *  фронт гарантирован — раз в 10с прилетит, даже если события идут
 *  непрерывно. Остальные ключи остаются на обычном COALESCE_MS. */
const HOT_THROTTLE_MS = 10_000;
/** Сколько последних id событий помнить для отсева повторов. */
const SEEN_IDS_MAX = 500;
const HOT_KEYS = new Set(["counters", "dashboard-summary", "mission-control"]);

/** Возврат на вкладку гасит 15 семейств сразу — но не чаще, чем раз в минуту, и
 *  только если вкладка была скрыта дольше этого порога.
 *
 * На телефоне `visibilitychange` срабатывает на каждое переключение приложения,
 * на шторку уведомлений, на блокировку экрана. Без порога каждое такое касание
 * стоило десяток запросов, а к ним react-query добавлял свой перезапрос по
 * фокусу — те же запросы вторым слоем. Данные при этом и так живые: их держит
 * сам поток событий, ради которого этот модуль и написан. */
const RESUME_MIN_HIDDEN_MS = 20_000;
const RESUME_MIN_INTERVAL_MS = 60_000;

type Manager = {
  stop: () => void;
};

let current: Manager | null = null;

function isLiveEventType(value: string): value is LiveEventType {
  return (LIVE_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Запустить поток. Идемпотентно: второй вызов возвращает уже работающий
 * менеджер, потому что соединение на вкладку должно быть ОДНО (у браузера
 * жёсткий лимит одновременных HTTP/1.1-соединений на домен — шесть; два-три
 * вечных потока съели бы половину, и обычные запросы встали бы в очередь).
 */
export function startLiveEvents(queryClient: QueryClient): Manager {
  if (current) return current;

  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  /** Идёт получение билета. Без этого «сеть вернулась» и «вкладка показалась»,
   *  прилетев вместе, открыли бы ДВА потока: source присваивается только после
   *  await, и вторая попытка видит его пустым. */
  let connecting = false;
  /**
   * Недавно виденные id (порядок вставки, не больше SEEN_IDS_MAX). События приходят
   * не по порядку: свои сервер раздаёт мгновенно, чужие (воркера) обходом хвоста
   * раз в секунду, поэтому id101 может прийти после id102. Монотонный «последний id»
   * отбрасывал такое запоздавшее (аудит 04.10.2026, WEB-09): отбрасываем только
   * точные повторы.
   */
  const seenIds = new Set<number>();
  /** Когда вкладку свернули и когда в последний раз гасили ON_RESUME — см. пороги выше. */
  let hiddenAt: number | null = null;
  let lastResumeAt = 0;
  const pending = new Set<string>();
  const pendingHot = new Set<string>();
  let hotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHotRunAt = 0;

  const runInvalidation = (keys: string[][]) => {
    for (const queryKey of keys) {
      // exact: false — ключи в CRM составные (["clients", filters]), гасить
      // надо всё семейство. refetchType по умолчанию "active": невидимые
      // экраны помечаются протухшими и перезапросятся при открытии, а не
      // прямо сейчас — иначе одно событие дёргало бы сорок запросов.
      void queryClient.invalidateQueries({ queryKey, exact: false });
    }
  };

  const flushHot = () => {
    hotTimer = null;
    lastHotRunAt = Date.now();
    const keys = [...pendingHot].map((k) => JSON.parse(k) as string[]);
    pendingHot.clear();
    runInvalidation(keys);
  };

  const invalidateSoon = (keys: string[][]) => {
    const normalKeys = keys.filter((key) => !HOT_KEYS.has(key[0]));
    const hotKeys = keys.filter((key) => HOT_KEYS.has(key[0]));

    if (hotKeys.length > 0) {
      for (const key of hotKeys) pendingHot.add(JSON.stringify(key));
      if (!hotTimer) {
        const elapsed = Date.now() - lastHotRunAt;
        const delay = Math.max(0, HOT_THROTTLE_MS - elapsed);
        hotTimer = setTimeout(flushHot, delay);
      }
    }

    if (normalKeys.length === 0) return;
    for (const key of normalKeys) pending.add(JSON.stringify(key));
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      const keys = [...pending].map((k) => JSON.parse(k) as string[]);
      pending.clear();
      runInvalidation(keys);
    }, COALESCE_MS);
  };

  const disconnect = () => {
    if (source) {
      source.close();
      source = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    if (document.hidden || navigator.onLine === false) return; // проснёмся по событию
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    // Разброс до 30%: десять вкладок после обрыва не должны ломиться разом.
    const delay = base + Math.floor(Math.random() * base * 0.3);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (stopped || source || connecting || document.hidden || navigator.onLine === false) return;
    connecting = true;
    let ticket: string;
    try {
      // Билет вместо заголовка: EventSource не умеет Authorization (см.
      // apps/api/src/routes/events.ts). Одноразовый, живёт минуту.
      const res = await api<{ ticket: string }>("/events/ticket", { method: "POST" });
      ticket = res.ticket;
    } catch {
      // Поток выключен флагом, нет сети, истекла сессия — всё это не повод
      // шуметь: опрос по таймеру продолжает работать.
      connecting = false;
      scheduleReconnect();
      return;
    }
    connecting = false;
    if (stopped || document.hidden) return;

    const es = new EventSource(`/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
    source = es;

    es.onopen = () => {
      attempt = 0;
    };

    for (const type of LIVE_EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        const data = (ev as MessageEvent<string>).data;
        let event: LiveEvent;
        try {
          event = JSON.parse(data) as LiveEvent;
        } catch {
          return;
        }
        // Повтор того же id (мгновенная доставка плюс обход хвоста на сервере
        // разведены по origin, но переподключение могло принести край заново).
        if (typeof event.id === "number") {
          if (seenIds.has(event.id)) return;
          seenIds.add(event.id);
          if (seenIds.size > SEEN_IDS_MAX) seenIds.delete(seenIds.values().next().value as number);
        }
        if (!isLiveEventType(event.type)) return;
        invalidateSoon(INVALIDATION[event.type]);
      });
    }

    es.onerror = () => {
      // EventSource переподключается сам, но своим расписанием и со старым
      // билетом, который уже погашен, — то есть вечные 401. Рулим сами.
      disconnect();
      scheduleReconnect();
    };
  };

  const onVisibility = () => {
    if (document.hidden) {
      // Свёрнутая вкладка не держит соединение: сервер не тратит сокет, а
      // телефон — радио. Ровно тот же приём, что у lib/tabHidden.ts для анимаций.
      hiddenAt = Date.now();
      disconnect();
      return;
    }
    attempt = 0;
    const now = Date.now();
    const wasHiddenLongEnough = hiddenAt !== null && now - hiddenAt >= RESUME_MIN_HIDDEN_MS;
    if (wasHiddenLongEnough && now - lastResumeAt >= RESUME_MIN_INTERVAL_MS) {
      lastResumeAt = now;
      invalidateSoon(ON_RESUME);
    }
    hiddenAt = null;
    void connect();
  };

  const onOnline = () => {
    attempt = 0;
    void connect();
  };

  const onOffline = () => {
    disconnect();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  void connect();

  const manager: Manager = {
    stop: () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = null;
      if (hotTimer) clearTimeout(hotTimer);
      hotTimer = null;
      disconnect();
      if (current === manager) current = null;
    },
  };
  current = manager;
  return manager;
}

/** Только для тестов и горячей перезагрузки: погасить текущий поток. */
export function stopLiveEvents(): void {
  current?.stop();
}
