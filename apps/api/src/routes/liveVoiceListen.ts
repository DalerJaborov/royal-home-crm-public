import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { clientPhoneFor, phoneSafeText } from "../lib/clientPhone.js";
import { int16ToBufferLE } from "../lib/telephony/pcmCodec.js";
import * as liveVoiceMonitor from "../lib/telephony/liveVoiceMonitor.js";
import type { ListenEvent, ListenSide } from "../lib/telephony/liveVoiceMonitor.js";
import { registerAuthenticatedStream } from "../lib/authenticatedStreams.js";

/**
 * ПРОСЛУШКА РОБОТА В РЕАЛЬНОМ ВРЕМЕНИ (09.10.2026).
 *
 *   GET /api/v1/live-voice/active       — идущие сейчас разговоры робота;
 *   GET /api/v1/live-voice/:id/listen   — поток событий (text/event-stream):
 *        ready      {id, channelId, startedAt, direction, sampleRate}
 *        backlog    {lines:[{role, text}]}  — что уже сказано до подключения
 *        transcript {role, text, ts}        — новый кусок расшифровки
 *        audio      {side, b64}             — PCM16 LE, 8 кГц, моно, ~100 мс на кусок
 *        end        {reason}                — разговор закончился, поток закрывается
 *
 * ПРАВО — то же, что у записи разговора робота (routes/settings.ts,
 * /live-voice/sessions/:id/recording): слушать клиентов может только тот, кому
 * это отдельно положено, а не любой сотрудник. Настройка бота слушать клиентов
 * не даёт. Остальным — 403.
 *
 * Авторизация — обычный заголовок Authorization (requireAuth), а не билет как у
 * общего потока /events: браузерный клиент здесь читает поток через fetch, а
 * заголовки fetch умеет.
 *
 * Горячий путь звонка эта точка не трогает: мост публикует в liveVoiceMonitor
 * синхронно и без ожиданий, а здесь кадры только складываются в буфер
 * соединения; кодирование и запись в сеть идут по таймеру раз в 100 мс.
 */
export const liveVoiceListenRouter = Router();

liveVoiceListenRouter.use(
  requireAuth,
  requirePermission("settings.manage"),
  requirePermission("calls.transcripts"),
  requirePermission("calls.hearRecording")
);

const idParams = z.object({ id: z.string().uuid() });

/** Раз в сколько отдавать накопленный звук (мс): меньше — больше мелких записей в сеть. */
export const AUDIO_FLUSH_MS = 100;
/** Ping, чтобы прокси не закрыл тихое соединение. */
const HEARTBEAT_MS = 15_000;
/** Предел звука в буфере соединения на сторону (сэмплов): ~2 с. Дальше — слушатель
 *  не успевает, лишнее выбрасывается, а не копится в памяти. */
const MAX_BUFFERED_SAMPLES = 16_000;

liveVoiceListenRouter.get("/active", (req: Request, res: Response) => {
  const seesPhone = req.agent!.can("clients.viewPhone");
  res.json({
    sessions: liveVoiceMonitor.listActive().map((s) => ({
      id: s.id,
      channelId: s.channelId,
      startedAt: new Date(s.startedAt).toISOString(),
      direction: s.direction,
      callerNumber: s.callerNumber ? clientPhoneFor(s.callerNumber, seesPhone) : null,
      listeners: s.listeners,
    })),
  });
});

/** Склеивает кадры одной стороны в один кусок base64 (PCM16 LE). Вынесено ради теста. */
export function encodePcmChunks(chunks: readonly Int16Array[]): string {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return int16ToBufferLE(all).toString("base64");
}

liveVoiceListenRouter.get("/:id/listen", (req: Request, res: Response) => {
  const parsed = idParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректный номер разговора" });
    return;
  }
  const key = parsed.data.id;
  const active = liveVoiceMonitor.getActive(key);
  if (!active) {
    res.status(404).json({ error: "Этот разговор уже закончился" });
    return;
  }
  const seesPhone = req.agent!.can("clients.viewPhone");

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx в контейнере web буферизует ответы — без заголовка звук приезжал бы пачками.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Звук складывается по сторонам и уходит раз в AUDIO_FLUSH_MS.
  const buffers: Record<ListenSide, Int16Array[]> = { client: [], bot: [] };
  const buffered: Record<ListenSide, number> = { client: 0, bot: 0 };
  const flushAudio = () => {
    for (const side of ["client", "bot"] as const) {
      if (buffers[side].length === 0) continue;
      const chunks = buffers[side];
      buffers[side] = [];
      buffered[side] = 0;
      // Медленный получатель (сеть не успевает): звук выбрасываем — живой разговор
      // важнее, чем догонять отставшего, а память не должна расти.
      if (res.writableNeedDrain) continue;
      send("audio", { side, b64: encodePcmChunks(chunks) });
    }
  };

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let unregisterStream: (() => void) | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (flushTimer) clearInterval(flushTimer);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    unregisterStream?.();
    if (!res.writableEnded) res.end();
  };

  // Обработчик вызывается прямо из потока моста: только копить, ничего тяжёлого.
  const onEvent = (event: ListenEvent) => {
    if (closed) return;
    if (event.kind === "audio") {
      if (buffered[event.side] >= MAX_BUFFERED_SAMPLES) return;
      buffers[event.side].push(event.pcm);
      buffered[event.side] += event.pcm.length;
    } else if (event.kind === "transcript") {
      send("transcript", { role: event.role, text: phoneSafeText(event.text, seesPhone), ts: event.ts });
    } else {
      flushAudio();
      send("end", { reason: event.reason });
      close();
    }
  };

  // Подписка и чтение накопленного — в одном синхронном куске: между ними не
  // может вклиниться реплика ни потерянной, ни показанной дважды.
  unsubscribe = liveVoiceMonitor.subscribe(key, onEvent);
  if (!unsubscribe) {
    res.write(": нет места\n\n");
    send("end", { reason: "listeners_limit" });
    close();
    return;
  }
  unregisterStream = registerAuthenticatedStream(req.agent!.id, close);
  const backlog = liveVoiceMonitor.getBacklog(key);

  send("ready", {
    id: active.id,
    channelId: active.channelId,
    startedAt: new Date(active.startedAt).toISOString(),
    direction: active.direction,
    sampleRate: 8000,
  });
  send("backlog", { lines: backlog.map((l) => ({ role: l.role, text: phoneSafeText(l.text, seesPhone) })) });

  flushTimer = setInterval(flushAudio, AUDIO_FLUSH_MS);
  flushTimer.unref?.();
  heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // Кто и когда слушал клиентов — след в журнале (запись разговора — тоже голос клиента).
  logAudit(req, "LIVE_VOICE_LISTEN", "LiveVoiceSession", key);

  req.on("close", close);
  req.on("error", close);
  res.on("close", close);
  if (req.destroyed || res.destroyed) close();
});
