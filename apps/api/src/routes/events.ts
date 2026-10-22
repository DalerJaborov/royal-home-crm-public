import { randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { LiveEvent, Role } from "@royal-home/shared";
import { requireAuth } from "../auth/middleware.js";
import { signAccessToken } from "../auth/jwt.js";
import {
  MAX_STREAMS_PER_AGENT,
  MAX_STREAMS_TOTAL,
  liveEventsEnabled,
  replayMissedEvents,
  streamStats,
  subscribe,
} from "../lib/eventBus.js";

/**
 * ПОТОК СОБЫТИЙ СЕРВЕР→БРАУЗЕР (Server-Sent Events, 12.09.2026).
 *
 * Одно соединение на вкладку вместо 56 таймеров опроса. Опрос на фронте
 * остаётся запасным путём — поток может не дойти (прокси режет, вкладка спала),
 * поэтому интервалы растянуты, а не удалены.
 *
 * ── ПОЧЕМУ БИЛЕТ, А НЕ ЗАГОЛОВОК ──────────────────────────────────────────
 * EventSource — единственный встроенный в браузер способ читать SSE, и он НЕ
 * умеет слать заголовки: Authorization: Bearer туда не положить. Варианты были
 * три: (1) токен в query — нет, JWT осел бы в логах nginx/Caddy и в истории
 * браузера; (2) cookie — refresh-кука HttpOnly примонтирована к /auth и на
 * поток не распространяется; (3) одноразовый короткоживущий билет.
 *
 * Взят третий. POST /events/ticket под обычным requireAuth выдаёт непрозрачную
 * случайную строку на 60 секунд и на ОДНО использование; GET /events?ticket=…
 * меняет её на внутренний токен и дальше идёт через ТОТ ЖЕ requireAuth — роль,
 * права, отключённая учётка и жёсткая блокировка окном проверяются ровно так
 * же, как на любом другом роуте. В URL при этом нет ничего личного: билет —
 * случайные байты, действительные минуту.
 *
 * Билеты живут в памяти процесса. Прод — один контейнер api (см.
 * docker-compose.prod.yml), так что этого достаточно; при масштабировании api
 * в несколько реплик билеты переедут в базу вместе с балансировкой sticky.
 */
export const eventsRouter = Router();

const TICKET_TTL_MS = 60_000;
/** Потолок на процесс: билет весит десятки байт, но плодить их без предела незачем. */
const MAX_TICKETS = 5_000;
/** Тик сердцебиения: комментарий `:ping` держит соединение живым сквозь прокси. */
const HEARTBEAT_MS = 25_000;

const tickets = new Map<string, { agentId: string; role: Role; expiresAt: number }>();

function sweepTickets(): void {
  const now = Date.now();
  for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key);
}

/** POST /api/v1/events/ticket — одноразовый пропуск в поток. */
eventsRouter.post("/ticket", requireAuth, (req: Request, res: Response) => {
  if (!liveEventsEnabled()) {
    res.status(503).json({ error: "Живые события выключены" });
    return;
  }
  sweepTickets();
  if (tickets.size >= MAX_TICKETS) {
    res.status(503).json({ error: "Слишком много запросов на поток, повторите позже" });
    return;
  }
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { agentId: req.agent!.id, role: req.agent!.role, expiresAt: Date.now() + TICKET_TTL_MS });
  res.json({ ticket, expiresInMs: TICKET_TTL_MS });
});

/**
 * Билет → внутренний токен → обычный requireAuth.
 *
 * Билет гасится сразу при предъявлении (одноразовость): перехваченная из логов
 * ссылка бесполезна, даже если попала туда в течение минуты.
 */
