import { API_PROCESS_TICKS } from "../apiProcessTicks.js";
import { reportCronTickError, scheduleTracked } from "../cronHeartbeat.js";
import { runInterviewInviteCallTick } from "../interviewInviteCall.js";
import { runPostShowingCallTick } from "../postShowingCall.js";
import { runSellerProbeCallTick } from "../sellerProbeCall.js";
import { sweepLiveVoiceStationLeftovers } from "./liveVoiceBridge.js";

/**
 * ИСХОДЯЩИЕ ЗВОНКИ РОБОТА — В ТОМ ЖЕ ПРОЦЕССЕ, ГДЕ ЖИВЁТ ЕГО ГОЛОС (28.09.2026).
 *
 * Все три тика жили в cron.ts, то есть в контейнере worker. А мост живого голоса
 * (startLiveVoiceListener) слушает станцию в HTTP-процессе — index.ts, рядом с
 * остальной телефонией (аудит №4, 27.08). originateLiveVoiceScenarioCall кладёт
 * задание разговора (промпт, голос, что делать с итогом) в память СВОЕГО
 * процесса, pendingOutboundCalls, и ждёт StasisStart. Событие приходило в api,
 * там задания не было, и канал отбрасывался как чужой. Робот не звонил ни разу:
 * владелец поставил кандидату (себе) собеседование, получил «Собеседование
 * назначено» — и тишину. Та же дыра у опроса после показа и у проверки продавца;
 * их не замечали, потому что оба выключены рубильниками.
 *
 * Поэтому тики, которые НАБИРАЮТ НОМЕР живым голосом, запускаются отсюда, из
 * index.ts, безусловно — ровно как live-calls-sweep. В worker их больше нет:
 * двойного набора не бывает. Тест apps/api/tests/live-voice-ticks-process.test.ts
 * не даёт вернуть такой тик в cron.ts.
 *
 * Расписание — из lib/apiProcessTicks.ts: по тому же списку сторож пульса в
 * worker знает, что эти тики ждать (№171 ночной проверки 24.09).
 *
 * Гварды у каждого свои по прежней причине: на запись идёт живой звонок, и без
 * гварда следующий тик набрал бы того же человека второй раз.
 */
export const LIVE_VOICE_SCENARIO_TICKS = [
  "seller-probe-call",
  "post-showing-call",
  "interview-invite-call",
  "live-voice-orphan-sweep",
] as const;

export function startLiveVoiceScenarioTicks(): void {
  /**
   * ПРОВЕРКА СО СТОРОНЫ ПРОДАВЦА (порог 5 воронки) — РАЗ В ЧАС: до звонка
   * собственнику доходят единицы в месяц. Проход считает досье (иногда с
   * моделью) и потом звонит — он заведомо длиннее пятиминутного тика опроса.
   */
  let isSellerProbeRunning = false;
  scheduleTracked("seller-probe-call", API_PROCESS_TICKS["seller-probe-call"], async () => {
    if (isSellerProbeRunning) return;
    isSellerProbeRunning = true;
    try {
      const started = await runSellerProbeCallTick();
      if (started) console.log(`[cron] Звонков собственникам по проверке обхода начато: ${started}`);
    } catch (err) {
      reportCronTickError("Ошибка проверки со стороны продавца", err);
    } finally {
      isSellerProbeRunning = false;
    }
  });

  /** РОБОЗВОНОК ПОКУПАТЕЛЮ ПОСЛЕ ПОКАЗА (16.09.2026). Дешёвый, пока выключен
   *  рубильник: runPostShowingCallTick первым делом читает Settings и выходит. */
  let isPostShowingCallRunning = false;
  scheduleTracked("post-showing-call", API_PROCESS_TICKS["post-showing-call"], async () => {
    if (isPostShowingCallRunning) return;
    isPostShowingCallRunning = true;
    try {
      const started = await runPostShowingCallTick();
      if (started) console.log(`[cron] Робозвонков покупателям после показа начато: ${started}`);
    } catch (err) {
      reportCronTickError("Ошибка робозвонков после показа", err);
    } finally {
      isPostShowingCallRunning = false;
    }
  });

  /**
   * УБОРЩИК СТАНЦИИ (02.10.2026, аудит В2): мост и канал звука, оставшиеся на
   * станции после сбоя отбоя (живая находка: UnicastRTP висел 101 час). Память
   * мостов и сессий — этого процесса, поэтому тик здесь же, а не в worker.
   */
  let isOrphanSweepRunning = false;
  scheduleTracked("live-voice-orphan-sweep", "*/10 * * * *", async () => {
    if (isOrphanSweepRunning) return;
    isOrphanSweepRunning = true;
    try {
      const swept = await sweepLiveVoiceStationLeftovers();
      if (swept.channelsHungUp || swept.bridgesDeleted) {
        console.log(`[cron] Живой голос: снято сирот со станции — каналов ${swept.channelsHungUp}, мостов ${swept.bridgesDeleted}`);
      }
    } catch (err) {
      reportCronTickError("Ошибка уборщика станции живого голоса", err);
    } finally {
      isOrphanSweepRunning = false;
    }
  });

  /** РОБОТ ПРИГЛАШАЕТ КАНДИДАТА НА СОБЕСЕДОВАНИЕ (25.09.2026). */
  let isInterviewInviteRunning = false;
  scheduleTracked("interview-invite-call", API_PROCESS_TICKS["interview-invite-call"], async () => {
    if (isInterviewInviteRunning) return;
    isInterviewInviteRunning = true;
    try {
      const started = await runInterviewInviteCallTick();
      if (started) console.log(`[cron] Звонков кандидатам с приглашением начато: ${started}`);
    } catch (err) {
      reportCronTickError("Ошибка звонков кандидатам с приглашением", err);
    } finally {
      isInterviewInviteRunning = false;
    }
  });
}
