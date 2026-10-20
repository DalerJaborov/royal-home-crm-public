import type WebSocket from "ws";

/**
 * Вынесен из ariEvents.ts (24.09.2026): им пользуются обе подписки на события
 * станции — основная (ariEvents.ts) и живого голоса (liveVoiceBridge.ts), — и
 * импорт живого голоса из ariEvents.ts замыкал цикл
 * ariEvents → deskTransfer → liveCallTransfer → liveVoiceBridge → ariEvents.
 */

/**
 * Сторож соединения: свой ping раз в PING_INTERVAL_MS и terminate(), если на
 * предыдущий не пришёл pong.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ close/error. Обратный SSH-туннель умеет умирать так, что ни
 * close, ни error не приходят вовсе: TCP остаётся полуоткрытым (роутер офиса
 * перезагрузился, старое соединение на стороне VPS осталось «живым»), события
 * молча перестают приходить, а CRM продолжает считать подписку открытой.
 *
 * ws.terminate(), А НЕ ws.close(): close начинает штатное рукопожатие закрытия,
 * которое на полуоткрытом TCP не завершится никогда — ждёт таймаут ОС в десятки
 * минут. terminate рвёт сокет немедленно и синхронно эмитит close, дальше
 * работает обычный путь переподписки. Худший случай обнаружения — 2×PING_INTERVAL_MS.
 *
 * Вынесен чистой функцией — проверяется тестом на фейковом сокете, без сети.
 */
export function startPingWatchdog(
  ws: Pick<WebSocket, "ping" | "terminate">,
  intervalMs: number
): { markAlive(): void; stop(): void } {
  let alive = true;
  const timer = setInterval(() => {
    if (!alive) {
      // В журнал отсюда НЕ пишем: terminate() синхронно эмитит close, и решение
      // «пора будить человека» принимает один сторож связи (createAriAlarm) — по
      // длительности потери. Иначе каждый моргнувший туннель давал бы в журнале
      // две мёртвые записи вместо ноля.
      console.warn(
        `[телефония] ${new Date().toISOString()} нет pong от АТС — принудительно разрываем соединение`
      );
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, intervalMs);
  timer.unref?.();
  return {
    markAlive() {
      alive = true;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