const streamQuerySchema = z.object({
  ticket: z.string().min(1).max(256).optional(),
  /** Последнее увиденное событие: после обрыва догоняем пропущенное из LiveEventOutbox (TTL 5 мин). */
  lastEventId: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

function authorizeStream<P>(req: Request<P>, res: Response, next: NextFunction): void {
  const parsed = streamQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные параметры потока" });
    return;
  }
  const ticket = parsed.data.ticket;
  if (ticket && !req.headers.authorization) {
    sweepTickets();
    const found = tickets.get(ticket);
    tickets.delete(ticket); // одноразовый в любом случае — годный он или просроченный
    if (!found || found.expiresAt <= Date.now()) {
      res.status(401).json({ error: "Пропуск в поток истёк" });
      return;
    }
    // Внутренний токен НЕ покидает процесс: он существует только чтобы
    // requireAuth отработал ровно так же, как на любом другом роуте. Роль в нём
    // ни на что не влияет — requireAuth всё равно читает её из базы.
    req.headers.authorization = `Bearer ${signAccessToken({ sub: found.agentId, role: found.role })}`;
  }
  void requireAuth(req, res, next);
}

/** GET /api/v1/events — поток. */
eventsRouter.get("/", authorizeStream, (req: Request, res: Response) => {
  if (!liveEventsEnabled()) {
    res.status(503).json({ error: "Живые события выключены" });
    return;
  }

  const agentId = req.agent!.id;
  const role = req.agent!.role;
  // Точечная надбавка messages.view (находка 24.09.2026, №245/К2-3): считаем из
  // ФАКТИЧЕСКИХ прав сотрудника, а не из пресета роли — см. Subscriber.seesAllMessages
  // и MESSAGES_VIEW_ADDRESSING_MARK в lib/eventBus.ts.
  const seesAllMessages = req.agent!.can("messages.view");

  // Пределы. Без них одна зациклившаяся вкладка (или чужой скрипт с валидным
  // токеном) держала бы сколько угодно сокетов — процесс съеден без единой
  // ошибки в журнале.
  const stats = streamStats(agentId);
  if (stats.forAgent >= MAX_STREAMS_PER_AGENT) {
    res.status(429).json({ error: "Слишком много открытых потоков", limit: MAX_STREAMS_PER_AGENT });
    return;
  }
  if (stats.total >= MAX_STREAMS_TOTAL) {
    res.status(503).json({ error: "Поток временно недоступен" });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx в контейнере web буферизует ответы по умолчанию — без этого заголовка
  // события копятся в прокси и приезжают пачкой, то есть поток перестаёт быть
  // живым ровно в проде и остаётся живым на стенде.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // Первая строка-комментарий: выталкивает заголовки и добивает буфер прокси.
  res.write(`: поток открыт\n\n`);

  const send = (event: LiveEvent) => {
    if (res.writableEnded) return;
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  // Закрытие со стороны сервера при остановке (closeAllStreams, круг 3, №76).
  // Мало закончить ответ: соединение keep-alive остаётся открытым и дальше
  // держит server.close(), поэтому закрываем и сам сокет — после уже
  // поставленного в очередь конца потока, клиент видит его честно.
  // close объявлен ниже, но вызывается только после этой строки — замыкание его увидит.
  const closeForShutdown = () => {
    close();
    if (!req.socket.destroyed) req.socket.end();
  };
  const subscriber = { agentId, role, seesAllMessages, deliver: send, close: closeForShutdown };
  const release = subscribe(subscriber);
  // Переподключение с последним виденным id (query или заголовок Last-Event-ID).
  const lastHeader = Number(req.headers["last-event-id"]);
  const resumeFrom = (req.query.lastEventId !== undefined ? Number(req.query.lastEventId) : lastHeader);
  if (Number.isSafeInteger(resumeFrom) && resumeFrom > 0) void replayMissedEvents(subscriber, resumeFrom);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`: ping\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    release();
    if (!res.writableEnded) res.end();
  };

  // И "close" (клиент ушёл), и "error" (сокет оборвался): без второго подписка
  // переживала бы мёртвое соединение и упиралась в предел на сотрудника.
  req.on("close", close);
  req.on("error", close);
  res.on("close", close);

  // СОЕДИНЕНИЕ МОГЛО ОБОРВАТЬСЯ ДО ЭТОЙ СТРОКИ (19.09.2026).
  //
  // Между входом в обработчик и подпиской стоит await: authorizeStream зовёт
  // requireAuth, а тот при промахе кэша ходит в базу. Если клиент ушёл в эти
  // миллисекунды (телефон свернули, сеть моргнула), событие "close" уже
  // произошло — а "close" в Node одноразовое, и слушатель, повешенный после
  // него, не вызовется НИКОГДА. Подписка при этом уже сделана: слот занят
  // навсегда, heartbeat тикает в мёртвый сокет, а release() не позовёт никто.
  //
  // Три таких промаха — и сотрудник упирается в MAX_STREAMS_PER_AGENT, то есть
  // получает 429 на живые события до перезапуска процесса. Проверяем явно.
  if (req.destroyed || res.destroyed || res.writableEnded) close();
});
