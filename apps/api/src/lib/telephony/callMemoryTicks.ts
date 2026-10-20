import { reportCronTickError, scheduleTracked } from "../cronHeartbeat.js";
import { closeSettledCallbackRequests } from "../callbackRequests.js";
import { loadBotCapabilities } from "../../messengers/botCapabilities.js";
import { checkStuckCallStubs } from "./callTracker.js";
import { autoConnectDueCallback } from "./callbackConnect.js";

/**
 * ТИКИ, КОТОРЫМ НУЖНА КАРТА ЖИВЫХ ЗВОНКОВ — В ПРОЦЕССЕ API (E2, E3 глубокой
 * проверки 02.10.2026).
 *
 * Карта `calls` (callTracker.ts) живёт в памяти HTTP-процесса: туда приходят
 * события станции. Оба тика ниже жили в cron.ts, то есть в контейнере worker,
 * где эта карта всегда пуста:
 *
 * - `callback-connect` звал `trackCall` в памяти worker. Событий станции там
 *   нет — у обратного звонка не появлялось ни итога, ни записи, а сам звонок
 *   висел в карте worker до выката, и каждый следующий автопрозвон этому
 *   оператору отвечал «оператор занят». За жизнь worker — не больше одного
 *   автозвонка на оператора.
 * - `stuck-call-stubs` не пропускал живой канал («живой — не зависший», 24.09):
 *   проверка смотрела в пустую карту, и разговор длиннее 20 минут помечался
 *   «Звонок потерян» с пушем руководителям поверх идущего разговора.
 *
 * Тот же приём, что у робозвонков (liveVoiceScenarioTicks.ts) и live-calls-sweep:
 * запуск из index.ts, расписание продублировано в lib/apiProcessTicks.ts — по
 * нему сторож пульса в worker знает, что эти тики надо ждать. Выражение здесь
 * написано строкой, чтобы карта продукта (scripts/product-map.mjs) их видела;
 * совпадение со списком проверяет tests/call-memory-ticks-process.test.ts.
 */
export const CALL_MEMORY_TICKS = ["stuck-call-stubs", "callback-connect"] as const;

export function startCallMemoryTicks(): void {
  /**
   * ЗАВИСШИЕ ЗАГОТОВКИ ЗВОНКОВ — каждые 5 минут (18.08.2026).
   * См. checkStuckCallStubs: если событие АТС «канал закончен» потерялось, заготовка
   * звонка в хронологии клиента так и остаётся пустой навсегда без единого сигнала.
   * Джоб находит такие заготовки старше 20 минут и один раз предупреждает — дальше
   * помечает их, чтобы не сигналить повторно.
   */
  let isStuckCallCheckRunning = false;
  scheduleTracked("stuck-call-stubs", "*/5 * * * *", async () => {
    if (isStuckCallCheckRunning) return;
    isStuckCallCheckRunning = true;
    try {
      const found = await checkStuckCallStubs();
      if (found > 0) console.log(`[cron] Зависших заготовок звонка найдено: ${found}`);
    } catch (err) {
      reportCronTickError("Ошибка проверки зависших звонков", err);
    } finally {
      isStuckCallCheckRunning = false;
    }
  });

  /**
   * Обратные звонки: раз в 10 минут соединяем самый старый незакрытый запрос с
   * дежурным оператором. Смысл тика — УТРО: ночные «позвоните мне» бот честно
   * откладывал («занг мезанем дар вақти корӣ»), и с началом рабочего дня очередь
   * разбирается сама, по одному звонку за тик (оператор один, пачка originate
   * дала бы ему очередь из гудков). Вне рабочего времени тик выходит бесплатным:
   * первый же guard в connectCallbackToOperator возвращает off_hours.
   */
  scheduleTracked(
    "callback-connect",
    "*/10 * * * *",
    async () => {
      // Сначала гасим то, что уже решено само собой (агент позвонил обычным путём;
      // просьба протухла) — иначе автопрозвон возьмётся за просьбу, по которой
      // разговор уже состоялся.
      /**
       * Дежурного оператора нет — тика нет вовсе (владелец 23.08.2026). При
       * выключенном рубильнике просьбы о звонке идут обычными заявками к агентам,
       * новых записей не появляется, и разбирать нечего.
       */
      const capabilities = await loadBotCapabilities().catch(() => null);
      if (!capabilities?.callback) return;
      try {
        const { byCall, expired } = await closeSettledCallbackRequests();
        if (byCall || expired) {
          console.log(`[cron] Просьбы о звонке закрыты сами: по факту звонка ${byCall}, протухших ${expired}`);
        }
      } catch (err) {
        reportCronTickError("Обратный звонок: сбой самозакрытия просьб", err);
      }
      try {
        const outcome = await autoConnectDueCallback();
        if (outcome === "connected") console.log("[cron] Обратный звонок: клиент соединён с дежурным оператором");
      } catch (err) {
        reportCronTickError("Обратный звонок: сбой автопрозвона", err);
      }
    },
    { timezone: "Asia/Dushanbe" }
  );
}
